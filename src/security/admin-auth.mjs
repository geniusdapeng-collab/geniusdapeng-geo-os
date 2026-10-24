import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { ApiError } from "../domain/errors.mjs";

const deriveKey = promisify(scrypt);
// OWASP's 64 MiB scrypt configuration, with bounded concurrent derivations below.
const SCRYPT = Object.freeze({ N: 65_536, r: 8, p: 2, maxmem: 96 * 1024 * 1024 });
const PASSWORD_PREFIX = `scrypt-sha256$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}`;
const PASSWORD_PATTERN = /^scrypt-sha256\$65536\$8\$2\$([a-f0-9]{32})\$([a-f0-9]{128})$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"];
const SAFE_METHODS = new Set(["GET", "HEAD"]);

function hashToken(token) {
  return createHash("sha256").update(token).digest();
}

function validPassword(password, minimum = 1) {
  return typeof password === "string" &&
    Array.from(password).length >= minimum && Buffer.byteLength(password, "utf8") <= 1024;
}

function parsePasswordHash(encoded) {
  const match = typeof encoded === "string" ? encoded.match(PASSWORD_PATTERN) : null;
  if (!match) {
    throw new Error("ADMIN_PASSWORD_HASH 格式无效；请使用内置 hash-password 命令生成。");
  }
  return { salt: Buffer.from(match[1], "hex"), key: Buffer.from(match[2], "hex") };
}

export async function hashAdminPassword(password) {
  if (!validPassword(password, 12)) {
    throw new Error("管理员密码至少需要 12 个字符，UTF-8 编码不能超过 1024 字节。");
  }
  const salt = randomBytes(16);
  // Pre-hashing preserves exact trailing NUL bytes that HMAC key padding would equate.
  const key = await deriveKey(hashToken(password), salt, 64, SCRYPT);
  return `${PASSWORD_PREFIX}$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyAdminPassword(password, encoded) {
  const { salt, key } = parsePasswordHash(encoded);
  if (!validPassword(password)) return false;
  const derived = await deriveKey(hashToken(password), salt, key.length, SCRYPT);
  return timingSafeEqual(derived, key);
}

export function hashAgentToken(token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(token)) {
    throw new Error("Agent token 必须使用至少 32 随机字节生成的 base64url 字符串。");
  }
  return `sha256$${hashToken(token).toString("hex")}`;
}

function parseOrigin(value) {
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PUBLIC_ORIGIN 必须是有效的 HTTPS origin。");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new Error("PUBLIC_ORIGIN 只允许协议、主机和可选端口，不允许路径或凭据。");
  }
  return url;
}

function boundedInteger(value, fallback, minimum, maximum, field) {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${field} 必须是 ${minimum} 到 ${maximum} 之间的整数。`);
  }
  return number;
}

function sourceError(message) {
  return new ApiError(403, "CROSS_ORIGIN_REQUEST_BLOCKED", message);
}

function readCookie(request, name) {
  const header = request.headers?.cookie;
  if (typeof header !== "string" || header.length > 8192) return null;
  const matches = header.split(";").map((item) => item.trim())
    .filter((item) => item.slice(0, item.indexOf("=")) === name);
  if (matches.length !== 1) return null;
  const value = matches[0].slice(name.length + 1);
  return TOKEN_PATTERN.test(value) ? value : null;
}

function agentMayAccess(method, pathname) {
  if (method === "GET") {
    return ["/api/bootstrap", "/api/summary", "/api/events", "/api/content",
      "/api/interactions", "/api/operations"].includes(pathname);
  }
  return method === "POST" && (
    pathname === "/api/interactions" ||
    /^\/api\/operations\/[A-Za-z0-9_-]+\/(start|complete|fail)$/.test(pathname)
  );
}

export function createAdminAuth({
  env = process.env,
  host = env.HOST || "127.0.0.1",
  allowedHosts,
  clock = () => Date.now(),
} = {}) {
  const passwordHash = env.ADMIN_PASSWORD_HASH || "";
  const agentHash = env.ADMIN_AGENT_TOKEN_HASH || "";
  const publicOrigin = parseOrigin(env.PUBLIC_ORIGIN);
  const hosts = allowedHosts ?? (env.ALLOWED_HOSTS?.split(",").map((value) => value.trim()).filter(Boolean)) ??
    [...LOOPBACK_HOSTS, ...(publicOrigin ? [publicOrigin.hostname] : [])];
  const configuredHosts = new Set(hosts.map((value) => String(value).toLowerCase()));
  const deployment = env.NODE_ENV === "production" || !LOOPBACK_HOSTS.includes(host) ||
    [...configuredHosts].some((value) => !LOOPBACK_HOSTS.includes(value)) || Boolean(publicOrigin);
  if (deployment && !passwordHash) {
    throw new Error("公网/生产部署必须配置 ADMIN_PASSWORD_HASH，拒绝以无认证模式启动。");
  }
  if (deployment && (!publicOrigin || publicOrigin.protocol !== "https:")) {
    throw new Error("公网/生产部署必须配置 HTTPS PUBLIC_ORIGIN。");
  }
  if (publicOrigin && !configuredHosts.has(publicOrigin.hostname.toLowerCase())) {
    throw new Error("PUBLIC_ORIGIN 主机必须包含在 ALLOWED_HOSTS 中。");
  }
  if (agentHash && (!passwordHash || !/^sha256\$[a-f0-9]{64}$/.test(agentHash))) {
    throw new Error("ADMIN_AGENT_TOKEN_HASH 需要已启用管理员认证，并采用 sha256$加64位十六进制格式。");
  }
  if (passwordHash) parsePasswordHash(passwordHash);
  const agentDigest = agentHash ? Buffer.from(agentHash.slice(7), "hex") : null;
  const ttlSeconds = boundedInteger(env.ADMIN_SESSION_TTL_SECONDS, 28_800, 60, 604_800, "ADMIN_SESSION_TTL_SECONDS");
  const failureLimit = boundedInteger(env.ADMIN_LOGIN_ATTEMPTS, 5, 1, 20, "ADMIN_LOGIN_ATTEMPTS");
  const windowSeconds = boundedInteger(env.ADMIN_LOGIN_WINDOW_SECONDS, 900, 1, 3600, "ADMIN_LOGIN_WINDOW_SECONDS");
  const secure = publicOrigin?.protocol === "https:";
  const cookieName = secure ? "__Host-pengmanager_session" : "pengmanager_session";
  const sessions = new Map();
  const attempts = new Map();
  let globalAttempts = { count: 0, expiresAt: 0 };
  let pendingLogins = 0;

  function now() {
    const value = Number(clock());
    if (!Number.isFinite(value)) throw new Error("认证时钟返回了无效时间。");
    return value;
  }

  function prune(at) {
    for (const [key, session] of sessions) if (session.expiresAt <= at) sessions.delete(key);
    for (const [key, bucket] of attempts) if (bucket.expiresAt <= at) attempts.delete(key);
    if (globalAttempts.expiresAt <= at) globalAttempts = { count: 0, expiresAt: at + windowSeconds * 1000 };
  }

  function cookie(value, maxAge) {
    return `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
  }

  function validateRequestSource(request, requestAllowedHosts = hosts) {
    const header = request.headers?.host;
    if (typeof header !== "string" || !header || /[\s\\/@?#,]/.test(header)) {
      throw new ApiError(400, "HOST_INVALID", "请求 Host 头无效。");
    }
    let url;
    try {
      url = new URL(`http://${header}`);
    } catch {
      throw new ApiError(400, "HOST_INVALID", "请求 Host 头无效。");
    }
    const allowed = new Set(requestAllowedHosts.map((value) => String(value).toLowerCase()));
    if (!allowed.has(url.hostname.toLowerCase()) || (publicOrigin && url.host !== publicOrigin.host)) {
      throw new ApiError(403, "HOST_NOT_ALLOWED", "请求主机未被显式允许。");
    }
    const method = String(request.method || "GET").toUpperCase();
    const pathname = new URL(request.url || "/", "http://localhost").pathname;
    const isPageNavigation = SAFE_METHODS.has(method) && !pathname.startsWith("/api/");
    if (String(request.headers["sec-fetch-site"] || "").toLowerCase() === "cross-site" && !isPageNavigation) {
      throw sourceError("拒绝跨站 API 请求。");
    }
    const origin = request.headers.origin;
    if (origin) {
      let originUrl;
      try {
        originUrl = new URL(origin);
      } catch {
        throw sourceError("请求 Origin 无效。");
      }
      const expectedOrigin = publicOrigin?.origin || `${request.socket?.encrypted ? "https" : "http"}://${url.host}`;
      if (originUrl.origin !== expectedOrigin || originUrl.href !== `${originUrl.origin}/`) {
        throw sourceError("请求 Origin 与本站不一致。");
      }
    }
  }

  function sessionPrincipal(request) {
    const at = now();
    prune(at);
    const token = readCookie(request, cookieName);
    if (!token) return null;
    const session = sessions.get(hashToken(token).toString("hex"));
    return session ? { actor: "PengManager", method: "session", expiresAt: new Date(session.expiresAt).toISOString() } : null;
  }

  function agentPrincipal(request, pathname) {
    const authorization = request.headers?.authorization;
    if (!authorization) return null;
    if (typeof authorization !== "string" || !/^Bearer [A-Za-z0-9_-]{43,128}$/.test(authorization)) {
      throw new ApiError(401, "AUTH_REQUIRED", "请先登录。");
    }
    const digest = hashToken(authorization.slice(7));
    if (!agentDigest || !timingSafeEqual(digest, agentDigest)) {
      throw new ApiError(401, "AUTH_REQUIRED", "请先登录。");
    }
    if (!agentMayAccess(request.method, pathname)) {
      throw new ApiError(403, "AGENT_SCOPE_DENIED", "Agent token 无权操作此接口。");
    }
    return { actor: "PengManager Agent", method: "agent" };
  }

  return Object.freeze({
    enabled: Boolean(passwordHash),
    cookieName,
    validateRequestSource,
    status(request) {
      validateRequestSource(request);
      const principal = passwordHash ? sessionPrincipal(request) : { actor: "PengManager", method: "local" };
      return { enabled: Boolean(passwordHash), authenticated: Boolean(principal), ...principal };
    },
    requireAccess(request, pathname = new URL(request.url || "/", "http://localhost").pathname) {
      validateRequestSource(request);
      if (!passwordHash) return { actor: "PengManager", method: "local" };
      // An explicit bearer credential never silently escalates through a browser cookie.
      const principal = request.headers?.authorization ? agentPrincipal(request, pathname) : sessionPrincipal(request);
      if (!principal) throw new ApiError(401, "AUTH_REQUIRED", "请先登录。");
      return principal;
    },
    async login(request, password) {
      validateRequestSource(request);
      if (!passwordHash) throw new ApiError(409, "AUTH_NOT_ENABLED", "本地模式未启用管理员登录。");
      const at = now();
      prune(at);
      // Never trust a caller supplied X-Forwarded-For for rate limiting.
      const key = hashToken(String(request.socket?.remoteAddress || "unknown")).toString("hex");
      const bucket = attempts.get(key) || { count: 0, expiresAt: at + windowSeconds * 1000 };
      if (bucket.count >= failureLimit || globalAttempts.count >= 60 ||
          (attempts.size >= 1000 && !attempts.has(key)) || pendingLogins >= 2) {
        throw new ApiError(429, "LOGIN_RATE_LIMITED", "登录尝试过多，请稍后再试。", {
          retryAfterSeconds: Math.max(1, Math.ceil((bucket.expiresAt - at) / 1000)),
        });
      }
      // Reserve attempts before the asynchronous KDF, including malformed input.
      bucket.count += 1;
      globalAttempts.count += 1;
      attempts.set(key, bucket);
      pendingLogins += 1;
      let verified;
      try {
        verified = await verifyAdminPassword(password, passwordHash);
      } catch {
        throw new ApiError(503, "AUTH_UNAVAILABLE", "登录验证暂时不可用，请稍后再试。");
      } finally {
        pendingLogins -= 1;
      }
      if (!verified) throw new ApiError(401, "INVALID_CREDENTIALS", "密码不正确。");
      attempts.delete(key);
      const token = randomBytes(32).toString("base64url");
      const expiresAt = now() + ttlSeconds * 1000;
      // Rotate the current browser session and cap active sessions for a single owner.
      const previous = readCookie(request, cookieName);
      if (previous) sessions.delete(hashToken(previous).toString("hex"));
      prune(now());
      if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
      sessions.set(hashToken(token).toString("hex"), { expiresAt });
      return { cookie: cookie(token, ttlSeconds), expiresAt: new Date(expiresAt).toISOString() };
    },
    logout(request) {
      validateRequestSource(request);
      const token = readCookie(request, cookieName);
      if (token) sessions.delete(hashToken(token).toString("hex"));
      return cookie("", 0);
    },
  });
}

async function runHashCommand() {
  const command = process.argv[2];
  if (!["hash-password", "hash-agent-token"].includes(command) || process.argv.length > 3 || process.stdin.isTTY) {
    throw new Error("用法：从密码管理器或隐藏输入提示读取秘密，再通过标准输入传给本脚本的 hash-password 或 hash-agent-token；禁止把秘密作为命令行参数。");
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 1026) throw new Error("输入超过允许长度。");
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  const encoded = command === "hash-password" ? await hashAdminPassword(input) : hashAgentToken(input);
  process.stdout.write(`${encoded}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runHashCommand().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

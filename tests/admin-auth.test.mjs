import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createAdminAuth, hashAdminPassword, hashAgentToken, verifyAdminPassword } from "../src/security/admin-auth.mjs";

// Every test secret is newly generated in this process and never persisted.
const password = randomBytes(24).toString("base64url");
const passwordHash = await hashAdminPassword(password);
const token = randomBytes(32).toString("base64url");
const cloudEnv = {
  NODE_ENV: "production",
  ADMIN_PASSWORD_HASH: passwordHash,
  PUBLIC_ORIGIN: "https://manager.example.com",
  ALLOWED_HOSTS: "manager.example.com",
};

function request({ url = "/api/bootstrap", method = "GET", headers = {}, ip = "127.0.0.1", cloud = true } = {}) {
  return {
    method, url,
    headers: { host: cloud ? "manager.example.com" : "127.0.0.1:4318", ...headers },
    socket: { remoteAddress: ip, encrypted: false },
  };
}

function cookieHeader(result) {
  return result.cookie.split(";")[0];
}

function hasCode(code, status) {
  return (error) => error.code === code && error.status === status;
}

test("password hashes use random salts and verify complete Unicode input", async () => {
  const unicodePassword = `${randomBytes(12).toString("hex")} 鹏经理🔐\0 `;
  const first = await hashAdminPassword(unicodePassword);
  const second = await hashAdminPassword(unicodePassword);
  assert.notEqual(first, second);
  assert.match(first, /^scrypt-sha256\$65536\$8\$2\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
  assert.equal(await verifyAdminPassword(unicodePassword, first), true);
  assert.equal(await verifyAdminPassword(unicodePassword.trim(), first), false);
  assert.equal(await verifyAdminPassword(unicodePassword.replace("\0", ""), first), false);
});

test("password verification rejects wrong first, last, and length variants", async () => {
  for (const candidate of [`!${password.slice(1)}`, `${password.slice(0, -1)}!`, `${password}!`, ""]) {
    assert.equal(await verifyAdminPassword(candidate, passwordHash), false);
  }
  for (const candidate of [null, {}, [], "x".repeat(1025)]) {
    assert.equal(await verifyAdminPassword(candidate, passwordHash), false);
  }
  for (const candidate of ["short", "鹏".repeat(342), null]) {
    await assert.rejects(hashAdminPassword(candidate), /12|1024/);
  }
});

test("malformed or weakened hash parameters fail closed before serving requests", () => {
  for (const hash of ["invalid", passwordHash.replace("65536", "16384"), `${passwordHash}x`]) {
    assert.throws(() => createAdminAuth({ env: { ...cloudEnv, ADMIN_PASSWORD_HASH: hash } }), /ADMIN_PASSWORD_HASH/);
  }
});

test("non-loopback, production, or public hostname configurations require credentials and HTTPS", () => {
  for (const options of [
    { env: {}, host: "0.0.0.0" },
    { env: { NODE_ENV: "production" } },
    { env: { ALLOWED_HOSTS: "manager.example.com" } },
    { env: { PUBLIC_ORIGIN: cloudEnv.PUBLIC_ORIGIN } },
  ]) assert.throws(() => createAdminAuth(options), /ADMIN_PASSWORD_HASH/);
  assert.throws(() => createAdminAuth({ env: { ...cloudEnv, PUBLIC_ORIGIN: "http://manager.example.com" } }), /HTTPS/);
  assert.throws(() => createAdminAuth({ env: { ADMIN_PASSWORD_HASH: passwordHash }, host: "0.0.0.0" }), /HTTPS/);
});

test("invalid origin and unsafe configuration values are rejected", () => {
  for (const origin of ["not-a-url", "https://user@manager.example.com", "https://manager.example.com/private", "https://manager.example.com/?x=1", "https://manager.example.com/#fragment"]) {
    assert.throws(() => createAdminAuth({ env: { ...cloudEnv, PUBLIC_ORIGIN: origin } }), /PUBLIC_ORIGIN/);
  }
  assert.throws(() => createAdminAuth({ env: { ...cloudEnv, ALLOWED_HOSTS: "another.example.com" } }), /ALLOWED_HOSTS/);
  for (const env of [
    { ADMIN_SESSION_TTL_SECONDS: "0" }, { ADMIN_SESSION_TTL_SECONDS: "604801" },
    { ADMIN_LOGIN_ATTEMPTS: "1.5" }, { ADMIN_LOGIN_WINDOW_SECONDS: "nan" },
    { ADMIN_AGENT_TOKEN_HASH: "plaintext" },
  ]) assert.throws(() => createAdminAuth({ env: { ...cloudEnv, ...env } }));
  assert.throws(() => createAdminAuth({ env: { ADMIN_AGENT_TOKEN_HASH: hashAgentToken(token) } }), /管理员认证/);
});

test("default loopback development stays compatible without a login", () => {
  const auth = createAdminAuth({ env: {} });
  const req = request({ cloud: false });
  assert.equal(auth.enabled, false);
  assert.deepEqual(auth.status(req), { enabled: false, authenticated: true, actor: "PengManager", method: "local" });
  assert.equal(auth.requireAccess(req).method, "local");
  assert.match(auth.logout(req), /Max-Age=0/);
});

test("cloud login returns a host-only secure cookie and no credential in public status", async () => {
  const auth = createAdminAuth({ env: cloudEnv });
  assert.equal(auth.status(request()).authenticated, false);
  assert.throws(() => auth.requireAccess(request()), hasCode("AUTH_REQUIRED", 401));
  const result = await auth.login(request({ method: "POST", headers: { origin: cloudEnv.PUBLIC_ORIGIN } }), password);
  assert.match(result.cookie, /^__Host-pengmanager_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=28800; Secure$/);
  assert.equal(result.cookie.includes("Domain="), false);
  const req = request({ headers: { cookie: cookieHeader(result) } });
  assert.equal(auth.requireAccess(req).method, "session");
  const status = auth.status(req);
  assert.equal(status.authenticated, true);
  for (const secret of [password, passwordHash, cookieHeader(result).split("=")[1]]) {
    assert.equal(JSON.stringify(status).includes(secret), false);
  }
});

test("local optional password authentication uses a local cookie", async () => {
  const auth = createAdminAuth({ env: { ADMIN_PASSWORD_HASH: passwordHash } });
  const req = request({ cloud: false, method: "POST" });
  const result = await auth.login(req, password);
  assert.match(result.cookie, /^pengmanager_session=/);
  assert.equal(result.cookie.includes("; Secure"), false);
});

test("sessions expire at the configured boundary and do not survive process-instance replacement", async () => {
  let time = Date.parse("2026-10-24T00:00:00.000Z");
  const env = { ...cloudEnv, ADMIN_SESSION_TTL_SECONDS: "60" };
  const auth = createAdminAuth({ env, clock: () => time });
  const result = await auth.login(request({ method: "POST" }), password);
  const req = request({ headers: { cookie: cookieHeader(result) } });
  time += 59_999;
  assert.equal(auth.status(req).authenticated, true);
  assert.equal(createAdminAuth({ env }).status(req).authenticated, false);
  time += 1;
  assert.equal(auth.status(req).authenticated, false);
  assert.throws(() => auth.requireAccess(req), hasCode("AUTH_REQUIRED", 401));
});

test("login rotates the current session and logout revokes the replacement", async () => {
  const auth = createAdminAuth({ env: cloudEnv });
  const first = await auth.login(request({ method: "POST" }), password);
  const oldReq = request({ method: "POST", headers: { cookie: cookieHeader(first) } });
  const second = await auth.login(oldReq, password);
  assert.notEqual(first.cookie, second.cookie);
  assert.equal(auth.status(oldReq).authenticated, false);
  const active = request({ method: "POST", headers: { cookie: cookieHeader(second) } });
  assert.equal(auth.status(active).authenticated, true);
  assert.match(auth.logout(active), /Max-Age=0; Secure$/);
  assert.equal(auth.status(active).authenticated, false);
  assert.match(auth.logout(active), /Max-Age=0/);
});

test("session credentials are accepted only through one exact cookie", async () => {
  const auth = createAdminAuth({ env: cloudEnv });
  const result = await auth.login(request({ method: "POST" }), password);
  const rawToken = cookieHeader(result).split("=")[1];
  for (const req of [
    request({ url: `/api/bootstrap?token=${rawToken}` }),
    request({ headers: { authorization: `Bearer ${rawToken}` } }),
    request({ headers: { cookie: `${cookieHeader(result)}; ${cookieHeader(result)}` } }),
    request({ headers: { cookie: `${auth.cookieName}=invalid` } }),
    request({ headers: { cookie: `${auth.cookieName}=${rawToken}x` } }),
    request({ headers: { cookie: `other=${rawToken}` } }),
    request({ headers: { cookie: `${cookieHeader(result)}; extra=${"x".repeat(8192)}` } }),
  ]) assert.throws(() => auth.requireAccess(req), hasCode("AUTH_REQUIRED", 401));
});

test("login attempts are reserved before KDF work and cannot use forwarded IPs to bypass limits", async () => {
  let time = Date.now();
  const auth = createAdminAuth({ env: { ...cloudEnv, ADMIN_LOGIN_ATTEMPTS: "2", ADMIN_LOGIN_WINDOW_SECONDS: "2" }, clock: () => time });
  for (let index = 0; index < 2; index += 1) {
    await assert.rejects(auth.login(request({ method: "POST", headers: { "x-forwarded-for": `10.0.0.${index}` } }), ""), hasCode("INVALID_CREDENTIALS", 401));
  }
  await assert.rejects(auth.login(request({ method: "POST" }), password), hasCode("LOGIN_RATE_LIMITED", 429));
  time += 2000;
  assert.equal(typeof (await auth.login(request({ method: "POST" }), password)).cookie, "string");
});

test("successful login clears the client failure count", async () => {
  const auth = createAdminAuth({ env: { ...cloudEnv, ADMIN_LOGIN_ATTEMPTS: "2" } });
  await assert.rejects(auth.login(request({ method: "POST" }), ""), hasCode("INVALID_CREDENTIALS", 401));
  await auth.login(request({ method: "POST" }), password);
  await assert.rejects(auth.login(request({ method: "POST" }), ""), hasCode("INVALID_CREDENTIALS", 401));
  await auth.login(request({ method: "POST" }), password);
});

test("global rate limit bounds rotating client addresses and resets after its window", async () => {
  let time = Date.now();
  const auth = createAdminAuth({ env: { ...cloudEnv, ADMIN_LOGIN_WINDOW_SECONDS: "1" }, clock: () => time });
  for (let index = 0; index < 60; index += 1) {
    await assert.rejects(auth.login(request({ method: "POST", ip: `10.0.0.${index}` }), null), hasCode("INVALID_CREDENTIALS", 401));
  }
  await assert.rejects(auth.login(request({ method: "POST", ip: "10.0.1.1" }), null), hasCode("LOGIN_RATE_LIMITED", 429));
  time += 1000;
  await assert.rejects(auth.login(request({ method: "POST", ip: "10.0.1.1" }), null), hasCode("INVALID_CREDENTIALS", 401));
});

test("only two expensive password derivations may run at once", async () => {
  const auth = createAdminAuth({ env: cloudEnv });
  const first = auth.login(request({ method: "POST", ip: "10.0.0.1" }), password);
  const second = auth.login(request({ method: "POST", ip: "10.0.0.2" }), password);
  await assert.rejects(auth.login(request({ method: "POST", ip: "10.0.0.3" }), password), hasCode("LOGIN_RATE_LIMITED", 429));
  const results = await Promise.all([first, second]);
  assert.equal(results.length, 2);
});

test("agent tokens are hashed and restricted to receipt/operation execution routes", () => {
  const auth = createAdminAuth({ env: { ...cloudEnv, ADMIN_AGENT_TOKEN_HASH: hashAgentToken(token) } });
  for (const [method, url] of [
    ["GET", "/api/bootstrap"], ["GET", "/api/summary"], ["GET", "/api/events"],
    ["GET", "/api/content"], ["GET", "/api/interactions"], ["GET", "/api/operations"],
    ["POST", "/api/interactions"],
    ["POST", "/api/operations/OP-123/start"], ["POST", "/api/operations/OP-123/complete"], ["POST", "/api/operations/OP-123/fail"],
  ]) {
    assert.equal(auth.requireAccess(request({ method, url, headers: { authorization: `Bearer ${token}` } })).method, "agent");
  }
  for (const [method, url] of [
    ["GET", "/"], ["POST", "/api/live/github/publish"], ["POST", "/api/claims/C001/approve"],
    ["POST", "/api/content"], ["POST", "/api/operations"], ["POST", "/api/operations/OP-123/approve"],
    ["POST", "/api/publications/manual"],
    ["GET", "/api/auth/status"], ["DELETE", "/api/operations/OP-123/complete"],
  ]) assert.throws(() => auth.requireAccess(request({ method, url, headers: { authorization: `Bearer ${token}` } })), hasCode("AGENT_SCOPE_DENIED", 403));
});

test("invalid bearer credentials cannot silently fall back to an administrator cookie", async () => {
  const auth = createAdminAuth({ env: { ...cloudEnv, ADMIN_AGENT_TOKEN_HASH: hashAgentToken(token) } });
  const session = await auth.login(request({ method: "POST" }), password);
  for (const authorization of [`Bearer ${randomBytes(32).toString("base64url")}`, "Basic invalid", `Bearer ${token}x`, `Bearer ${token.slice(1)}`]) {
    assert.throws(() => auth.requireAccess(request({ headers: { cookie: cookieHeader(session), authorization } })), hasCode("AUTH_REQUIRED", 401));
  }
  assert.throws(() => hashAgentToken("short"), /32/);
});

test("canonical cloud origin is validated independently of forwarded host/protocol headers", () => {
  const auth = createAdminAuth({ env: cloudEnv });
  auth.validateRequestSource(request({ headers: { origin: cloudEnv.PUBLIC_ORIGIN, "x-forwarded-proto": "http", "x-forwarded-host": "attacker.example" } }));
  for (const origin of ["https://attacker.example", "http://manager.example.com", "https://manager.example.com:8443", "null", "https://manager.example.com/path"]) {
    assert.throws(() => auth.validateRequestSource(request({ method: "POST", headers: { origin } })), hasCode("CROSS_ORIGIN_REQUEST_BLOCKED", 403));
  }
  for (const host of ["attacker.example", "manager.example.com:8443"]) {
    assert.throws(() => auth.validateRequestSource(request({ headers: { host, "x-forwarded-host": "manager.example.com" } })), hasCode("HOST_NOT_ALLOWED", 403));
  }
  for (const host of ["manager.example.com/path", "user@manager.example.com", "manager.example.com,attacker.example", " manager.example.com", ""]) {
    assert.throws(() => auth.validateRequestSource(request({ headers: { host } })), hasCode("HOST_INVALID", 400));
  }
});

test("cross-site page navigation reaches login shell while API access and writes remain blocked", () => {
  const auth = createAdminAuth({ env: cloudEnv });
  auth.validateRequestSource(request({ url: "/", headers: { "sec-fetch-site": "cross-site" } }));
  for (const options of [{ url: "/api/bootstrap" }, { url: "/api/auth/login", method: "POST" }, { url: "/", method: "POST" }]) {
    assert.throws(() => auth.validateRequestSource(request({ ...options, headers: { "sec-fetch-site": "cross-site" } })), hasCode("CROSS_ORIGIN_REQUEST_BLOCKED", 403));
  }
});

test("local origin validation rejects cross-scheme requests without trusting forwarded protocol", () => {
  const auth = createAdminAuth({ env: { ADMIN_PASSWORD_HASH: passwordHash } });
  auth.validateRequestSource(request({ cloud: false, headers: { origin: "http://127.0.0.1:4318" } }));
  assert.throws(() => auth.validateRequestSource(request({ cloud: false, method: "POST", headers: { origin: "https://127.0.0.1:4318", "x-forwarded-proto": "https" } })), hasCode("CROSS_ORIGIN_REQUEST_BLOCKED", 403));
});

test("hash-password CLI accepts stdin and writes only a verifiable salted hash", async () => {
  const cli = resolve(import.meta.dirname, "../src/security/admin-auth.mjs");
  const result = await new Promise((resolveProcess, reject) => {
    const child = spawn(process.execPath, [cli, "hash-password"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolveProcess({ code, stdout, stderr }));
    child.stdin.end(`${password}\n`);
  });
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.includes(password), false);
  assert.equal(await verifyAdminPassword(password, result.stdout.trim()), true);
});

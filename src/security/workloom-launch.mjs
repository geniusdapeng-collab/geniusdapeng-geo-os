import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { ApiError } from "../domain/errors.mjs";

const MAX_LAUNCH_SECONDS = 120;
const DEFAULT_LAUNCH_SECONDS = 60;

function parseOrigin(raw, production) {
  let url;
  try { url = new URL(raw); }
  catch { throw new Error("WORKLOOM_PM_ORIGIN 必须是有效 URL。"); }
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname.toLowerCase());
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || (url.protocol !== "https:" && !(url.protocol === "http:" && !production && loopback))) {
    throw new Error("WORKLOOM_PM_ORIGIN 只允许 HTTPS origin；开发环境可使用本机 HTTP。");
  }
  return url;
}

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`缺少 ${name}。`);
  return value;
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

/**
 * Issues a 60-second Ed25519 launch assertion for the WorkLoom assistant.
 * The private key remains in the PengManager service process. The code is
 * returned only in the authenticated response and is not logged or persisted.
 */
export function createWorkloomLaunch({ env = process.env, clock = () => Date.now() } = {}) {
  const production = env.NODE_ENV === "production";
  let config;
  let configurationError = null;
  try {
    const origin = parseOrigin(required(env, "WORKLOOM_PM_ORIGIN"), production);
    const privateKeyText = env.WORKLOOM_LAUNCH_PRIVATE_KEY?.trim()
      || (env.WORKLOOM_LAUNCH_PRIVATE_KEY_B64?.trim()
        ? Buffer.from(env.WORKLOOM_LAUNCH_PRIVATE_KEY_B64.trim(), "base64").toString("utf8")
        : "");
    if (!privateKeyText) throw new Error("缺少 WORKLOOM_LAUNCH_PRIVATE_KEY 或 WORKLOOM_LAUNCH_PRIVATE_KEY_B64。");
    const privateKey = createPrivateKey(privateKeyText);
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("WORKLOOM_LAUNCH_PRIVATE_KEY 必须是 Ed25519 私钥。");
    const tenantId = required(env, "WORKLOOM_LAUNCH_TENANT_ID");
    const workspaceId = required(env, "WORKLOOM_LAUNCH_WORKSPACE_ID");
    const memberNo = required(env, "WORKLOOM_LAUNCH_MEMBER_NO");
    if (tenantId.length > 160 || workspaceId.length > 160 || memberNo.length > 80) {
      throw new Error("WorkLoom 启动身份字段超过长度上限。");
    }
    const seconds = env.WORKLOOM_LAUNCH_TTL_SECONDS === undefined
      ? DEFAULT_LAUNCH_SECONDS : Number(env.WORKLOOM_LAUNCH_TTL_SECONDS);
    if (!Number.isSafeInteger(seconds) || seconds < 15 || seconds > MAX_LAUNCH_SECONDS) {
      throw new Error(`WORKLOOM_LAUNCH_TTL_SECONDS 必须是 15..${MAX_LAUNCH_SECONDS} 的整数。`);
    }
    config = { origin, privateKey, tenantId, workspaceId, memberNo, seconds };
  } catch (error) {
    configurationError = error instanceof Error ? error.message : "WorkLoom 启动配置无效。";
  }

  return Object.freeze({
    enabled: Boolean(config),
    configurationError,
    issue() {
      if (!config) {
        throw new ApiError(503, "WORKLOOM_LAUNCH_NOT_CONFIGURED", "AI 研发中心入口尚未完成配置。");
      }
      const nowSeconds = Math.floor(Number(clock()) / 1000);
      if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 1) {
        throw new ApiError(503, "WORKLOOM_LAUNCH_CLOCK_INVALID", "服务时钟不可用，拒绝签发登录入口。");
      }
      const claims = {
        iss: "pengmanager",
        aud: "workloom-pm",
        sub: "pengmanager-owner",
        jti: randomUUID(),
        iat: nowSeconds,
        nbf: nowSeconds - 1,
        exp: nowSeconds + config.seconds,
        tenantId: config.tenantId,
        workspaceId: config.workspaceId,
        memberNo: config.memberNo,
      };
      const encoded = base64url(JSON.stringify(claims));
      const signature = sign(null, Buffer.from(encoded, "utf8"), config.privateKey).toString("base64url");
      const code = `${encoded}.${signature}`;
      return {
        launchUrl: `${config.origin.origin}/assistant#__launch=${encodeURIComponent(code)}`,
        expiresAt: new Date((nowSeconds + config.seconds) * 1000).toISOString(),
      };
    },
  });
}

import { isIP } from "node:net";
import { ApiError } from "./errors.mjs";

const CREDENTIAL_PARAMETER = /token|password|secret|cookie|authorization|api[_-]?key|session|signature|credential/i;

function credentialFragment(hash) {
  let decoded = hash.slice(1);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch { break; }
  }
  return [...decoded.matchAll(/\b([A-Za-z0-9_-]+)\s*[:=]/g)]
    .some((match) => CREDENTIAL_PARAMETER.test(match[1]));
}

// This checks safe URL syntax only; the executor must actually read the platform result.
export function requirePublicUrl(value, field, { allowHttp = false } = {}) {
  const protocolLabel = allowHttp ? "HTTP/HTTPS" : "HTTPS";
  const fail = () => new ApiError(400, "INVALID_PUBLIC_URL", `${field} 必须是无登录凭据的公开 ${protocolLabel} URL，不能使用本机或示例地址。`);
  if (typeof value !== "string" || !value.trim() || value.trim().length > 2_000) throw fail();
  let url;
  try {
    url = new URL(value.trim());
  } catch { throw fail(); }
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (!(allowHttp ? ["http:", "https:"] : ["https:"]).includes(url.protocol) ||
      url.username || url.password || !host.includes(".") ||
      isIP(host.replace(/^\[|\]$/g, "")) ||
      /(?:^|\.)(?:localhost|local|internal|invalid|test|example)$/.test(host) ||
      /(?:^|\.)example\.(?:com|org|net)$/.test(host) ||
      (url.port && url.port !== (url.protocol === "https:" ? "443" : "80")) ||
      [...url.searchParams.keys()].some((key) => CREDENTIAL_PARAMETER.test(key)) ||
      credentialFragment(url.hash)) throw fail();
  return url.href;
}

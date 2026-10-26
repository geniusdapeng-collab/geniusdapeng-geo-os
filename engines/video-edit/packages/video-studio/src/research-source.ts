/** Offline source parser and URL checks. This module never sends a network request. */
import { isIP } from "node:net";
export const SOURCE_MAX_BYTES = 2 * 1024 * 1024;
export const SOURCE_MAX_TEXT_CHARS = 24_000;
export interface SourceSnapshot {
  sourceId: string; requestedUrl: string; finalUrl: string; redirectChain: string[];
  fetchedAt: string; contentType: string; rawSha256: string; textSha256: string;
  bytes: number; text: string; assetUrls: string[];
}
export function publicSourceAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127
      || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0)
      || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  // 只准许全球单播 2000::/3；映射IPv4、ULA、链路本地、组播和隧道/文档地址均不进入网络。
  if (family === 6) {
    const groups = address.toLowerCase().split(":"); const first = parseInt(groups[0]!, 16), second = parseInt(groups[1] || "0", 16);
    return first >= 0x2000 && first <= 0x3fff && first !== 0x2002
      && !(first === 0x2001 && (second === 0 || second === 0xdb8 || second >= 0x10 && second <= 0x2f));
  }
  return false;
}

export function sourceUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("SOURCE_URL_INVALID：来源不是有效网址"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) {
    throw new Error("SOURCE_URL_INVALID：来源只接受无凭据的标准 HTTP/HTTPS 公网页面");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || /\.(localhost|local|internal|test|invalid)$/.test(host)) throw new Error("SOURCE_URL_PRIVATE：内部或测试域名不能作正式来源");
  if (isIP(host) && !publicSourceAddress(host)) throw new Error("SOURCE_URL_PRIVATE：来源不能使用非公网IP");
  url.hash = "";
  return url;
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, entity: string) => {
    if (entity.startsWith("#")) {
      const value = parseInt(entity.slice(/^#x/i.test(entity) ? 2 : 1), /^#x/i.test(entity) ? 16 : 10);
      return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : all;
    }
    return named[entity.toLowerCase()] ?? all;
  });
}

/** 只收集候选，不替浏览器做画幅/密度选择；URL 内的逗号不能直接按 split(",") 切开。 */
function srcsetCandidates(value: string): string[] {
  const urls: string[] = []; let position = 0;
  while (position < value.length) {
    while (/[\t\n\f\r ,]/.test(value[position] ?? "") && position < value.length) position++;
    const start = position;
    while (position < value.length && !/[\t\n\f\r ]/.test(value[position]!)) position++;
    let url = value.slice(start, position);
    if (!url) continue;
    if (url.endsWith(",")) { urls.push(url.replace(/,+$/, "")); continue; }
    const descriptorStart = position; let parentheses = 0;
    while (position < value.length) {
      const character = value[position]!;
      if (character === "," && parentheses === 0) break;
      if (character === "(") parentheses++;
      if (character === ")" && parentheses > 0) parentheses--;
      position++;
    }
    const descriptors = value.slice(descriptorStart, position).trim();
    if (!descriptors || /^\d+w$/.test(descriptors) && Number(descriptors.slice(0, -1)) > 0
      || /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?x$/i.test(descriptors) && Number.isFinite(Number(descriptors.slice(0, -1))) && Number(descriptors.slice(0, -1)) > 0) urls.push(url);
    if (value[position] === ",") position++;
  }
  return urls;
}

/** 有界 token 扫描避免把脚本、样式、注释和嵌套模板内的字符串误作真实图片。 */
function sourceImageCandidates(raw: string): string[] {
  const urls: string[] = []; let templateDepth = 0;
  const tags = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-z][a-z0-9:-]*)(?=[\t\n\f\r />])(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(raw)) !== null) {
    const name = match[2]?.toLowerCase();
    if (!name) continue;
    const closing = match[1] === "/";
    if (!closing && ["script", "style", "noscript"].includes(name)) {
      // raw-text 内的 <!-- / <img> 是字符串，不能让通用 token 扫描吞掉真实结束标签。
      const endTag = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])[^>]*>`, "gi");
      endTag.lastIndex = tags.lastIndex;
      if (!endTag.exec(raw)) break;
      tags.lastIndex = endTag.lastIndex;
      continue;
    }
    if (name === "template") { templateDepth = Math.max(0, templateDepth + (closing ? -1 : 1)); continue; }
    if (closing || templateDepth > 0 || name !== "img" && name !== "source") continue;
    const attributes = new Map<string, string>();
    for (const attribute of match[0].matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      const key = attribute[1]!.toLowerCase();
      if (!attributes.has(key)) attributes.set(key, decodeEntities(attribute[2] ?? attribute[3] ?? attribute[4] ?? "").trim());
    }
    // 原图和响应式候选先于 src 占位图，全部仍由 sourceUrl 执行公网 URL 校验。
    for (const key of ["data-original", "data-src-original", "data-lazy-src", "data-src", "srcset", "data-srcset", "source-srcset", "src"]) {
      const value = attributes.get(key);
      if (value) urls.push(...(key.endsWith("srcset") ? srcsetCandidates(value) : [value]));
    }
  }
  return urls;
}

export function sourceDocument(raw: string, contentType: string, finalUrl: string): { text: string; assetUrls: string[] } {
  const html = /(?:html|xhtml)/i.test(contentType);
  const assetUrls = new Set<string>();
  if (html) for (const candidate of sourceImageCandidates(raw)) {
    try { const url = sourceUrl(new URL(candidate, finalUrl).href); assetUrls.add(url.href); } catch { /* 非公网图片不进入候选 */ }
  }
  const visible = html ? raw.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, "\n").replace(/<[^>]*>/g, " ") : raw;
  const text = decodeEntities(visible).replace(/\r\n?/g, "\n").replace(/[\t \f]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text || /(?:请输入验证码|访问过于频繁|请完成安全验证|verify you are human|checking your browser)/i.test(text)) throw new Error("SOURCE_UNAVAILABLE：页面为空或是访问验证页");
  if (text.length > SOURCE_MAX_TEXT_CHARS) throw new Error("SOURCE_TEXT_TOO_LARGE：完整正文超过单来源审核上限，不能截断后作为证据");
  return { text, assetUrls: [...assetUrls] };
}


import { ApiError } from "./errors.mjs";

// JSON.parse accepts duplicate members. Plans, manifests and notebooks need an
// unambiguous byte-to-value contract before schema validation and hashing.
export function parseStrictJson(source, { maxBytes = 1_000_000, maxDepth = 32, maxArray = 4096, maxString = 100_000 } = {}) {
  let text;
  try { text = typeof source === "string" ? source : new TextDecoder("utf-8", { fatal: true }).decode(source); }
  catch { throw new ApiError(400, "INVALID_JSON", "JSON 必须采用有效 UTF-8 编码。"); }
  if (Buffer.byteLength(text) > maxBytes) throw new ApiError(413, "PLAN_TOO_LARGE", "JSON 超过允许的字节上限。");
  let at = 0;
  const invalid = (code = "INVALID_JSON", message = "JSON 结构无效。") => { throw new ApiError(400, code, message); };
  const space = () => { while (/[\x20\x09\x0a\x0d]/.test(text[at] ?? "") && at < text.length) at++; };
  const string = () => {
    const start = at++;
    while (at < text.length) {
      const character = text[at++];
      if (character === '"') {
        let value;
        try { value = JSON.parse(text.slice(start, at)); } catch { invalid(); }
        if (value.length > maxString || [...value].some(char => { const point = char.codePointAt(0); return point >= 0xd800 && point <= 0xdfff; })) invalid("INVALID_JSON_STRING", "JSON 文本过长或含无效 Unicode。");
        return value;
      }
      if (character === "\\") {
        if (text[at] === "u") { if (!/^[a-fA-F0-9]{4}$/.test(text.slice(at + 1, at + 5))) invalid(); at += 5; }
        else { if (!/["\\/bfnrt]/.test(text[at] ?? "")) invalid(); at++; }
      } else if (character.charCodeAt(0) < 32) invalid();
    }
    invalid();
  };
  const value = depth => {
    if (depth > maxDepth) invalid("JSON_TOO_DEEP", "JSON 嵌套超过允许深度。");
    space();
    const character = text[at];
    if (character === '"') return string();
    if (character === "{") {
      at++; space(); const result = {}, keys = new Set();
      if (text[at] === "}") { at++; return result; }
      for (;;) {
        space(); if (text[at] !== '"') invalid();
        const key = string();
        if (["__proto__", "prototype", "constructor"].includes(key)) invalid("UNSAFE_JSON_KEY", "JSON 包含危险对象字段。");
        if (keys.has(key)) invalid("DUPLICATE_JSON_KEY", "JSON 包含重复字段。");
        if (keys.size >= maxArray) invalid("JSON_TOO_LARGE", "JSON 对象字段过多。");
        keys.add(key); space(); if (text[at++] !== ":") invalid();
        result[key] = value(depth + 1); space();
        const delimiter = text[at++]; if (delimiter === "}") return result;
        if (delimiter !== ",") invalid();
      }
    }
    if (character === "[") {
      at++; space(); const result = [];
      if (text[at] === "]") { at++; return result; }
      for (;;) {
        if (result.length >= maxArray) invalid("JSON_ARRAY_TOO_LARGE", "JSON 数组超过允许项数。");
        result.push(value(depth + 1)); space();
        const delimiter = text[at++]; if (delimiter === "]") return result;
        if (delimiter !== ",") invalid();
      }
    }
    for (const [literal, result] of [["true", true], ["false", false], ["null", null]]) {
      if (text.startsWith(literal, at)) { at += literal.length; return result; }
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(at));
    if (!match) invalid();
    at += match[0].length; const number = Number(match[0]);
    if (!Number.isFinite(number)) invalid("INVALID_JSON_NUMBER", "JSON 数字必须是有限值。");
    return number;
  };
  const result = value(0); space(); if (at !== text.length) invalid();
  return result;
}

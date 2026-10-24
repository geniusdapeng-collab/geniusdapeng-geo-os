/** Strict canonical JSON shared by local research evidence. No model, database, or server imports. */
import { createHash } from "node:crypto";

export function canonicalRenderJson(value: unknown): string {
  const active = new Set<object>();
  const canonical = (item: unknown): unknown => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object" || !item) throw new Error("REQUEST_INVALID: 请求指纹只接受 JSON 数据");
    if (active.has(item)) throw new Error("REQUEST_INVALID: 请求指纹含循环引用");
    active.add(item);
    try {
      if (Array.isArray(item)) return item.map(entry => entry === undefined ? null : canonical(entry));
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
        throw new Error("REQUEST_INVALID: 请求指纹含非普通对象");
      }
      const result: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(item).sort()) {
        const entry = (item as Record<string, unknown>)[key];
        if (entry !== undefined) result[key] = canonical(entry);
      }
      return result;
    } finally { active.delete(item); }
  };
  return JSON.stringify(canonical(value));
}

export function renderSha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

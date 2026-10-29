import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Tokenizer } from "tokenizers";
import { TOKENIZER_JSON_SHA256 } from "./registry.mjs";
import { modelError } from "./errors.mjs";

const TOKENIZER_URL = new URL("./assets/deepseek-v4-tokenizer.json", import.meta.url);
let tokenizerPromise;

async function loadTokenizer() {
  let bytes;
  try {
    bytes = await readFile(TOKENIZER_URL);
  } catch (error) {
    throw modelError(
      "MODEL_TOKENIZER_MISSING",
      "官方 DeepSeek tokenizer 资产缺失，拒绝使用字符数近似值。",
      { cause: error },
    );
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== TOKENIZER_JSON_SHA256) {
    throw modelError(
      "MODEL_TOKENIZER_CHANGED",
      "官方 DeepSeek tokenizer 资产摘要与登记值不一致。",
    );
  }
  try {
    return Tokenizer.fromString(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw modelError("MODEL_TOKENIZER_INVALID", "官方 DeepSeek tokenizer 无法加载。", { cause: error });
  }
}

export function getTokenizer() {
  tokenizerPromise ??= loadTokenizer();
  return tokenizerPromise;
}

export async function countTextTokens(value) {
  const tokenizer = await getTokenizer();
  const encoding = await tokenizer.encode(String(value ?? ""));
  return encoding.getLength();
}

export async function countMessagesTokens(messages, { tools = [], responseFormat } = {}) {
  const serialized = JSON.stringify({ messages, tools, responseFormat: responseFormat ?? null });
  const textTokens = await countTextTokens(serialized);
  // Chat protocol framing is real input overhead. Tokenize the complete JSON
  // request envelope, then reserve deterministic room for role boundaries and
  // provider-added delimiters so budget planning does not understate usage.
  return textTokens + 64 + Math.max(1, messages.length) * 16;
}

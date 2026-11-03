/** Offline prompt planning for the hosted DeepSeek-V4.1 Flash 1017 alias. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Tokenizer } from "tokenizers";

export const DEEPSEEK_FLASH_CONTEXT_TOKENS = 1_048_576;
export const DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS = 393_216;
export const DEEPSEEK_IMAGE_TOKEN_LIMIT = 1_024;
export const DEEPSEEK_MAX_IMAGES = 600;
export const DEEPSEEK_REQUEST_BODY_LIMIT_BYTES = 48 * 1024 * 1024;
export const DEEPSEEK_IMAGE_LIMIT_BYTES = 32 * 1024 * 1024;
export const DEEPSEEK_TOKENIZER_SHA256 = "c90dfa01249db1be4245780a052ede752e1361c612ac6d08e2bdada7d599476b";
export const DEEPSEEK_INPUT_TOKEN_BASIS = "deepseek-v4.1-1017-public-prompt-plus-host-margin/v1";
export const DEEPSEEK_TOKENIZER_SOURCE = "https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017/resolve/1bae0e1088993b9b82de08f59de5be5a34e42170/tokenizer.json";

const tokenizerFile = new URL("./assets/deepseek-v4-tokenizer.json", import.meta.url);
let tokenizerPromise;
export function getDeepSeekTokenizer() {
  tokenizerPromise ??= (async () => {
    let bytes;
    try { bytes = await readFile(tokenizerFile); }
    catch (error) { throw new Error("DEEPSEEK_TOKENIZER_MISSING", { cause: error }); }
    if (createHash("sha256").update(bytes).digest("hex") !== DEEPSEEK_TOKENIZER_SHA256) throw new Error("DEEPSEEK_TOKENIZER_CHANGED");
    try { return Tokenizer.fromString(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch (error) { throw new Error("DEEPSEEK_TOKENIZER_INVALID", { cause: error }); }
  })();
  return tokenizerPromise;
}

export async function countDeepSeekTokens(text) {
  const tokenizer = await getDeepSeekTokenizer();
  return (await tokenizer.encode(text, null, { addSpecialTokens: false })).getLength();
}

const BEGIN = "<｜begin▁of▁sentence｜>", END = "<｜end▁of▁sentence｜>";
const SYSTEM = "<｜System｜>", USER = "<｜User｜>", ASSISTANT = "<｜Assistant｜>";
const IMAGE = "<｜deepseek_image｜>", TAG = "｜DSML｜";
const effortMap = { low: 50, high: 75, max: 100 };
const roleOf = message => message.role === "developer" ? "system" : message.role;

function promptText(value) {
  if (value == null) return "";
  if (typeof value !== "string" || value.includes(IMAGE)) throw new Error("DEEPSEEK_CONTENT_INVALID");
  return value;
}

// The public recipe uses Python's ensure_ascii=False, default-spacing JSON.
function recipeJson(value) {
  if (Array.isArray(value)) return `[${value.map(recipeJson).join(", ")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)}: ${recipeJson(entry)}`).join(", ")}}`;
  return JSON.stringify(value);
}

function toolName(functionSpec, namespace = functionSpec.namespace) {
  const prefix = typeof namespace === "object" && namespace ? namespace.name : namespace;
  if (typeof functionSpec.name !== "string" || !functionSpec.name) throw new Error("DEEPSEEK_TOOL_INVALID");
  const [first, second, ...rest] = functionSpec.name.split("::");
  if (rest.length || (second !== undefined && (!second || (prefix && prefix !== first)))) throw new Error("DEEPSEEK_TOOL_INVALID");
  return prefix && second === undefined ? `${prefix}::${first}` : functionSpec.name;
}

// Chat prompt templates adapted from DeepSeek-AI's MIT-licensed V4.1 encoding.py.
function renderTools(tools) {
  const schemas = tools.map(tool => {
    const { namespace = tool.namespace, ...schema } = tool.function ?? {};
    const name = toolName(schema, namespace);
    const description = namespace?.description ? { description: `${namespace.description}\n${schema.description ?? ""}` } : {};
    return recipeJson({ ...schema, name, ...description });
  }).join("\n");
  return `## Tools

You have access to a set of tools to help answer the user's question. You can invoke tools by writing a "<${TAG} calls>" block like the following:

<${TAG} calls>
<${TAG} invoke name="$TOOL_NAME">
<${TAG} parameter name="$PARAMETER_NAME" string="true|false">$PARAMETER_VALUE</${TAG} parameter>
...
</${TAG} invoke>
<${TAG} invoke name="$TOOL_NAME2">
...
</${TAG} invoke>
</${TAG} calls>

String parameters should be specified as is and set \`string="true"\`. For all other types (numbers, booleans, arrays, objects), pass the value in JSON format and set \`string="false"\`.

If thinking_mode is enabled (triggered by <think>), you MUST output your complete reasoning inside <think>...</think> BEFORE any tool calls or final response.

Otherwise, output directly after </think> with tool calls or final response.

### Available Tool Schemas

${schemas}

You MUST strictly follow the above defined tool name and parameter schemas to invoke tool calls.
`;
}

function renderToolCalls(calls) {
  const rendered = calls.map(call => {
    const spec = call.function ?? {};
    let args = spec.arguments;
    for (let attempt = 0; attempt < 2 && typeof args === "string"; attempt++) {
      try { args = JSON.parse(args); }
      catch { break; }
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) args = { arguments: spec.arguments ?? "" };
    const params = Object.entries(args).map(([key, value]) => {
      const isString = typeof value === "string";
      return `<${TAG} parameter name="${key}" string="${isString}">${isString ? value : recipeJson(value)}</${TAG} parameter>`;
    });
    return `<${TAG} invoke name="${toolName(spec, call.namespace ?? spec.namespace)}">\n${params.join("\n")}\n</${TAG} invoke>`;
  });
  return `\n\n<${TAG} calls>\n${rendered.join("\n")}\n</${TAG} calls>`;
}

function imageBytes(uri) {
  if (!uri.startsWith("data:")) return 0;
  const comma = uri.indexOf(",");
  if (comma < 0) throw new Error("DEEPSEEK_IMAGE_SOURCE_INVALID");
  const payload = uri.slice(comma + 1);
  if (!/;base64$/i.test(uri.slice(0, comma))) return Buffer.byteLength(payload);
  return Math.floor(payload.length * 3 / 4) - (payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0);
}

/** Render the public 1017 OpenAI chat subset, keeping image transports outside the textual prompt. */
export function renderDeepSeekPrompt({ messages, tools = [], responseFormat, thinking, reasoningEffort }) {
  const mode = thinking?.type ?? "enabled";
  const effort = reasoningEffort ?? "high";
  const effortNumber = Object.hasOwn(effortMap, effort) ? effortMap[effort] : effort;
  if (!["enabled", "disabled"].includes(mode) || !Number.isInteger(effortNumber) || effortNumber < 1 || effortNumber > 100
    || !Array.isArray(messages) || !messages.length || !Array.isArray(tools)) throw new Error("DEEPSEEK_PROMPT_INVALID");

  let imageCount = 0, inlineImageBytes = 0;
  const content = (value, role) => !Array.isArray(value) ? promptText(value) : value.map(part => {
    if (part?.type === "text") return promptText(part.text);
    if (!["image_url", "file"].includes(part?.type)) throw new Error("DEEPSEEK_CONTENT_INVALID");
    if (role !== "user") throw new Error("DEEPSEEK_IMAGE_ROLE_INVALID");
    const source = part.type === "image_url" ? part.image_url?.url : part.file_data ?? part.file_id;
    if (typeof source !== "string" || !source) throw new Error("DEEPSEEK_IMAGE_SOURCE_INVALID");
    const bytes = part.type === "file" && part.file_data && !source.startsWith("data:")
      ? imageBytes(`data:application/octet-stream;base64,${source}`) : imageBytes(source);
    if (bytes > DEEPSEEK_IMAGE_LIMIT_BYTES) throw new Error("DEEPSEEK_IMAGE_TOO_LARGE");
    imageCount++;
    inlineImageBytes += bytes;
    return IMAGE;
  }).join("\n\n");

  const merged = [];
  let toolOrder = new Map();
  for (const message of messages) {
    const role = roleOf(message);
    const text = content(message.content, role);
    if (role === "user" || role === "tool") {
      let target = merged.at(-1);
      if (target?.role !== "user") { target = { role: "user", parts: [] }; merged.push(target); }
      if (role === "user") target.parts.push({ text, user: true });
      else target.parts.push({ text: `<tool_result>${text}</tool_result>`, order: toolOrder.get(message.tool_call_id) ?? 0 });
    } else if (role === "assistant") {
      const calls = message.tool_calls ?? [];
      if (!Array.isArray(calls)) throw new Error("DEEPSEEK_TOOL_INVALID");
      if (calls.length) toolOrder = new Map(calls.map((call, index) => [call.id, index]));
      merged.push({ role, text, reasoning: promptText(message.reasoning_content), calls, withoutEos: message.wo_eos === true });
    } else if (role === "system") merged.push({ role, text });
    else throw new Error("DEEPSEEK_ROLE_INVALID");
  }
  if (imageCount > DEEPSEEK_MAX_IMAGES) throw new Error("DEEPSEEK_IMAGE_COUNT_EXCEEDED");
  if (inlineImageBytes > 64 * 1024 * 1024) throw new Error("DEEPSEEK_IMAGE_TOO_LARGE");
  if ((tools.length || responseFormat) && merged[0]?.role !== "system") merged.unshift({ role: "system", text: "" });

  const lastUser = merged.findLastIndex((message, index) => message.parts?.some(part => part.user) || (message.role === "system" && index > 0));
  const useThinking = mode === "enabled";
  let prompt = BEGIN;
  for (const [index, message] of merged.entries()) {
    if (index === 0 && useThinking) prompt += `${SYSTEM}Reasoning Effort: ${effortNumber} (range 1-100, the higher the value, the more thorough the reasoning)\n\n`;
    if (message.role === "system") {
      if (index > 0 || !useThinking) prompt += SYSTEM;
      prompt += message.text;
      if (index === 0 && tools.length) prompt += `\n\n${renderTools(tools)}`;
      if (index === 0 && responseFormat) prompt += `\n\n## Response Format:\n\nYou MUST strictly adhere to the following schema to reply:\n${recipeJson(responseFormat)}`;
    } else if (message.role === "user") {
      const sorted = message.parts.filter(part => !part.user).sort((left, right) => left.order - right.order);
      let toolIndex = 0;
      prompt += USER + message.parts.map(part => part.user ? part.text : sorted[toolIndex++].text).join("\n\n");
    } else {
      if (useThinking && (tools.length || index > lastUser)) prompt += message.reasoning + "</think>";
      prompt += message.text;
      if (message.calls.length) prompt += renderToolCalls(message.calls);
      if (!message.withoutEos) prompt += END;
    }
    if ((!merged[index + 1] || merged[index + 1].role === "assistant") && (message.role === "user" || (message.role === "system" && index > 0))) {
      prompt += ASSISTANT + (useThinking && (tools.length || index >= lastUser) ? "<think>" : "</think>");
    }
  }
  return { prompt, imageCount };
}

export async function planDeepSeekWindow(input) {
  const contextTokens = Math.min(input.contextTokens ?? DEEPSEEK_FLASH_CONTEXT_TOKENS, DEEPSEEK_FLASH_CONTEXT_TOKENS);
  const maxOutputTokens = Math.min(input.maxOutputTokens ?? DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS, DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS);
  if (!Number.isSafeInteger(contextTokens) || contextTokens < 1) throw new Error("DEEPSEEK_CONTEXT_INVALID");
  const requested = input.productOutputCap ?? maxOutputTokens;
  if (![maxOutputTokens, requested].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error("DEEPSEEK_OUTPUT_BUDGET_INVALID");
  const requestBytes = input.requestBytes ?? Buffer.byteLength(JSON.stringify({
    messages: input.messages, tools: input.tools ?? [], response_format: input.responseFormat ?? null,
  }));
  if (!Number.isSafeInteger(requestBytes) || requestBytes <= 0 || requestBytes > DEEPSEEK_REQUEST_BODY_LIMIT_BYTES) throw new Error("DEEPSEEK_REQUEST_BODY_TOO_LARGE");

  const { prompt, imageCount } = renderDeepSeekPrompt(input);
  const hostImageTokens = input.imageTokens ?? 0;
  if (!Number.isSafeInteger(hostImageTokens) || hostImageTokens < 0) throw new Error("DEEPSEEK_IMAGE_TOKEN_BUDGET_INVALID");
  const imageTokens = imageCount * DEEPSEEK_IMAGE_TOKEN_LIMIT + hostImageTokens;
  const inputTokens = await countDeepSeekTokens(prompt) + imageTokens;
  // Hosted API may add private framing absent from the public recipe. Budget
  // that separately; real provider usage remains authoritative.
  const inputTokenUpperBound = inputTokens + 1_024 + input.messages.length * 16;
  const mathematical = Math.min(maxOutputTokens, contextTokens - inputTokenUpperBound);
  if (mathematical < 1) throw new Error("DEEPSEEK_CONTEXT_EXCEEDED");
  return { inputTokens, inputTokenUpperBound, inputTokenBasis: DEEPSEEK_INPUT_TOKEN_BASIS, imageTokens,
    outputCeiling: Math.min(mathematical, requested), productConstrained: requested < mathematical, requestBytes, imageCount };
}

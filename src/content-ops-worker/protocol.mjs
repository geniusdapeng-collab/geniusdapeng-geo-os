import { createHash, timingSafeEqual } from 'node:crypto';
import { hashObject } from '../domain/hash.mjs';
import { parseStrictJson } from '../domain/strict-json.mjs';

export const WORKER_VERSION = '1.0.0';
export const VALIDATOR_VERSION = 'content-ops-worker/v1';
export const WORKER_PROTOCOL = 'pengmanager.content-ops-worker/v1';
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export class ContentOpsWorkerError extends Error {
  constructor(code, message, { unknown = false, retryable = false, details, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ContentOpsWorkerError'; this.code = code;
    this.unknown = unknown; this.retryable = retryable;
    if (details !== undefined) this.details = details;
  }
}
export function fail(code, message, options) { throw new ContentOpsWorkerError(code, message, options); }
export function requireCondition(condition, code, message) { if (!condition) fail(code, message); }
export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
export function record(value, label = 'Object', allowed) {
  requireCondition(isRecord(value), 'WORKER_INPUT_INVALID', `${label} must be a JSON object.`);
  if (allowed) for (const key of Object.keys(value)) {
    requireCondition(allowed.includes(key), 'UNKNOWN_FIELD', `${label} contains an unsupported field.`);
  }
  for (const key of Object.keys(value)) requireCondition(!FORBIDDEN_KEYS.has(key), 'UNSAFE_JSON_KEY', `${label} contains an unsafe field.`);
  return value;
}
export function text(value, label, { max = 100_000, empty = false } = {}) {
  requireCondition(typeof value === 'string' && (empty || value.trim().length > 0)
    && Buffer.byteLength(value) <= max && !value.includes('\0'), 'WORKER_INPUT_INVALID', `${label} is missing or exceeds its limit.`);
  return value;
}
export function identifier(value, label = 'Identifier') {
  requireCondition(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value)
    && !value.includes('..') && !FORBIDDEN_KEYS.has(value), 'WORKER_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
export function sha256(value, label = 'SHA256') {
  requireCondition(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'WORKER_INPUT_INVALID', `${label} must be an exact SHA256.`);
  return value;
}
export function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  requireCondition(Number.isSafeInteger(value) && value >= min && value <= max, 'WORKER_INPUT_INVALID', `${label} is outside its allowed integer range.`);
  return value;
}
export function instant(value, label = 'Timestamp') {
  requireCondition(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19),
    'WORKER_INPUT_INVALID', `${label} must be a UTC ISO timestamp.`);
  return Date.parse(value);
}
export function jsonValue(value, { maxBytes = 1_000_000, maxDepth = 32, maxArray = 4096, maxString = 100_000 } = {}) {
  const seen = new Set();
  const visit = (item, depth) => {
    requireCondition(depth <= maxDepth, 'JSON_TOO_DEEP', 'JSON exceeds its depth limit.');
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number') { requireCondition(Number.isFinite(item), 'INVALID_JSON_NUMBER', 'JSON numbers must be finite.'); return; }
    if (typeof item === 'string') {
      text(item, 'JSON text', { max: maxString, empty: true });
      requireCondition(![...item].some(char => char.codePointAt(0) >= 0xd800 && char.codePointAt(0) <= 0xdfff),
        'INVALID_JSON_STRING', 'JSON contains invalid Unicode.'); return;
    }
    requireCondition(Array.isArray(item) || isRecord(item), 'WORKER_INPUT_INVALID', 'Only plain JSON data is permitted.');
    requireCondition(!seen.has(item), 'WORKER_INPUT_INVALID', 'Circular JSON is not permitted.');
    requireCondition(Object.keys(item).length <= maxArray, 'JSON_ARRAY_TOO_LARGE', 'JSON contains too many members.');
    if (Array.isArray(item)) requireCondition(Object.keys(item).length === item.length
      && Object.keys(item).every((key, index) => key === String(index)),
    'WORKER_INPUT_INVALID', 'Sparse arrays and additional array properties are not permitted.');
    seen.add(item);
    for (const [key, entry] of Object.entries(item)) {
      requireCondition(!FORBIDDEN_KEYS.has(key) && entry !== undefined, 'UNSAFE_JSON_KEY', 'JSON contains an unsafe or undefined member.');
      visit(entry, depth + 1);
    }
    seen.delete(item);
  };
  visit(value, 0);
  requireCondition(Buffer.byteLength(JSON.stringify(value)) <= maxBytes, 'PLAN_TOO_LARGE', 'JSON exceeds its byte limit.');
  return value;
}
export function dataHash(value) { return hashObject(jsonValue(value)); }
export function bytesHash(value) { return createHash('sha256').update(value).digest('hex'); }
export function decodeJson(bytes, options) { return jsonValue(parseStrictJson(bytes, options), options); }
export function equalDigest(first, second) {
  if (typeof first !== 'string' || typeof second !== 'string' || first.length !== second.length) return false;
  return timingSafeEqual(Buffer.from(first), Buffer.from(second));
}
export function normalizedOrigin(value, { allowLoopbackHttp = false } = {}) {
  let url;
  try { url = new URL(value); } catch { fail('WORKER_ORIGIN_INVALID', 'Worker cloud origin is invalid.'); }
  requireCondition(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/',
    'WORKER_ORIGIN_INVALID', 'Worker cloud origin must not contain credentials or a path.');
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  requireCondition(url.protocol === 'https:' || allowLoopbackHttp && local && url.protocol === 'http:',
    'WORKER_ORIGIN_INVALID', 'Worker cloud origin requires HTTPS.');
  return url.origin;
}
export function safeError(error) {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.code) ? error.code : 'WORKER_FAILED';
  const known = error instanceof ContentOpsWorkerError;
  return { code, message: known ? error.message : 'The content preparation step failed; private details were withheld.',
    unknown: error?.unknown === true, retryable: error?.retryable === true };
}
export function throwIfAborted(signal) {
  if (signal?.aborted) fail('WORKER_CANCELLED', 'The worker stopped before starting another operation.');
}
export async function boundedResponseBytes(response, maxBytes = 1_000_000) {
  integer(maxBytes, 'Response byte limit', 1, 100_000_000);
  const declared = response.headers?.get?.('content-length');
  if (declared !== null && declared !== undefined) {
    requireCondition(/^\d+$/.test(declared) && Number(declared) <= maxBytes, 'RESPONSE_TOO_LARGE', 'The response exceeds its allowed byte limit.');
  }
  if (!response.body?.getReader) {
    const data = Buffer.from(await response.arrayBuffer());
    requireCondition(data.length <= maxBytes, 'RESPONSE_TOO_LARGE', 'The response exceeds its allowed byte limit.');
    return data;
  }
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); fail('RESPONSE_TOO_LARGE', 'The response exceeds its allowed byte limit.'); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally { reader.releaseLock(); }
}

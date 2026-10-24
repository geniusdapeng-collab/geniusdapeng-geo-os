// Shared by the native Mac writer and authenticated browser directory writer.
// A backup is an exact final body, never a copy of account/authentication state.
export const FINAL_CONTENT_STATES = Object.freeze(["approved", "scheduled", "published"]);
export const FINAL_BACKUP_SCHEMA = "pengmanager.final-content-backup/v1";
const METADATA_KEYS = Object.freeze([
  "schemaVersion", "contentId", "title", "version", "status", "contentHash", "bodySha256", "backedUpAt",
]);

export class FinalBackupFormatError extends Error {
  constructor(code, message) { super(message); this.name = "FinalBackupFormatError"; this.code = code; }
}

export function isFinalContent(content) {
  return Boolean(content && FINAL_CONTENT_STATES.includes(content.status));
}

function validText(value, maximum) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) return false;
  // Unpaired UTF-16 surrogates cannot be preserved as UTF-8. Refuse rather than replace them.
  return ![...value].some(character => {
    const code = character.codePointAt(0);
    return code >= 0xD800 && code <= 0xDFFF;
  });
}

function validMetadata(metadata) {
  return Boolean(metadata && typeof metadata === "object" && !Array.isArray(metadata) &&
    Object.keys(metadata).length === METADATA_KEYS.length &&
    METADATA_KEYS.every(key => Object.hasOwn(metadata, key)) &&
    metadata.schemaVersion === FINAL_BACKUP_SCHEMA &&
    typeof metadata.contentId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(metadata.contentId) &&
    validText(metadata.title, 240) && Number.isSafeInteger(metadata.version) && metadata.version >= 1 &&
    FINAL_CONTENT_STATES.includes(metadata.status) &&
    typeof metadata.contentHash === "string" && /^[a-f0-9]{64}$/.test(metadata.contentHash) &&
    typeof metadata.bodySha256 === "string" && /^[a-f0-9]{64}$/.test(metadata.bodySha256) &&
    typeof metadata.backedUpAt === "string" && Number.isFinite(Date.parse(metadata.backedUpAt)));
}

async function sha256(value) {
  if (!globalThis.crypto?.subtle) {
    throw new FinalBackupFormatError("FINAL_BACKUP_CRYPTO_UNAVAILABLE", "无法安全计算定稿备份校验值。");
  }
  const bytes = new TextEncoder().encode(value);
  return [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes))]
    .map(value => value.toString(16).padStart(2, "0")).join("");
}

export async function prepareFinalContentBackup(content, { backedUpAt = new Date().toISOString() } = {}) {
  if (!isFinalContent(content) || typeof content.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(content.id) || !validText(content.title, 240) ||
      !validText(content.body, 50_000) || !Number.isSafeInteger(content.version) || content.version < 1 ||
      typeof backedUpAt !== "string" || !Number.isFinite(Date.parse(backedUpAt))) {
    throw new FinalBackupFormatError("FINAL_BACKUP_INVALID_CONTENT", "只备份资料完整的已批准定稿。");
  }
  const contentHash = await sha256(JSON.stringify([content.id, content.title, content.body]));
  const bodySha256 = await sha256(content.body);
  return {
    directoryName: `${content.id}--${contentHash}`,
    body: content.body,
    metadata: {
      schemaVersion: FINAL_BACKUP_SCHEMA,
      contentId: content.id,
      title: content.title,
      version: content.version,
      status: content.status,
      contentHash,
      bodySha256,
      backedUpAt,
    },
  };
}

export function finalContentBackupMatches(prepared, metadata, body) {
  return Boolean(prepared && validMetadata(metadata) && body === prepared.body &&
    metadata.contentId === prepared.metadata.contentId && metadata.title === prepared.metadata.title &&
    metadata.contentHash === prepared.metadata.contentHash && metadata.bodySha256 === prepared.metadata.bodySha256);
}

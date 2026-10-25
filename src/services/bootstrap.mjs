import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CURRENT_ALIASES, LEGACY_ALIASES, MAIN_PROFILE, SYSTEM_IDENTITY } from "../domain/identity.mjs";
import { hashObject } from "../domain/hash.mjs";
import { ApiError } from "../domain/errors.mjs";
import { LEGACY_PLATFORM_IDS } from "../domain/platform-catalog.mjs";
import { JsonStore } from "../storage/json-store.mjs";

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) {
      return fallback;
    }
    throw error;
  }
}

export async function loadSeedState(dataDir) {
  const [accounts, claims, queries, content, contentBank] = await Promise.all([
    readJson(join(dataDir, "accounts.json")),
    readJson(join(dataDir, "claims.json")),
    readJson(join(dataDir, "queries.json")),
    readJson(join(dataDir, "content.json")),
    readJson(join(dataDir, "content-bank.json"), []),
  ]);

  return {
    system: { ...SYSTEM_IDENTITY },
    entity: {
      ...MAIN_PROFILE,
      aliases: [...CURRENT_ALIASES, ...LEGACY_ALIASES],
      ownedUrlPrefixes: [
        "https://github.com/geniusdapeng-collab",
        "https://cnb.cool/workloom-ai",
      ],
    },
    accounts,
    claims,
    queries,
    content,
    contentBank,
    publications: [],
    interactions: [],
    observations: [],
    mediaJobs: [],
    publicExports: [],
  };
}

// Change profile metadata once without rewriting published content or ledger history.
export async function migratePengManagerIdentity(store, dataDir) {
  const current = store.snapshot();
  if (current.entity?.id !== MAIN_PROFILE.id || current.entity.profileVersion >= 2) {
    return false;
  }
  const [seed, legacy] = await Promise.all([
    loadSeedState(dataDir),
    readJson(join(dataDir, "..", "migrations", "identity-v1.json")),
  ]);
  await store.mutate(
    { type: "identity.updated", actor: "PengManager", payload: { profileVersion: 2, systemId: SYSTEM_IDENTITY.id } },
    (state) => {
      state.system = { ...SYSTEM_IDENTITY };
      state.entity = {
        ...state.entity,
        ...MAIN_PROFILE,
        aliases: [...new Set([...CURRENT_ALIASES, ...LEGACY_ALIASES, ...(state.entity.aliases ?? [])])],
      };
      const profileFields = ["language", "name", "nameZh", "nameEn", "displayName", "displayNameZh", "displayNameEn", "bio", "bioZh", "bioEn"];
      for (const account of state.accounts) {
        const defaults = seed.accounts.find((row) => row.id === account.id);
        if (!defaults) continue;
        for (const field of profileFields) {
          if (defaults[field] !== undefined) account[field] = defaults[field];
        }
      }
      for (const query of state.queries) {
        const previous = legacy.queries.find((row) => row.id === query.id);
        const next = seed.queries.find((row) => row.id === query.id);
        if (previous && next && query.text === previous.text) query.text = next.text;
      }
      for (const claim of state.claims) {
        const previous = legacy.claims.find((row) => row.id === claim.id);
        const next = seed.claims.find((row) => row.id === claim.id);
        if (previous && next && claim.state !== "approved" && claim.text === previous.text) {
          claim.text = next.text;
          if (claim.source?.label === previous.source?.label) claim.source.label = next.source.label;
        }
      }
      for (const item of state.contentBank ?? []) {
        const previous = legacy.contentBank.find((row) => row.id === item.id);
        const next = seed.contentBank.find((row) => row.id === item.id);
        if (!previous || !next) continue;
        for (const field of ["title", "hook", "thesis"]) {
          if (item[field] === previous[field]) item[field] = next[field];
        }
      }
      for (const content of state.content) {
        if (content.status === "draft" && content.owner === "PengStack") content.owner = "PengManager";
      }
      return { profileVersion: 2 };
    },
  );
  return true;
}

const EDITORIAL_COLLECTIONS = ["stories", "editions", "destinations", "websiteReleases", "websiteRoutes", "editorialRequests", "mediaAssets", "mediaAssetRequests"];
const PROTECTED_COLLECTIONS = ["claims", "content", "contentBank", "publications", "interactions", "observations", "mediaJobs", "publicExports", "accountOperations", "queries"];
const ACCOUNT_BASELINE_FIELDS = ["id", "platform", "handle", "profileUrl", "status", "policyStatus", "policyCheckedAt", "policyReviewedBy", "language", "displayName"];

function migrationOrigin(value) {
  if (!value) return "";
  let url;
  try { url = new URL(value); } catch { throw new ApiError(400, "INVALID_PUBLIC_ORIGIN", "官网 origin 无效。"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      !(url.protocol === "https:" || (url.protocol === "http:" && loopback && process.env.NODE_ENV !== "production"))) {
    throw new ApiError(400, "INVALID_PUBLIC_ORIGIN", "官网 origin 必须是 HTTPS，开发模式仅允许本机 HTTP。");
  }
  return url.origin;
}

export function planEditorialMigration(state, { publicOrigin } = {}) {
  if (![1, 2].includes(state?.schemaVersion)) throw new ApiError(409, "STATE_SCHEMA_UNSUPPORTED", "无法迁移未知状态版本。");
  if (!Array.isArray(state.accounts) || !Array.isArray(state.events)) throw new ApiError(409, "EDITORIAL_MIGRATION_INVALID_STATE", "迁移输入缺少账号或事件集合。");
  const ids = new Set();
  for (const account of state.accounts) {
    if (typeof account.id !== "string" || ids.has(account.id)) throw new ApiError(409, "DUPLICATE_ACCOUNT_ID", "迁移前必须解决重复账号标识符。");
    ids.add(account.id);
  }
  const origin = migrationOrigin(publicOrigin);
  for (const key of EDITORIAL_COLLECTIONS) {
    if (state[key] !== undefined && !Array.isArray(state[key])) throw new ApiError(409, "EDITORIAL_MIGRATION_INVALID_STATE", "编辑集合不是数组，停止迁移。");
  }
  if (state.migrations !== undefined && !Array.isArray(state.migrations)) throw new ApiError(409, "EDITORIAL_MIGRATION_INVALID_STATE", "迁移记录无效。");
  return {
    migrationId: "content-platform-v1", fromSchema: state.schemaVersion, toSchema: 2,
    alreadyApplied: state.schemaVersion === 2 && (state.migrations ?? []).some(row => row.id === "content-platform-v1"),
    expectedRevision: state.revision, inputHash: hashObject(state), publicOrigin: origin,
    accounts: state.accounts.map(account => ({ id: account.id,
      platformId: account.platformId ?? (LEGACY_PLATFORM_IDS[account.id] === account.platform ? account.id : null),
      preserveExistingFields: true })),
    protectedHashes: Object.fromEntries(PROTECTED_COLLECTIONS.filter(key => state[key] !== undefined).map(key => [key, hashObject(state[key])])),
    eventHead: state.events.at(-1)?.hash ?? null,
    rollback: "Restore the consistent pre-migration snapshot only before accepting new writes; after v2 writes use a forward corrective migration or verified lossless export. Old binaries must not open v2 state.",
  };
}

export async function migrateEditorialState(store, { publicOrigin, dryRun = false, clock = () => new Date() } = {}) {
  const initial = planEditorialMigration(store.snapshot(), { publicOrigin });
  if (dryRun) return initial;
  if (initial.alreadyApplied) return { ...initial, changed: false };
  if (initial.fromSchema === 2) throw new ApiError(409, "EDITORIAL_MIGRATION_MARKER_MISSING", "状态版本与编辑迁移标记不一致。");
  const at = clock().toISOString();
  const payload = { migrationId: initial.migrationId, fromSchema: 1, toSchema: 2,
    protectedHashes: initial.protectedHashes, previousEventHead: initial.eventHead };
  const { result } = await store.mutate({ type: "editorial.schema_migrated", actor: "system", payload }, state => {
    const current = planEditorialMigration(state, { publicOrigin });
    if (current.alreadyApplied) return JsonStore.noChange({ ...current, changed: false });
    if (current.inputHash !== initial.inputHash || current.expectedRevision !== initial.expectedRevision) {
      throw new ApiError(409, "MIGRATION_STATE_CHANGED", "状态已变化，请重新运行迁移 dry-run。");
    }
    const previousAccounts = structuredClone(state.accounts);
    payload.accountBaselines = state.accounts.map(account => Object.fromEntries(
      ACCOUNT_BASELINE_FIELDS.filter(key => account[key] !== undefined).map(key => [key, account[key]])));
    for (const account of state.accounts) {
      const mapping = current.accounts.find(row => row.id === account.id);
      account.platformId ??= mapping.platformId;
      account.identityVersion ??= 1;
      account.identityReview ??= { status: "unverified", reason: "legacy_record_requires_owner_verification" };
      account.revision ??= 0;
    }
    for (const key of EDITORIAL_COLLECTIONS) state[key] ??= [];
    if (!state.destinations.some(row => row.id === "official-site")) {
      state.destinations.push({ id: "official-site", platformId: "official-site", accountId: null,
        kind: "owned_origin", name: "个人官网 · Personal Website", locator: { origin: current.publicOrigin },
        visibility: "unverified", status: "draft", identityVersion: 1,
        identityReview: { status: "unverified" }, policyStatus: "manual_review_required",
        policyCheckedAt: null, revision: 0, createdAt: at, updatedAt: at });
    }
    for (const key of Object.keys(current.protectedHashes)) {
      if (hashObject(state[key]) !== current.protectedHashes[key]) throw new ApiError(409, "MIGRATION_PROTECTED_DATA_CHANGED", "迁移不得修改旧内容或回执。");
    }
    for (const previous of previousAccounts) {
      const next = state.accounts.find(row => row.id === previous.id);
      if (!next || hashObject(previous) !== hashObject(Object.fromEntries(Object.keys(previous).map(key => [key, next[key]])))) {
        throw new ApiError(409, "MIGRATION_ACCOUNT_CHANGED", "迁移不得覆盖账号自定义字段。");
      }
    }
    state.migrations ??= [];
    state.migrations.push({ id: current.migrationId, at, fromSchema: 1, toSchema: 2,
      protectedHashes: current.protectedHashes, previousEventHead: current.eventHead });
    state.schemaVersion = 2;
    return { ...current, changed: true };
  });
  return result;
}

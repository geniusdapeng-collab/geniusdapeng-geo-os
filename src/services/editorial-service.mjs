import { ApiError, PolicyError } from "../domain/errors.mjs";
import { hashObject } from "../domain/hash.mjs";
import { requirePublicUrl } from "../domain/public-url.mjs";
import { transitionContent } from "../domain/state-machine.mjs";
import { platformById, platformCatalog } from "../domain/platform-catalog.mjs";
import {
  EDITORIAL_SCHEMA, EDITORIAL_NATIVE_SCHEMA, EDITORIAL_NATIVE_EDITION_SCHEMA, isEditorialVariantSchema,
  EDITORIAL_LOCALES, EDITORIAL_FORMATS, accountEditorialIdentity,
  assertEditorialAssets, claimEditorialFingerprint, destinationEditorialIdentity,
  editorialEditionSnapshot, editorialEtag, editorialId, editorialInput, editorialSensitiveFindings, editorialText,
  editorialVariantSnapshot, normalizeEditorialAssetRefs, normalizeEditorialBlocks,
  publicEditorialClaim, validateEditorialVariant,
} from "../domain/editorial.mjs";
import { JsonStore } from "../storage/json-store.mjs";
import { validateCandidateForReview } from "../domain/content-ops-quality.mjs";

export { editorialEtag, editorialVariantSnapshot, validateEditorialVariant } from "../domain/editorial.mjs";

const ACCOUNT_STATUSES = new Set(["draft", "active", "paused", "archived"]);
const DESTINATION_KINDS = new Set(["owned_origin", "profile_feed", "page", "repository", "community", "community_channel", "artifact_repository"]);
const VISIBILITIES = new Set(["public", "restricted", "private", "unverified"]);
const POLICIES = new Set(["reviewed", "manual_review_required"]);
const SECTIONS = { article: "articles", image_text: "visuals", video: "videos" };
const LANGUAGES = { "zh-CN": "zh", "en-US": "en" };
const ACCOUNT_PROFILE_FIELDS = ["id", "platform", "platformId", "handle", "profileUrl", "language", "displayName", "status", "identityVersion", "identityReview", "policyStatus", "policyCheckedAt", "policyReviewedBy"];

function record(rows, id, code) {
  editorialId(id);
  const row = rows?.find(item => item.id === id);
  if (!row) throw new ApiError(404, code, "找不到指定记录。");
  return row;
}

function nextId(prefix, rows) {
  const maximum = rows.reduce((result, row) => Math.max(result, Number(String(row.id).match(new RegExp(`^${prefix}-(\\d+)$`))?.[1] ?? 0)), 0);
  return `${prefix}-${String(maximum + 1).padStart(5, "0")}`;
}

function entity(row) { return { ...structuredClone(row), etag: editorialEtag(row) }; }
function timestamp(value, field, now) {
  const result = editorialText(value, field, 80);
  const date = new Date(result);
  if (!Number.isFinite(date.getTime()) || date.getTime() > now.getTime() + 60_000) throw new ApiError(400, "INVALID_TIMESTAMP", `${field} 时间无效。`);
  return date.toISOString();
}
function assertMatch(row, supplied) {
  if (!supplied) throw new ApiError(428, "PRECONDITION_REQUIRED", "请先读取记录并提供 If-Match。");
  if (supplied !== editorialEtag(row)) throw new ApiError(412, "PRECONDITION_FAILED", "记录已变化，请刷新后重新核对。");
}
function stringArray(value, field, maximum = 100) {
  if (!Array.isArray(value) || value.length > maximum) throw new ApiError(400, "INVALID_INPUT", `${field} 必须是有界数组。`);
  const values = value.map(item => editorialId(item, field));
  if (new Set(values).size !== values.length) throw new ApiError(400, "DUPLICATE_REFERENCE", `${field} 不允许重复值。`);
  return values;
}
function claimBindings(state, ids) {
  return ids.map(id => ({ claimId: id, hash: claimEditorialFingerprint(record(state.claims, id, "CLAIM_NOT_FOUND")) }));
}
function assertLocaleFormat(locale, format) {
  if (!EDITORIAL_LOCALES.includes(locale)) throw new ApiError(400, "INVALID_LOCALE", "仅支持当前登记的中文和英文版本。");
  if (!EDITORIAL_FORMATS.includes(format)) throw new ApiError(400, "INVALID_CONTENT_TYPE", "内容形式只能是 article、image_text 或 video。");
}
function profileAudit(account) {
  return Object.fromEntries(ACCOUNT_PROFILE_FIELDS.filter(key => account[key] !== undefined).map(key => [key, structuredClone(account[key])]));
}
function unresolvedAccountActions(state, id) {
  return (state.accountOperations ?? []).filter(row => row.accountId === id && row.status === "in_progress");
}
function ownOrigin(value, { production = process.env.NODE_ENV === "production" } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new ApiError(400, "INVALID_PUBLIC_ORIGIN", "官网 origin 未配置或无效。"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      !(url.protocol === "https:" || (!production && url.protocol === "http:" && loopback))) {
    throw new ApiError(400, "INVALID_PUBLIC_ORIGIN", "生产官网必须使用 HTTPS，开发 HTTP 仅限本机。");
  }
  return url.origin;
}
function destinationLocator(kind, value, origin) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "INVALID_DESTINATION", "目的地必须提供结构化定位信息。");
  if (kind === "owned_origin") {
    editorialInput(value, ["origin"]);
    if (ownOrigin(value.origin) !== origin) throw new PolicyError("OWNED_ORIGIN_MISMATCH", "官网目的地必须与受保护配置的本站 origin 完全一致。");
    return { origin };
  }
  if (kind === "community_channel") {
    editorialInput(value, ["serverId", "channelId", "threadId"]);
    const locator = {};
    for (const key of ["serverId", "channelId"]) {
      if (typeof value[key] !== "string" || !/^\d{5,30}$/.test(value[key])) throw new ApiError(400, "INVALID_DESTINATION", "服务器或频道标识符无效。");
      locator[key] = value[key];
    }
    if (value.threadId !== undefined) {
      if (typeof value.threadId !== "string" || !/^\d{5,30}$/.test(value.threadId)) throw new ApiError(400, "INVALID_DESTINATION", "主题标识符无效。");
      locator.threadId = value.threadId;
    }
    return locator;
  }
  editorialInput(value, ["url", "artifactKind"]);
  const locator = { url: requirePublicUrl(value.url, "destination.locator.url") };
  if (kind === "artifact_repository") locator.artifactKind = editorialText(value.artifactKind, "artifactKind", 80);
  else if (value.artifactKind !== undefined) throw new ApiError(400, "INVALID_DESTINATION", "此目的地类型不接受作品类型。");
  return locator;
}

function releaseSnapshot(release) { return release.publicSnapshot; }
function releaseSnapshotValid(release) { return hashObject(releaseSnapshot(release)) === release.snapshotHash; }

export class EditorialService {
  constructor({ store, geoService = null, mediaAssets = null, productionArtifacts = null, publicOrigin = "https://pengmanager.com",
    clock = () => new Date(), verifyReadback = null, beforeActivation = null } = {}) {
    this.store = store;
    this.geoService = geoService;
    this.mediaAssets = mediaAssets;
    this.productionArtifacts = productionArtifacts;
    this.publicOrigin = ownOrigin(publicOrigin);
    this.clock = clock;
    this.verifyReadback = verifyReadback;
    this.beforeActivation = beforeActivation;
  }

  #state() {
    const state = this.store.snapshot();
    if (![2, 3].includes(state.schemaVersion) || ["stories", "editions", "destinations", "websiteReleases", "websiteRoutes", "editorialRequests"].some(key => !Array.isArray(state[key]))) {
      throw new ApiError(503, "EDITORIAL_MIGRATION_REQUIRED", "编辑服务需要先完成版本化迁移。");
    }
    return state;
  }

  async #write(scope, input, ctx, handler) {
    if (!ctx || typeof ctx !== "object" || !["local", "session"].includes(ctx.method)) throw new ApiError(403, "AGENT_SCOPE_DENIED", "编辑与公开发布操作仅允许管理员。");
    const actor = editorialText(ctx.actor, "actor", 120);
    if (typeof ctx.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(ctx.idempotencyKey)) {
      throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "新编辑操作必须提供 8 到 128 位 Idempotency-Key。");
    }
    this.#state();
    const keyHash = hashObject({ actor, scope, key: ctx.idempotencyKey });
    const requestHash = hashObject(input);
    const payload = { scope, requestHash };
    const { result } = await this.store.mutate({ type: `editorial.${scope.split(":")[0]}`, actor, payload }, async state => {
      const previous = state.editorialRequests.find(row => row.keyHash === keyHash);
      if (previous) {
        if (previous.requestHash !== requestHash) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "此幂等键已用于不同请求。");
        return JsonStore.noChange(previous.result);
      }
      const result = await handler(state, { actor, ifMatch: ctx.ifMatch, payload, now: this.clock() });
      state.editorialRequests.push({ keyHash, actor, scope, requestHash, result: structuredClone(result), at: this.clock().toISOString() });
      return result;
    });
    return result;
  }

  catalog() {
    const state = this.#state();
    const bundled = platformCatalog();
    return { version: bundled.version, note: bundled.note, platforms: bundled.platforms.map(platform => ({ ...platform,
      configuredAccountCount: state.accounts.filter(account => account.platformId === platform.id).length,
      activeAccountCount: state.accounts.filter(account => account.platformId === platform.id && account.status === "active").length,
      identityVerifiedCount: state.accounts.filter(account => account.platformId === platform.id && account.identityReview?.status === "verified").length,
      destinationCount: state.destinations.filter(destination => destination.platformId === platform.id).length,
    })) };
  }

  bootstrap() {
    const state = this.#state();
    return { schemaVersion: state.schemaVersion, revision: state.revision, catalog: this.catalog(),
      accounts: state.accounts.map(entity), destinations: state.destinations.map(entity),
      stories: state.stories.map(entity), editions: state.editions.map(row => this.#editionEntity(state, row)),
      variants: state.content.filter(row => isEditorialVariantSchema(row.snapshotSchema)).map(entity),
      releases: state.websiteReleases.map(entity), routes: state.websiteRoutes.map(entity), claims: state.claims };
  }

  listAccounts() { return { items: this.#state().accounts.map(entity) }; }
  getAccount(id) { return entity(record(this.#state().accounts, id, "ACCOUNT_NOT_FOUND")); }
  listDestinations() { return { items: this.#state().destinations.map(entity) }; }
  getDestination(id) { return entity(record(this.#state().destinations, id, "DESTINATION_NOT_FOUND")); }
  listStories() { return { items: this.#state().stories.map(entity) }; }
  listReleases() { return { items: this.#state().websiteReleases.map(entity) }; }
  getRelease(id) { return entity(record(this.#state().websiteReleases, id, "RELEASE_NOT_FOUND")); }
  ownsVariant(id) { return this.store.snapshot().content.some(row => row.id === id && row.snapshotSchema !== undefined); }
  getVariant(id) {
    const row = record(this.#state().content, id, "CONTENT_NOT_FOUND");
    if (!isEditorialVariantSchema(row.snapshotSchema)) throw new ApiError(409, "EDITORIAL_SCHEMA_UNSUPPORTED", "内容不是受支持的编辑快照版本。");
    return entity(row);
  }

  getStory(id) {
    const state = this.#state();
    return { ...entity(record(state.stories, id, "STORY_NOT_FOUND")),
      editions: state.editions.filter(row => row.storyId === id).map(row => this.#editionEntity(state, row)),
      variants: state.content.filter(row => row.storyId === id && isEditorialVariantSchema(row.snapshotSchema)).map(entity),
      releases: state.websiteReleases.filter(row => row.storyId === id).map(entity) };
  }

  #editionEntity(state, edition) {
    let translationStatus = "original";
    if (edition.sourceEditionId) {
      const source = state.editions.find(row => row.id === edition.sourceEditionId);
      translationStatus = !source || state.editions.some(row => row.familyId === source.familyId && row.editorialRevision > source.editorialRevision)
        ? "needs_review" : "source_revision_linked";
    }
    return { ...entity(edition), translationStatus };
  }
  getEdition(id) { const state = this.#state(); return this.#editionEntity(state, record(state.editions, id, "EDITION_NOT_FOUND")); }

  accountHistory(id) {
    const state = this.#state(); record(state.accounts, id, "ACCOUNT_NOT_FOUND");
    const items = [];
    for (const event of state.events) {
      const baseline = event.type === "editorial.schema_migrated" && event.payload?.accountBaselines?.find(row => row.id === id);
      if (baseline) items.push({ sequence: event.sequence, at: event.at, actor: event.actor, origin: "migration_baseline", after: baseline });
      if (event.payload?.accountId === id) items.push({ sequence: event.sequence, at: event.at, actor: event.actor,
        origin: event.payload.before || event.payload.after ? "user_change" : "legacy_event_without_field_history",
        type: event.type, before: event.payload.before ?? null, after: event.payload.after ?? null, reason: event.payload.reason ?? null });
    }
    return { accountId: id, items };
  }

  async createAccount(input, ctx) {
    editorialInput(input, ["platformId", "handle", "profileUrl", "language", "displayName"]);
    const platform = platformById(input.platformId);
    if (platform.kind === "owned_site") throw new ApiError(400, "OWNED_DESTINATION_REQUIRED", "官网使用受核实的自有目的地，不创建社媒账号。");
    const handle = editorialText(input.handle, "handle", 160);
    const profileUrl = requirePublicUrl(input.profileUrl, "profileUrl");
    const language = input.language ?? (platform.localeHint.includes("en") && !platform.localeHint.startsWith("zh") ? "en-US" : "zh-CN");
    if (!EDITORIAL_LOCALES.includes(language)) throw new ApiError(400, "INVALID_LOCALE", "账号语言无效。");
    const displayName = editorialText(input.displayName ?? handle, "displayName", 240);
    return this.#write("account_created", input, ctx, (state, { actor, now, payload }) => {
      if (state.accounts.some(row => row.platformId === platform.id && (row.handle.toLowerCase() === handle.toLowerCase() || row.profileUrl === profileUrl))) {
        throw new ApiError(409, "DUPLICATE_ACCOUNT", "此平台账号身份已登记，请使用现有记录。");
      }
      const id = nextId("ACC", state.accounts);
      const account = { id, platformId: platform.id, platform: platform.name, handle, profileUrl, language, displayName,
        status: "draft", policyStatus: "manual_review_required", policyCheckedAt: null,
        identityVersion: 1, identityReview: { status: "unverified" }, revision: 1,
        publishMode: "manual", createdAt: now.toISOString(), updatedAt: now.toISOString() };
      state.accounts.push(account); Object.assign(payload, { accountId: id, after: profileAudit(account) });
      return entity(account);
    });
  }

  async updateAccount(id, input, ctx) {
    editorialInput(input, ["handle", "profileUrl", "language", "displayName", "status", "identityConfirmed", "policyStatus", "policyCheckedAt", "reviewNote", "reason"]);
    if (input.status !== undefined && !ACCOUNT_STATUSES.has(input.status)) throw new ApiError(400, "INVALID_ACCOUNT_STATUS", "账号状态无效。");
    if (input.policyStatus !== undefined && !POLICIES.has(input.policyStatus)) throw new ApiError(400, "INVALID_POLICY_STATUS", "规则审阅状态无效。");
    if (input.identityConfirmed !== undefined && typeof input.identityConfirmed !== "boolean") throw new ApiError(400, "INVALID_INPUT", "身份确认必须是布尔值。");
    return this.#write(`account_updated:${id}`, input, ctx, (state, { actor, ifMatch, now, payload }) => {
      const account = record(state.accounts, id, "ACCOUNT_NOT_FOUND"); assertMatch(account, ifMatch);
      const before = profileAudit(account);
      const handle = input.handle === undefined ? account.handle : editorialText(input.handle, "handle", 160);
      const profileUrl = input.profileUrl === undefined ? (account.profileUrl ?? "") : input.profileUrl === "" ? "" : requirePublicUrl(input.profileUrl, "profileUrl");
      const changed = handle !== account.handle || profileUrl !== (account.profileUrl ?? "");
      if (changed) {
        if (unresolvedAccountActions(state, id).length) throw new ApiError(409, "ACCOUNT_RECONCILIATION_REQUIRED", "账号尚有结果未确定的动作，先完成原账号回读。");
        account.identityVersion = (account.identityVersion ?? 1) + 1;
        account.identityReview = { status: "unverified" };
        account.policyStatus = "manual_review_required";
      }
      account.handle = handle; account.profileUrl = profileUrl;
      if (input.language !== undefined) {
        if (!EDITORIAL_LOCALES.includes(input.language)) throw new ApiError(400, "INVALID_LOCALE", "账号语言无效。");
        account.language = input.language;
      }
      if (input.displayName !== undefined) account.displayName = editorialText(input.displayName, "displayName", 240);
      if (input.identityConfirmed === true || input.policyStatus === "reviewed") {
        const note = editorialText(input.reviewNote, "reviewNote", 2000);
        if (input.identityConfirmed === true) {
          if (!account.platformId || !account.profileUrl) throw new PolicyError("ACCOUNT_IDENTITY_INCOMPLETE", "确认身份前必须配置真实平台和公开主页。");
          account.identityReview = { status: "verified", reviewedBy: actor, reviewedAt: now.toISOString(), note };
        }
        if (input.policyStatus === "reviewed") account.policyReviewNote = note;
      }
      if (input.identityConfirmed === false) account.identityReview = { status: "unverified" };
      if (input.policyStatus !== undefined) account.policyStatus = input.policyStatus;
      if (input.policyCheckedAt !== undefined) account.policyCheckedAt = timestamp(input.policyCheckedAt, "policyCheckedAt", now);
      if (input.policyStatus === "reviewed") {
        if (!account.policyCheckedAt) throw new ApiError(400, "POLICY_REVIEW_TIME_REQUIRED", "规则审阅必须记录真实时间。");
        account.policyReviewedBy = actor;
      }
      if (input.status !== undefined) {
        if (["paused", "archived"].includes(input.status)) {
          const reason = editorialText(input.reason, "reason", 2000);
          if (unresolvedAccountActions(state, id).length) throw new ApiError(409, "ACCOUNT_RECONCILIATION_REQUIRED", "结果未确定时不能暂停或归档账号，先回读并登记原结果。");
          payload.reason = reason;
          if (input.status === "archived") Object.assign(account, { archivedAt: now.toISOString(), archivedBy: actor, archiveReason: reason });
        }
        account.status = input.status;
      }
      if (account.status === "active" && (account.identityReview?.status !== "verified" || account.policyStatus !== "reviewed" || !account.policyCheckedAt)) {
        throw new PolicyError("ACCOUNT_NOT_READY", "启用账号前必须核实身份与平台规则。");
      }
      account.revision = (account.revision ?? 0) + 1; account.updatedAt = now.toISOString();
      Object.assign(payload, { accountId: id, before, after: profileAudit(account) });
      return entity(account);
    });
  }

  async createDestination(input, ctx) {
    editorialInput(input, ["platformId", "accountId", "kind", "name", "locator", "visibility"]);
    const platform = platformById(input.platformId);
    if (!DESTINATION_KINDS.has(input.kind)) throw new ApiError(400, "INVALID_DESTINATION", "目的地类型无效。");
    if (!VISIBILITIES.has(input.visibility ?? "unverified")) throw new ApiError(400, "INVALID_DESTINATION", "目的地可见性无效。");
    if ((input.kind === "owned_origin") !== (platform.kind === "owned_site")) throw new PolicyError("DESTINATION_KIND_MISMATCH", "官网与外部账号目的地类型不一致。");
    if (platform.id === "discord" && input.kind !== "community_channel") throw new PolicyError("DESTINATION_KIND_MISMATCH", "Discord 必须明确服务器和频道。");
    if (platform.id === "reddit" && input.kind !== "community") throw new PolicyError("DESTINATION_KIND_MISMATCH", "Reddit 必须明确目标社区。");
    if (platform.kind === "technical_artifact" && !["repository", "artifact_repository"].includes(input.kind)) throw new PolicyError("DESTINATION_KIND_MISMATCH", "技术作品平台必须明确仓库或作品目的地。");
    const locator = destinationLocator(input.kind, input.locator, this.publicOrigin);
    const name = editorialText(input.name, "name", 240);
    return this.#write("destination_created", input, ctx, (state, { now, payload }) => {
      const account = input.accountId ? record(state.accounts, input.accountId, "ACCOUNT_NOT_FOUND") : null;
      if (platform.kind !== "owned_site" && (!account || account.platformId !== platform.id)) throw new PolicyError("DESTINATION_ACCOUNT_MISMATCH", "目的地必须绑定该平台的真实账号。");
      if (platform.kind === "owned_site" && account) throw new PolicyError("DESTINATION_ACCOUNT_MISMATCH", "自有官网不绑定社媒账号。");
      if (state.destinations.some(row => row.platformId === platform.id && row.accountId === (account?.id ?? null) && hashObject(row.locator) === hashObject(locator))) {
        throw new ApiError(409, "DUPLICATE_DESTINATION", "此目的地已经登记。");
      }
      const row = { id: nextId("DST", state.destinations), platformId: platform.id, accountId: account?.id ?? null,
        kind: input.kind, name, locator, visibility: input.visibility ?? "unverified", status: "draft", identityVersion: 1,
        identityReview: { status: "unverified" }, policyStatus: "manual_review_required", policyCheckedAt: null,
        revision: 1, createdAt: now.toISOString(), updatedAt: now.toISOString() };
      state.destinations.push(row); payload.destinationId = row.id; return entity(row);
    });
  }

  async updateDestination(id, input, ctx) {
    editorialInput(input, ["name", "locator", "status", "visibility", "identityConfirmed", "policyStatus", "policyCheckedAt", "reviewNote", "reason"]);
    if (input.status !== undefined && !ACCOUNT_STATUSES.has(input.status)) throw new ApiError(400, "INVALID_DESTINATION_STATUS", "目的地状态无效。");
    if (input.visibility !== undefined && !VISIBILITIES.has(input.visibility)) throw new ApiError(400, "INVALID_DESTINATION", "目的地可见性无效。");
    if (input.policyStatus !== undefined && !POLICIES.has(input.policyStatus)) throw new ApiError(400, "INVALID_POLICY_STATUS", "规则审阅状态无效。");
    if (input.identityConfirmed !== undefined && typeof input.identityConfirmed !== "boolean") throw new ApiError(400, "INVALID_INPUT", "身份确认必须是布尔值。");
    return this.#write(`destination_updated:${id}`, input, ctx, (state, { actor, ifMatch, now, payload }) => {
      const row = record(state.destinations, id, "DESTINATION_NOT_FOUND"); assertMatch(row, ifMatch);
      const locator = input.locator === undefined ? row.locator : destinationLocator(row.kind, input.locator, this.publicOrigin);
      const visibility = input.visibility ?? row.visibility;
      if ((hashObject(locator) !== hashObject(row.locator) || visibility !== row.visibility || ["paused", "archived"].includes(input.status)) &&
          (state.accountOperations ?? []).some(operation => operation.destinationId === id && operation.status === "in_progress")) {
        throw new ApiError(409, "DESTINATION_RECONCILIATION_REQUIRED", "目的地尚有结果未确定的动作，先按原快照回读并登记结果。");
      }
      if (hashObject(locator) !== hashObject(row.locator) || visibility !== row.visibility) {
        row.identityVersion += 1; row.identityReview = { status: "unverified" }; row.policyStatus = "manual_review_required";
      }
      row.locator = locator; row.visibility = visibility;
      if (input.name !== undefined) row.name = editorialText(input.name, "name", 240);
      if (input.identityConfirmed === true || input.policyStatus === "reviewed") {
        const note = editorialText(input.reviewNote, "reviewNote", 2000);
        if (input.identityConfirmed === true) {
          destinationLocator(row.kind, row.locator, this.publicOrigin);
          row.identityReview = { status: "verified", reviewedBy: actor, reviewedAt: now.toISOString(), note };
        }
        if (input.policyStatus === "reviewed") row.policyReviewNote = note;
      }
      if (input.identityConfirmed === false) row.identityReview = { status: "unverified" };
      if (input.policyStatus !== undefined) row.policyStatus = input.policyStatus;
      if (input.policyCheckedAt !== undefined) row.policyCheckedAt = timestamp(input.policyCheckedAt, "policyCheckedAt", now);
      if (input.policyStatus === "reviewed") {
        if (!row.policyCheckedAt) throw new ApiError(400, "POLICY_REVIEW_TIME_REQUIRED", "目的地规则审阅必须记录时间。");
        row.policyReviewedBy = actor;
      }
      if (["paused", "archived"].includes(input.status)) payload.reason = editorialText(input.reason, "reason", 2000);
      if (input.status !== undefined) row.status = input.status;
      if (row.status === "active" && (row.identityReview?.status !== "verified" || row.policyStatus !== "reviewed" || !row.policyCheckedAt)) {
        throw new PolicyError("DESTINATION_NOT_READY", "启用目的地前必须完成身份和规则审阅。");
      }
      if (row.kind === "owned_origin" && row.status === "active" && row.visibility !== "public") throw new PolicyError("PUBLIC_DESTINATION_REQUIRED", "官网发布目的地必须明确为公开。");
      row.revision += 1; row.updatedAt = now.toISOString(); payload.destinationId = id; return entity(row);
    });
  }

  async createStory(input, ctx) {
    editorialInput(input, ["workingTitle", "claimIds", "topicIds"]);
    const workingTitle = editorialText(input.workingTitle, "workingTitle", 240);
    const ids = stringArray(input.claimIds ?? [], "claimIds");
    const topics = stringArray(input.topicIds ?? [], "topicIds");
    return this.#write("story_created", input, ctx, (state, { actor, now, payload }) => {
      claimBindings(state, ids);
      const row = { id: nextId("STY", state.stories), workingTitle, claimIds: ids, topicIds: topics,
        owner: actor, status: "draft", revision: 1, createdAt: now.toISOString(), updatedAt: now.toISOString() };
      state.stories.push(row); payload.storyId = row.id; return entity(row);
    });
  }

  async updateStory(id, input, ctx) {
    editorialInput(input, ["workingTitle", "status", "reason"]);
    if (input.status !== undefined && !["draft", "active", "archived"].includes(input.status)) throw new ApiError(400, "INVALID_STORY_STATUS", "选题状态无效。");
    return this.#write(`story_updated:${id}`, input, ctx, (state, { ifMatch, now, payload }) => {
      const row = record(state.stories, id, "STORY_NOT_FOUND"); assertMatch(row, ifMatch);
      if (input.workingTitle !== undefined) row.workingTitle = editorialText(input.workingTitle, "workingTitle", 240);
      if (input.status === "archived") payload.reason = editorialText(input.reason, "reason", 2000);
      if (input.status !== undefined) row.status = input.status;
      row.revision += 1; row.updatedAt = now.toISOString(); payload.storyId = id; return entity(row);
    });
  }

  async createEdition(storyId, input, ctx) {
    editorialInput(input, ["locale", "format", "title", "summary", "body", "blocks", "claimIds", "assetRefs", "sourceEditionId", "supersedesEditionId"]);
    assertLocaleFormat(input.locale, input.format);
    const title = editorialText(input.title, "title", 240), body = editorialText(input.body, "body", 50_000, { preserve: true });
    const summary = editorialText(input.summary ?? "", "summary", 2000, { empty: true });
    const ids = stringArray(input.claimIds ?? [], "claimIds");
    const refs = normalizeEditorialAssetRefs(input.assetRefs ?? [], input.locale);
    const blocks = normalizeEditorialBlocks(input.blocks, body, refs);
    return this.#write(`edition_created:${storyId}`, input, ctx, (state, { actor, ifMatch, now, payload }) => {
      const story = record(state.stories, storyId, "STORY_NOT_FOUND"); assertMatch(story, ifMatch);
      if (story.status === "archived") throw new PolicyError("STORY_ARCHIVED", "归档选题不能继续创建修订。");
      const familyId = `${storyId}-${input.locale}-${input.format}`;
      const previous = state.editions.filter(row => row.familyId === familyId).sort((a, b) => b.editorialRevision - a.editorialRevision)[0];
      if (previous && input.supersedesEditionId !== previous.id) throw new ApiError(409, "EDITION_REVISION_REQUIRED", "同语言与形式已有版本，请明确基于最新修订建立新版本。");
      if (!previous && input.supersedesEditionId) throw new ApiError(409, "EDITION_REVISION_MISMATCH", "不存在可替代的来源修订。");
      let sourceEditionId = null;
      if (input.sourceEditionId) {
        const source = record(state.editions, input.sourceEditionId, "EDITION_NOT_FOUND");
        if (source.storyId !== storyId || source.format !== input.format || source.locale === input.locale) throw new PolicyError("TRANSLATION_SOURCE_MISMATCH", "翻译来源必须是同选题同形式的另一语言修订。");
        sourceEditionId = source.id;
      }
      assertEditorialAssets(state, refs);
      const row = { id: nextId("ED", state.editions), familyId, storyId, locale: input.locale, format: input.format,
        editorialRevision: (previous?.editorialRevision ?? 0) + 1, supersedesEditionId: previous?.id ?? null,
        sourceEditionId, title, summary, body, blocks, claimIds: ids, claimBindings: claimBindings(state, ids), assetRefs: refs,
        snapshotSchema: EDITORIAL_SCHEMA, createdBy: actor, createdAt: now.toISOString() };
      row.snapshotHash = hashObject(editorialEditionSnapshot(row)); state.editions.push(row);
      story.revision += 1; story.updatedAt = now.toISOString(); payload.storyId = storyId; payload.editionId = row.id;
      return this.#editionEntity(state, row);
    });
  }

  async createVariant(editionId, input, ctx) {
    editorialInput(input, ["destinationId", "title", "summary", "body", "blocks", "assetRefs", "adaptationNote", "supersedesContentId"]);
    return this.#write(`variant_created:${editionId}`, input, ctx, (state, { actor, ifMatch, now, payload }) => {
      const edition = record(state.editions, editionId, "EDITION_NOT_FOUND"); assertMatch(edition, ifMatch);
      if (edition.snapshotSchema === EDITORIAL_NATIVE_EDITION_SCHEMA) throw new PolicyError("NATIVE_CANDIDATE_REQUIRED", "自动派生的中立形式稿须通过完整原生候选与独立终检形成渠道稿。");
      if (hashObject(editorialEditionSnapshot(edition)) !== edition.snapshotHash) throw new PolicyError("EDITORIAL_EDITION_CHANGED", "来源修订摘要不一致。");
      const story = record(state.stories, edition.storyId, "STORY_NOT_FOUND");
      if (story.status === "archived") throw new PolicyError("STORY_ARCHIVED", "归档选题不能继续创建渠道稿。");
      const destination = record(state.destinations, input.destinationId, "DESTINATION_NOT_FOUND");
      if (destination.status === "archived") throw new PolicyError("DESTINATION_ARCHIVED", "目的地已归档。");
      const account = destination.accountId ? record(state.accounts, destination.accountId, "ACCOUNT_NOT_FOUND") : null;
      const refs = input.assetRefs === undefined ? structuredClone(edition.assetRefs) : normalizeEditorialAssetRefs(input.assetRefs, edition.locale);
      const body = input.body === undefined ? edition.body : editorialText(input.body, "body", 50_000, { preserve: true });
      const blocks = input.blocks === undefined && input.body === undefined && input.assetRefs === undefined
        ? structuredClone(edition.blocks) : normalizeEditorialBlocks(input.blocks, body, refs);
      assertEditorialAssets(state, refs);
      if (input.supersedesContentId) {
        const previous = record(state.content, input.supersedesContentId, "CONTENT_NOT_FOUND");
        if (previous.storyId !== edition.storyId || previous.destinationId !== destination.id || previous.locale !== edition.locale || previous.format !== edition.format) {
          throw new PolicyError("VARIANT_REVISION_MISMATCH", "替代稿必须属于相同选题、语言、形式和目的地。");
        }
      }
      const row = { id: nextId("CNT", state.content), title: input.title === undefined ? edition.title : editorialText(input.title, "title", 240),
        summary: input.summary === undefined ? edition.summary : editorialText(input.summary, "summary", 2000, { empty: true }),
        body, blocks, contentType: edition.format, claimIds: [...edition.claimIds], claimBindings: structuredClone(edition.claimBindings),
        platforms: [account?.platform ?? "个人官网"], owner: actor, opinion: false, visibility: "private",
        status: "draft", version: 1, approval: null, storyId: edition.storyId, editionId,
        editionHash: edition.snapshotHash, locale: edition.locale, format: edition.format, destinationId: destination.id,
        destinationSnapshot: destinationEditorialIdentity(destination), accountSnapshot: account ? accountEditorialIdentity(account) : null,
        assetRefs: refs, snapshotSchema: EDITORIAL_SCHEMA, supersedesContentId: input.supersedesContentId ?? null,
        adaptationNote: editorialText(input.adaptationNote ?? "", "adaptationNote", 2000, { empty: true }),
        createdAt: now.toISOString(), updatedAt: now.toISOString() };
      editorialInput({ title: row.title, body: row.body, summary: row.summary, blocks: row.blocks }, ["title", "body", "summary", "blocks"]);
      row.snapshotHash = hashObject(editorialVariantSnapshot(row)); row.snapshotHashV2 = row.snapshotHash;
      state.content.push(row); payload.contentId = row.id; payload.editionId = editionId; return entity(row);
    });
  }

  async materializeCandidate(candidateId, input, ctx) {
    editorialInput(input, ["packageHash", "qualityReportHashes", "reviewSnapshotHash"]);
    if (!["local", "session"].includes(ctx?.method)) throw new ApiError(403, "AGENT_SCOPE_DENIED", "原生包建稿仅允许管理员。");
    const initial = this.#state(), initialCandidate = record(initial.nativeCandidatePackages, candidateId, "CANDIDATE_NOT_FOUND");
    const keyHash = hashObject({ actor: ctx.actor, scope: `native_materialized:${candidateId}`, key: ctx.idempotencyKey });
    if (!initial.editorialRequests.some(request => request.keyHash === keyHash) && initialCandidate.package.artifactRefs.length) {
      if (typeof this.productionArtifacts?.verifyReferences !== "function") throw new ApiError(503, "NATIVE_ARTIFACT_VERIFICATION_UNAVAILABLE", "原生包建稿前必须核对真实附件字节。");
      await this.productionArtifacts.verifyReferences(initialCandidate.package.artifactRefs);
    }
    return this.#write(`native_materialized:${candidateId}`, input, ctx, (state, { actor, ifMatch, now, payload }) => {
      const candidate = record(state.nativeCandidatePackages, candidateId, "CANDIDATE_NOT_FOUND"); assertMatch(candidate, ifMatch);
      const review = validateCandidateForReview(state, candidateId, { ...input, now });
      const pkg = review.package, story = record(state.stories, pkg.storyId, "STORY_NOT_FOUND");
      if (story.status === "archived") throw new PolicyError("STORY_ARCHIVED", "归档选题不能创建新渠道稿。");
      const effectKey = hashObject({ candidateId, packageHash: pkg.packageHash, reviewSnapshotHash: review.reviewSnapshotHash });
      const previous = state.draftMaterializations.find(row => row.effectKey === effectKey);
      if (previous) return entity(record(state.content, previous.contentId, "CONTENT_NOT_FOUND"));
      const destination = record(state.destinations, pkg.destinationIdentitySnapshot?.id, "DESTINATION_NOT_FOUND");
      const account = destination.accountId ? record(state.accounts, destination.accountId, "ACCOUNT_NOT_FOUND") : null;
      assertLocaleFormat(pkg.locale, pkg.editorialFormat);
      const title = editorialText(pkg.title, "title", 240), body = editorialText(pkg.body, "body", 50_000, { preserve: true });
      const summary = editorialText(pkg.summary, "summary", 2000, { empty: true });
      const refs = normalizeEditorialAssetRefs(pkg.orderedMediaRefs, pkg.locale), blocks = normalizeEditorialBlocks(pkg.orderedBlocks, body, refs);
      if (hashObject(refs) !== hashObject(pkg.orderedMediaRefs) || hashObject(blocks) !== hashObject(pkg.orderedBlocks)) throw new PolicyError("NATIVE_PACKAGE_INVALID", "原生包正文块或媒体引用尚未符合编辑合同。");
      assertEditorialAssets(state, refs, { reviewed: true });
      const sourceEditions = pkg.sourceEditionRefs.map(ref => {
        const source = record(state.editions, ref.id, "EDITION_NOT_FOUND");
        if (source.storyId !== story.id || source.snapshotHash !== ref.sha256 || source.editorialRevision !== ref.revision) throw new PolicyError("SOURCE_OUTDATED", "中立母版来源与冻结版本不一致。");
        return source;
      });
      let edition;
      const compatible = sourceEditions.filter(source => source.locale === pkg.locale && source.format === pkg.editorialFormat);
      if (compatible.length > 1) throw new PolicyError("AMBIGUOUS_MOTHER_EDITION", "同一语言与形式有多个母版修订，请明确唯一来源后重建计划。");
      if (compatible.length === 1) edition = compatible[0];
      else {
        const transform = candidate.neutralTransformRef;
        if (!transform || !/^[a-f0-9]{64}$/.test(transform.formatTransformKey ?? "") || !/^[a-f0-9]{64}$/.test(transform.transformSpecHash ?? "") || !Object.hasOwn(transform, "expectedFamilyHeadId")) throw new PolicyError("FORMAT_TRANSFORM_REQUIRED", "跨语言或跨形式须有已完成的中立转换任务与族版本快照。");
        const task = state.productionTaskBlueprints.find(task => task.taskId === transform.taskId && task.kind === "format.transform" && task.jobId === candidate.jobId);
        const attempt = state.productionTaskAttempts.find(attempt => attempt.taskId === task?.taskId && attempt.status === "succeeded");
        const neutral = attempt?.resultManifest?.data;
        if (!task || !neutral || neutral.locale !== pkg.locale || neutral.format !== pkg.editorialFormat) throw new PolicyError("FORMAT_TRANSFORM_REQUIRED", "中立转换没有准确语言、形式与真实成功回执。");
        const familyId = `${story.id}-${pkg.locale}-${pkg.editorialFormat}`;
        const head = state.editions.filter(row => row.familyId === familyId).sort((a, b) => b.editorialRevision - a.editorialRevision)[0];
        const lineage = { schema: "pengmanager.format-lineage/v1", derivedFromEditionRefs: structuredClone(pkg.sourceEditionRefs),
          transformKind: transform.transformKind, transformSpecHash: transform.transformSpecHash };
        if (!["cross_format", "cross_language", "cross_format_and_language"].includes(lineage.transformKind)) throw new PolicyError("FORMAT_TRANSFORM_REQUIRED", "中立转换类型不完整。");
        lineage.lineageHash = hashObject(lineage);
        if (pkg.lineageHash !== lineage.lineageHash) throw new PolicyError("NATIVE_PACKAGE_CHANGED", "最终包与中立派生谱系不一致。");
        if (head?.formatTransformKey === transform.formatTransformKey && head.formatLineage?.lineageHash === lineage.lineageHash) edition = head;
        else {
          if ((head?.id ?? null) !== transform.expectedFamilyHeadId) throw new ApiError(409, "EDITION_FAMILY_CHANGED", "该形式的最新中立修订已变化；保留人工版本并重新核对计划。");
          const neutralTitle = editorialText(neutral.title, "neutral.title", 240), neutralBody = editorialText(neutral.body, "neutral.body", 50_000, { preserve: true });
          const neutralBlocks = normalizeEditorialBlocks(neutral.blocks, neutralBody, []);
          edition = { id: nextId("ED", state.editions), familyId, storyId: story.id, locale: pkg.locale, format: pkg.editorialFormat,
            editorialRevision: (head?.editorialRevision ?? 0) + 1, supersedesEditionId: head?.id ?? null,
            sourceEditionId: lineage.transformKind === "cross_language" && sourceEditions.length === 1 ? sourceEditions[0].id : null,
            title: neutralTitle, summary: editorialText(neutral.summary ?? "", "neutral.summary", 2000, { empty: true }), body: neutralBody,
            blocks: neutralBlocks, claimIds: pkg.sourceClaimBindings.map(binding => binding.claimId),
            claimBindings: pkg.sourceClaimBindings.map(binding => ({ claimId: binding.claimId, hash: binding.fingerprint ?? binding.hash })), assetRefs: [],
            snapshotSchema: EDITORIAL_NATIVE_EDITION_SCHEMA, formatLineage: lineage, formatTransformKey: transform.formatTransformKey,
            createdBy: actor, createdAt: now.toISOString() };
          edition.snapshotHash = hashObject(editorialEditionSnapshot(edition)); state.editions.push(edition);
          state.formatLineage.push({ id: `LIN-${hashObject({ editionId: edition.id, lineage }).slice(0, 24)}`, formatEditionId: edition.id, ...lineage });
        }
      }
      const row = { id: nextId("CNT", state.content), title, summary, body, blocks, contentType: pkg.editorialFormat,
        claimIds: pkg.sourceClaimBindings.map(binding => binding.claimId),
        claimBindings: pkg.sourceClaimBindings.map(binding => ({ claimId: binding.claimId, hash: binding.fingerprint ?? binding.hash })),
        platforms: [account?.platform ?? "个人官网"], owner: actor, opinion: false, visibility: "private", status: "draft", version: 1,
        approval: null, storyId: story.id, editionId: edition.id, editionHash: edition.snapshotHash, locale: pkg.locale, format: pkg.editorialFormat,
        destinationId: destination.id, destinationSnapshot: structuredClone(pkg.destinationIdentitySnapshot), accountSnapshot: structuredClone(pkg.accountIdentitySnapshot),
        assetRefs: refs, snapshotSchema: EDITORIAL_NATIVE_SCHEMA, supersedesContentId: null, adaptationNote: "来自受控平台准备工单；独立终检完成，等待完整人工审核。",
        candidateId, publicationPackage: structuredClone(pkg), packageHash: pkg.packageHash, qualityReportHashes: [...review.envelope.qualityReportHashes],
        reviewEnvelope: structuredClone(review.envelope), reviewSnapshotHash: review.reviewSnapshotHash, createdAt: now.toISOString(), updatedAt: now.toISOString() };
      row.snapshotHash = hashObject(editorialVariantSnapshot(row));
      validateEditorialVariant(state, row, account, { now, requireReady: true });
      state.content.push(row);
      state.draftMaterializations.push({ id: `MAT-${effectKey.slice(0, 24)}`, effectKey, candidateId, packageHash: pkg.packageHash,
        reviewSnapshotHash: review.reviewSnapshotHash, editionId: edition.id, contentId: row.id, createdBy: actor, createdAt: now.toISOString() });
      Object.assign(payload, { candidateId, packageHash: pkg.packageHash, reviewSnapshotHash: review.reviewSnapshotHash, contentId: row.id, editionId: edition.id });
      return entity(row);
    });
  }

  async transitionVariant(id, input, ctx) {
    editorialInput(input, ["target", "note", "reviewed", "snapshotHash", "reviewSnapshotHash"]);
    if (!["local", "session"].includes(ctx?.method)) throw new ApiError(403, "AGENT_SCOPE_DENIED", "编辑审核与排期仅允许管理员。");
    if (["approved", "scheduled"].includes(input.target)) {
      const state = this.#state(), row = record(state.content, id, "CONTENT_NOT_FOUND");
      const previousKey = ctx && hashObject({ actor: ctx.actor, scope: `variant_transitioned:${id}`, key: ctx.idempotencyKey });
      if (row.snapshotSchema === EDITORIAL_NATIVE_SCHEMA && !state.editorialRequests.some(request => request.keyHash === previousKey)) {
        if (typeof this.productionArtifacts?.verifyReferences !== "function") throw new ApiError(503, "NATIVE_ARTIFACT_VERIFICATION_UNAVAILABLE", "原生稿批准前必须核对真实附件字节。");
        await this.productionArtifacts.verifyReferences(row.publicationPackage.artifactRefs);
        if (row.assetRefs.length) {
          if (typeof this.mediaAssets?.verifyForRelease !== "function") throw new ApiError(503, "MEDIA_VERIFICATION_UNAVAILABLE", "原生稿批准前必须核对真实媒体。");
          await this.mediaAssets.verifyForRelease(row.assetRefs);
        }
      }
    }
    const result = await this.#write(`variant_transitioned:${id}`, input, ctx, (state, { actor, ifMatch, now, payload }) => {
      const row = record(state.content, id, "CONTENT_NOT_FOUND"); assertMatch(row, ifMatch);
      if (!isEditorialVariantSchema(row.snapshotSchema)) throw new ApiError(409, "EDITORIAL_SCHEMA_UNSUPPORTED", "内容不是受支持的编辑版本。");
      validateEditorialVariant(state, row, null, { now, requireReady: ["approved", "scheduled"].includes(input.target), requireApproval: input.target === "scheduled" });
      if (input.target === "approved" && (input.reviewed !== true || input.snapshotHash !== row.snapshotHash ||
          row.snapshotSchema === EDITORIAL_NATIVE_SCHEMA && input.reviewSnapshotHash !== row.reviewSnapshotHash)) {
        throw new PolicyError("EXACT_EDITORIAL_REVIEW_REQUIRED", "批准前必须完整核对并确认这一正文与媒体快照。");
      }
      if (["draft", "blocked", "archived"].includes(input.target) && state.websiteRoutes.some(route => state.websiteReleases.find(release => release.id === route.activeReleaseId)?.contentId === id)) {
        throw new PolicyError("ACTIVE_RELEASE_WITHDRAWAL_REQUIRED", "先撤回正在公开的版本，不能直接改变其正文状态。");
      }
      const next = transitionContent(row, input.target, { approvedBy: actor, note: input.note }, { now });
      if (input.target === "approved") next.approval = { ...next.approval, snapshotSchema: row.snapshotSchema, snapshotHash: row.snapshotHash, reviewed: true,
        ...(row.snapshotSchema === EDITORIAL_NATIVE_SCHEMA ? { packageHash: row.packageHash, reviewSnapshotHash: row.reviewSnapshotHash } : {}) };
      else if (["draft", "blocked", "archived"].includes(input.target)) next.approval = null;
      state.content[state.content.findIndex(item => item.id === id)] = next; payload.contentId = id; payload.target = input.target;
      return entity(next);
    });
    const finalBackup = await this.geoService?.backupFinalContent(result);
    return finalBackup ? { ...result, finalBackup } : result;
  }

  #validatePublicCandidate(state, release, { now = this.clock(), checkLive = false } = {}) {
    if (!releaseSnapshotValid(release)) throw new PolicyError("PUBLIC_SNAPSHOT_CHANGED", "公开快照与审核版本不一致。");
    const content = record(state.content, release.contentId, "CONTENT_NOT_FOUND");
    const destination = record(state.destinations, content.destinationId, "DESTINATION_NOT_FOUND");
    validateEditorialVariant(state, content, null, { now, requireReady: true, requireApproval: true });
    if (!["approved", "scheduled", "published"].includes(content.status)) throw new PolicyError("CONTENT_NOT_APPROVED", "公开稿尚未批准。");
    if (destination.kind !== "owned_origin" || destination.platformId !== "official-site" || destination.visibility !== "public" || destination.locator.origin !== this.publicOrigin) {
      throw new PolicyError("OWNED_PUBLIC_DESTINATION_REQUIRED", "发布必须使用已核实的本站公开目的地。");
    }
    if (release.publicSnapshot.canonicalUrl !== `${this.publicOrigin}${release.canonicalPath}`) throw new PolicyError("OWNED_ORIGIN_MISMATCH", "官网 origin 与审批快照不一致。");
    if (release.contentSnapshotHash !== content.snapshotHash) throw new PolicyError("PUBLIC_SNAPSHOT_CHANGED", "渠道稿与公开快照不一致。");
    for (const id of content.claimIds) {
      if (!publicEditorialClaim(state.claims.find(claim => claim.id === id), { now })) throw new PolicyError("PUBLIC_CLAIM_REQUIRED", "公开内容只能引用获准公开、未过期、低敏感且有安全公开来源的事实。");
    }
    const sensitive = editorialSensitiveFindings(release.publicSnapshot);
    if (sensitive.length || /(?:file:\/\/|\/Users\/[^\s/]+\/|\/home\/[^\s/]+\/)/i.test(JSON.stringify(release.publicSnapshot))) {
      throw new PolicyError("PUBLIC_CONTENT_SENSITIVE", "公开快照包含敏感资料或本机私有路径。", sensitive);
    }
    if (checkLive && (!release.publicApproval || release.publicApproval.snapshotHash !== release.snapshotHash || !["live_unverified", "published"].includes(release.status))) {
      throw new PolicyError("RELEASE_NOT_PUBLIC", "此修订尚未获准公开或已经撤回。");
    }
    return content;
  }

  async createRelease(input, ctx) {
    editorialInput(input, ["contentId", "slug"]);
    const slug = editorialText(input.slug, "slug", 100);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new ApiError(400, "INVALID_SLUG", "slug 只能使用小写英文字母、数字和单个连字符。");
    return this.#write("release_created", input, ctx, (state, { actor, ifMatch, now, payload }) => {
      const content = record(state.content, input.contentId, "CONTENT_NOT_FOUND"); assertMatch(content, ifMatch);
      if (state.websiteReleases.some(row => row.contentId === content.id)) throw new ApiError(409, "RELEASE_EXISTS", "此渠道稿已有官网修订，请复用现有记录。");
      if (!isEditorialVariantSchema(content.snapshotSchema)) throw new PolicyError("EDITORIAL_VARIANT_REQUIRED", "官网只发布独立审核的编辑渠道稿。");
      if (content.snapshotSchema === EDITORIAL_NATIVE_SCHEMA && content.publicationPackage.nativeForm !== content.format) throw new PolicyError("WEBSITE_NATIVE_FORM_UNSUPPORTED", "官网页面只承载 article、image_text 和 video 原生包；其他形式请按准确目的地单独交付。");
      const canonicalPath = `/${LANGUAGES[content.locale]}/${SECTIONS[content.format]}/${slug}`;
      const existingFamily = state.websiteReleases.find(row => row.storyId === content.storyId && row.locale === content.locale && row.format === content.format);
      if (existingFamily && existingFamily.canonicalPath !== canonicalPath) throw new ApiError(409, "CANONICAL_ROUTE_MISMATCH", "同一语言形式的修订应沿用原正式 URL。");
      const existingRoute = state.websiteRoutes.find(row => row.canonicalPath === canonicalPath);
      if (existingRoute && existingRoute.storyId !== content.storyId) throw new ApiError(409, "CANONICAL_ROUTE_CONFLICT", "此正式 URL 已属于另一选题。");
      const publicSnapshot = { locale: content.locale, format: content.format, title: content.title, summary: content.summary,
        body: content.body, blocks: structuredClone(content.blocks), assetRefs: structuredClone(content.assetRefs),
        claimIds: [...content.claimIds], claimBindings: structuredClone(content.claimBindings), canonicalPath,
        canonicalUrl: `${this.publicOrigin}${canonicalPath}`,
        ...(content.snapshotSchema === EDITORIAL_NATIVE_SCHEMA ? { nativePackageHash: content.packageHash, reviewSnapshotHash: content.reviewSnapshotHash } : {}) };
      const row = { id: nextId("REL", state.websiteReleases), siteId: "official-site", storyId: content.storyId,
        editionId: content.editionId, contentId: content.id, locale: content.locale, format: content.format, slug, canonicalPath,
        contentSnapshotHash: content.snapshotHash, publicSnapshot, snapshotHash: hashObject(publicSnapshot),
        status: "draft", revision: 1, publicApproval: null, receipt: null, activationAt: null,
        previousReleaseId: existingRoute?.activeReleaseId ?? null, withdrawal: null, createdBy: actor,
        createdAt: now.toISOString(), updatedAt: now.toISOString() };
      this.#validatePublicCandidate(state, row, { now }); state.websiteReleases.push(row); payload.releaseId = row.id; return entity(row);
    });
  }

  async approveRelease(id, input, ctx) {
    editorialInput(input, ["reviewed", "snapshotHash", "authorizationNote"]);
    const note = editorialText(input.authorizationNote, "authorizationNote", 2000);
    return this.#write(`release_approved:${id}`, input, ctx, (state, { actor, ifMatch, now, payload }) => {
      const row = record(state.websiteReleases, id, "RELEASE_NOT_FOUND"); assertMatch(row, ifMatch);
      if (row.status !== "draft") throw new ApiError(409, "INVALID_RELEASE_TRANSITION", "只有草稿修订可以批准。");
      if (input.reviewed !== true || input.snapshotHash !== row.snapshotHash) throw new PolicyError("EXACT_PUBLIC_REVIEW_REQUIRED", "必须核对这一语言的完整公开正文、事实来源与媒体快照。");
      this.#validatePublicCandidate(state, row, { now });
      row.publicApproval = { approvedBy: actor, approvedAt: now.toISOString(), authorizationNote: note, snapshotHash: row.snapshotHash, reviewed: true };
      row.status = "approved"; row.revision += 1; row.updatedAt = now.toISOString(); payload.releaseId = id; return entity(row);
    });
  }

  async publishRelease(id, input, ctx) {
    editorialInput(input, ["confirm", "expectedPreviousReleaseId"]);
    if (input.confirm !== true || !Object.hasOwn(input, "expectedPreviousReleaseId") || !(input.expectedPreviousReleaseId === null || typeof input.expectedPreviousReleaseId === "string")) {
      throw new ApiError(400, "RELEASE_CONFIRMATION_REQUIRED", "公开激活必须明确 confirm 与预期前一修订。");
    }
    return this.#write(`release_activated:${id}`, input, ctx, async (state, { actor, ifMatch, now, payload }) => {
      const row = record(state.websiteReleases, id, "RELEASE_NOT_FOUND"); assertMatch(row, ifMatch);
      if (row.status !== "approved" || row.publicApproval?.snapshotHash !== row.snapshotHash) throw new ApiError(409, "INVALID_RELEASE_TRANSITION", "公开激活只接受已精确批准的修订。");
      const content = this.#validatePublicCandidate(state, row, { now });
      if (content.status !== "scheduled") throw new PolicyError("CONTENT_NOT_SCHEDULED", "官网激活前须将渠道稿排入待发布。");
      let route = state.websiteRoutes.find(item => item.canonicalPath === row.canonicalPath);
      if ((route?.activeReleaseId ?? null) !== input.expectedPreviousReleaseId) throw new ApiError(409, "RELEASE_ROUTE_CONFLICT", "正式 URL 的当前修订已变化，请重新核对。");
      if (route && route.storyId !== row.storyId) throw new ApiError(409, "CANONICAL_ROUTE_CONFLICT", "正式 URL 属于其他选题。");
      if (row.publicSnapshot.assetRefs.length) {
        if (typeof this.mediaAssets?.verifyForRelease !== "function") throw new ApiError(503, "MEDIA_VERIFICATION_UNAVAILABLE", "媒体字节验证服务尚未配置。");
        await this.mediaAssets.verifyForRelease(row.publicSnapshot.assetRefs);
      }
      if (typeof this.beforeActivation !== "function") throw new ApiError(503, "EDITORIAL_BACKUP_UNAVAILABLE", "公开激活前必须配置真实完整备份服务。");
      let activationNow;
      {
        const backup = await this.beforeActivation(structuredClone(row), structuredClone(state));
        activationNow = this.clock();
        this.#validatePublicCandidate(state, row, { now: activationNow });
        if (!backup || !/^EDB-[a-f0-9]{32}$/.test(backup.backupId) || backup.stage !== "pre_activation" || backup.releaseId !== row.id ||
            !/^[a-f0-9]{64}$/.test(backup.manifestSha256) || !/^[a-f0-9]{64}$/.test(backup.stateSha256) ||
            !Number.isSafeInteger(backup.assetCount) || backup.assetCount < 0 ||
            !Number.isSafeInteger(backup.totalBytes) || backup.totalBytes < 0) {
          throw new ApiError(503, "EDITORIAL_BACKUP_INVALID_RECEIPT", "发布前完整备份没有返回有效的校验回执。");
        }
        row.activationBackup = { backupId: backup.backupId, manifestSha256: backup.manifestSha256,
          stateSha256: backup.stateSha256, assetCount: backup.assetCount, totalBytes: backup.totalBytes,
          createdAt: timestamp(backup.createdAt, "backup.createdAt", activationNow), stage: "pre_activation" };
      }
      if (!route) {
        route = { id: nextId("RTE", state.websiteRoutes), siteId: "official-site", storyId: row.storyId,
          locale: row.locale, format: row.format, slug: row.slug, canonicalPath: row.canonicalPath,
          activeReleaseId: null, revision: 0, createdAt: activationNow.toISOString() }; state.websiteRoutes.push(route);
      }
      row.previousReleaseId = route.activeReleaseId; route.activeReleaseId = id; route.revision += 1;
      route.updatedAt = activationNow.toISOString(); route.withdrawnAt = null;
      row.status = "live_unverified"; row.activationAt = activationNow.toISOString(); row.activatedBy = actor;
      row.revision += 1; row.updatedAt = activationNow.toISOString(); payload.releaseId = id; payload.snapshotHash = row.snapshotHash;
      return entity(row);
    });
  }

  async verifyRelease(id, input, ctx) {
    editorialInput(input, ["confirm"]);
    if (input.confirm !== true) throw new ApiError(400, "READBACK_CONFIRMATION_REQUIRED", "必须明确请求真实官网回读。");
    const result = await this.#write(`release_verified:${id}`, input, ctx, async (state, { actor, ifMatch, now, payload }) => {
      const row = record(state.websiteReleases, id, "RELEASE_NOT_FOUND"); assertMatch(row, ifMatch);
      if (row.status !== "live_unverified") throw new ApiError(409, "INVALID_RELEASE_TRANSITION", "只有已激活且未验证的修订可入账。");
      const route = state.websiteRoutes.find(item => item.activeReleaseId === id);
      if (!route) throw new PolicyError("RELEASE_NOT_CURRENT", "修订已不是该正式 URL 的当前版本。");
      this.#validatePublicCandidate(state, row, { now, checkLive: true });
      if (typeof this.verifyReadback !== "function") throw new ApiError(503, "WEBSITE_READBACK_UNAVAILABLE", "真实官网回读校验器尚未配置。");
      const expected = this.#publicDto(state, row);
      const proof = await this.verifyReadback(structuredClone(expected));
      const verifiedNow = this.clock();
      this.#validatePublicCandidate(state, row, { now: verifiedNow, checkLive: true });
      const assets = [...new Map(expected.assets.map(asset => [`${asset.assetId}:${asset.sha256}`, { assetId: asset.assetId, sha256: asset.sha256 }])).values()]
        .sort((a, b) => a.assetId.localeCompare(b.assetId));
      if (!proof || proof.releaseId !== id || proof.snapshotHash !== row.snapshotHash || proof.canonicalUrl !== expected.canonicalUrl ||
          proof.method !== "server_readback" || !Array.isArray(proof.assetHashes) ||
          hashObject([...proof.assetHashes].sort((a, b) => String(a.assetId).localeCompare(String(b.assetId)))) !== hashObject(assets)) {
        throw new PolicyError("WEBSITE_READBACK_MISMATCH", "官网页面、正文快照或媒体字节没有通过真实回读。");
      }
      const verifiedAt = timestamp(proof.verifiedAt, "verifiedAt", verifiedNow);
      if (new Date(verifiedAt).getTime() < new Date(row.activationAt).getTime()) throw new ApiError(400, "READBACK_BEFORE_ACTIVATION", "回读时间不能早于公开激活。");
      row.receipt = { releaseId: id, canonicalUrl: expected.canonicalUrl, snapshotHash: row.snapshotHash,
        dataMode: "real", verificationMethod: "server_readback", publishedAt: row.activationAt,
        verifiedAt, verifiedBy: actor, assetHashes: assets };
      row.receipt.receiptHash = hashObject(row.receipt); row.status = "published"; row.revision += 1; row.updatedAt = verifiedNow.toISOString();
      const content = record(state.content, row.contentId, "CONTENT_NOT_FOUND");
      content.status = "published"; content.version += 1; content.websiteReleaseId = id; content.updatedAt = verifiedNow.toISOString();
      payload.releaseId = id; payload.receiptHash = row.receipt.receiptHash; return entity(row);
    });
    const finalBackup = await this.geoService?.backupFinalContent(this.getVariant(result.contentId));
    return finalBackup ? { ...result, finalBackup } : result;
  }

  async withdrawRelease(id, input, ctx) {
    editorialInput(input, ["reason"]); const reason = editorialText(input.reason, "reason", 2000);
    return this.#write(`release_withdrawn:${id}`, input, ctx, (state, { actor, ifMatch, now, payload }) => {
      const row = record(state.websiteReleases, id, "RELEASE_NOT_FOUND"); assertMatch(row, ifMatch);
      if (!["draft", "approved", "live_unverified", "published"].includes(row.status)) throw new ApiError(409, "INVALID_RELEASE_TRANSITION", "此修订不能再次撤回。");
      const route = state.websiteRoutes.find(item => item.activeReleaseId === id);
      if (route) { route.activeReleaseId = null; route.withdrawnAt = now.toISOString(); route.updatedAt = now.toISOString(); route.revision += 1; }
      row.status = "withdrawn"; row.withdrawal = { by: actor, at: now.toISOString(), reason };
      row.revision += 1; row.updatedAt = now.toISOString(); payload.releaseId = id; return entity(row);
    });
  }

  #eligible(state, release) {
    try { this.#validatePublicCandidate(state, release, { checkLive: true }); return true; }
    catch (error) { if (error instanceof ApiError) return false; throw error; }
  }

  #publicDto(state, release, { privatePreview = false, alternates = true } = {}) {
    const snapshot = release.publicSnapshot;
    const assets = snapshot.assetRefs.map(ref => {
      const asset = record(state.mediaAssets, ref.assetId, "MEDIA_ASSET_NOT_FOUND");
      return { id: asset.id, assetId: asset.id, sha256: ref.sha256,
        url: privatePreview ? `/api/media/assets/${asset.id}/bytes` : `/public-media/${asset.id}/${ref.sha256}`,
        mime: asset.mime, kind: asset.kind, size: asset.size, role: ref.role, alt: ref.alt, caption: ref.caption, locale: ref.locale,
        ...(Number.isSafeInteger(asset.width) ? { width: asset.width } : {}),
        ...(Number.isSafeInteger(asset.height) ? { height: asset.height } : {}),
        ...(Number.isFinite(asset.durationMs) ? { durationMs: asset.durationMs } : {}) };
    });
    const peers = {};
    const edition = state.editions.find(row => row.id === release.editionId);
    const sourceEdition = state.editions.find(row => row.id === edition?.sourceEditionId);
    let translationStatus = edition?.sourceEditionId ? "source_revision_linked" : "original";
    if (alternates) {
      for (const route of state.websiteRoutes) {
        const peer = state.websiteReleases.find(row => row.id === route.activeReleaseId);
        if (peer && peer.storyId === release.storyId && peer.format === release.format && this.#eligible(state, peer)) {
          peers[peer.locale] = peer.publicSnapshot.canonicalUrl;
          const peerEdition = state.editions.find(row => row.id === peer.editionId);
          if (sourceEdition && peerEdition?.familyId === sourceEdition.familyId && peerEdition.editorialRevision > sourceEdition.editorialRevision) translationStatus = "needs_review";
        }
      }
    }
    const sources = snapshot.claimIds.map(id => publicEditorialClaim(state.claims.find(claim => claim.id === id), { now: this.clock() })).filter(Boolean);
    const dto = { id: release.id, releaseId: release.id, locale: release.locale, format: release.format,
      title: snapshot.title, summary: snapshot.summary, body: snapshot.body, blocks: structuredClone(snapshot.blocks), assets,
      canonicalPath: release.canonicalPath, canonicalUrl: snapshot.canonicalUrl, snapshotHash: release.snapshotHash,
      publishedAt: release.activationAt, updatedAt: release.updatedAt, alternates: peers, sources, translationStatus,
      ...(sourceEdition && peers[sourceEdition.locale] ? { sourceLocale: sourceEdition.locale, sourceCanonicalUrl: peers[sourceEdition.locale] } : {}) };
    return { ...dto, etag: `"${hashObject(dto)}"` };
  }

  previewRelease(id) {
    const state = this.#state(), release = record(state.websiteReleases, id, "RELEASE_NOT_FOUND");
    return { ...this.#publicDto(state, release, { privatePreview: true }), preview: true, releaseStatus: release.status };
  }

  publicDetail({ locale, format, slug } = {}) {
    assertLocaleFormat(locale, format);
    if (typeof slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 100) throw new ApiError(404, "PUBLIC_CONTENT_NOT_FOUND", "内容不存在。");
    const state = this.#state();
    const route = state.websiteRoutes.find(row => row.locale === locale && row.format === format && row.slug === slug);
    if (!route) throw new ApiError(404, "PUBLIC_CONTENT_NOT_FOUND", "内容不存在。");
    const release = state.websiteReleases.find(row => row.id === route.activeReleaseId);
    if (!release || !this.#eligible(state, release)) throw new ApiError(410, "PUBLIC_CONTENT_UNAVAILABLE", "此内容暂不可公开，请稍后查看。");
    return this.#publicDto(state, release);
  }

  publicList({ locale = "zh-CN", format, limit = 20, cursor, q = "" } = {}) {
    if (!EDITORIAL_LOCALES.includes(locale)) throw new ApiError(400, "INVALID_LOCALE", "语言无效。");
    if (format !== undefined && !EDITORIAL_FORMATS.includes(format)) throw new ApiError(400, "INVALID_CONTENT_TYPE", "内容形式无效。");
    const take = Number(limit);
    if (!Number.isInteger(take) || take < 1 || take > 100) throw new ApiError(400, "INVALID_LIMIT", "limit 必须为 1 到 100。");
    const query = editorialText(q, "q", 120, { empty: true });
    const filterHash = hashObject({ locale, format: format ?? null, q: query });
    let after = null;
    if (cursor) {
      try {
        if (typeof cursor !== "string" || cursor.length > 500 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("invalid");
        const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (parsed.filterHash !== filterHash || typeof parsed.after !== "string" || parsed.after.length > 150 || Object.keys(parsed).length !== 2) throw new Error("invalid");
        after = parsed.after;
      } catch { throw new ApiError(400, "INVALID_CURSOR", "分页游标无效，请重新读取列表。"); }
    }
    const state = this.#state();
    const rows = state.websiteRoutes.map(route => state.websiteReleases.find(row => row.id === route.activeReleaseId))
      .filter(row => row && row.locale === locale && (!format || row.format === format) && this.#eligible(state, row) &&
        (!query || `${row.publicSnapshot.title}\n${row.publicSnapshot.summary}\n${row.publicSnapshot.body}`.toLowerCase().includes(query.toLowerCase())))
      .map(row => ({ row, key: `${row.activationAt}\u0000${row.id}` })).sort((a, b) => b.key.localeCompare(a.key));
    const candidates = after ? rows.filter(row => row.key < after) : rows;
    const page = candidates.slice(0, take);
    return { items: page.map(({ row }) => { const { body: _body, blocks: _blocks, ...card } = this.#publicDto(state, row); return card; }),
      total: rows.length, nextCursor: candidates.length > take ? Buffer.from(JSON.stringify({ filterHash, after: page.at(-1).key })).toString("base64url") : null };
  }

  isAssetPublic(assetId, sha256) {
    const state = this.#state();
    return state.websiteRoutes.some(route => {
      const release = state.websiteReleases.find(row => row.id === route.activeReleaseId);
      return release && release.publicSnapshot.assetRefs.some(ref => ref.assetId === assetId && ref.sha256 === sha256) && this.#eligible(state, release);
    });
  }
}

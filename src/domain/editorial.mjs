import { ApiError, PolicyError } from "./errors.mjs";
import { hashObject } from "./hash.mjs";
import { isClaimPubliclyExportable, scanSensitiveText, validateContentForApproval } from "./policy.mjs";
import { requirePublicUrl } from "./public-url.mjs";
import { validateCandidateForReview } from "./content-ops-quality.mjs";

export const EDITORIAL_SCHEMA = "pengmanager.editorial-snapshot/v2";
export const EDITORIAL_NATIVE_SCHEMA = "pengmanager.editorial-variant/v3";
export const EDITORIAL_NATIVE_EDITION_SCHEMA = "pengmanager.editorial-edition/v3";
export const isEditorialVariantSchema = value => [EDITORIAL_SCHEMA, EDITORIAL_NATIVE_SCHEMA].includes(value);
export const isEditorialEditionSchema = value => [EDITORIAL_SCHEMA, EDITORIAL_NATIVE_EDITION_SCHEMA].includes(value);
// A process-local capability cannot be supplied by an HTTP JSON body.
export const EDITORIAL_PUBLICATION_AUTHORIZATION = Symbol("editorial publication authorization");
export const EDITORIAL_LOCALES = Object.freeze(["zh-CN", "en-US"]);
export const EDITORIAL_FORMATS = Object.freeze(["article", "image_text", "video"]);
const SECRET_FIELD = /^(?:cookies?|passwords?|secrets?|(?:access[_-]?)?tokens?|api[_-]?key|authorization|credentials|storage[_-]?state|local[_-]?storage|session[_-]?storage|headers)$/i;
const ASSET_ROLES = new Set(["cover", "image", "video", "poster", "subtitle"]);
const ROLE_KINDS = { cover: "image", image: "image", video: "video", poster: "image", subtitle: "caption" };
const HASH_FIELDS = new Set(["hash", "sha256", "snapshotHash", "editorialSnapshotHash", "approvedSnapshotHash", "contentHash", "manifestSha256", "stateSha256",
  "packageHash", "nativePackageHash", "reviewSnapshotHash", "reportHash", "checkContextHash", "taskHash", "resolvedInputHash", "scopeHash", "pricingSnapshotHash",
  "lineageHash", "authorizationHash", "rightsReviewHash", "privacyReviewHash", "blueprintHash", "compiledBlueprintHash",
  "fingerprint", "checkedPackageHash", "adaptationPlanHash", "planHash", "compileInputHash", "sourceBundleHash", "formatTransformKey", "transformSpecHash"]);
const HASH_ARRAY_FIELDS = new Set(["qualityReportHashes", "rightsReviewHashes", "privacyReviewHashes", "artifactHashes"]);
const LOCATOR_ID_FIELDS = new Set(["serverId", "channelId", "threadId"]);
const CREDENTIAL_PARAMETER = /token|password|secret|cookie|authorization|api[_-]?key|session|signature|credential/i;

// Machine digests can contain a run of digits resembling a phone number. Only
// exact validated digest fields are exempt; prose and malformed digests stay
// visible to the sensitive-text gate.
export function editorialSensitiveFindings(value, { credentialUrls = true } = {}) {
  const serialized = JSON.stringify(value, (key, child) => {
    if (typeof child === "string" && HASH_FIELDS.has(key) && /^[a-f0-9]{64}$/.test(child)) return "[sha256]";
    if (Array.isArray(child) && HASH_ARRAY_FIELDS.has(key) && child.every(item => typeof item === "string" && /^[a-f0-9]{64}$/.test(item))) return child.map(() => "[sha256]");
    if (typeof child === "string" && LOCATOR_ID_FIELDS.has(key) && /^\d{5,30}$/.test(child)) return "[community-id]";
    return child;
  });
  const findings = scanSensitiveText(serialized);
  if (/\b(?:cookie|set-cookie|sessionid|session_id)\s*[:=]\s*\S+/i.test(serialized)) findings.push({ code: "SENSITIVE_CONTENT", kind: "browser_session" });
  if (!credentialUrls) return findings;
  const strings = [];
  const visit = child => {
    if (typeof child === "string") strings.push(child);
    else if (child && typeof child === "object") for (const nested of Object.values(child)) visit(nested);
  };
  visit(value);
  for (const source of strings) {
    let decoded = source;
    for (let count = 0; count < 3; count += 1) {
      try { const next = decodeURIComponent(decoded); if (next === decoded) break; decoded = next; } catch { break; }
    }
    for (const candidate of decoded.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
      let url;
      try { url = new URL(candidate[0]); } catch { continue; }
      if (url.username || url.password || [...url.searchParams.keys()].some(key => CREDENTIAL_PARAMETER.test(key)) ||
          [...candidate[0].matchAll(/[?&#]([A-Za-z0-9_-]+)\s*[:=]/g)].some(match => CREDENTIAL_PARAMETER.test(match[1])) ||
          /https?:\/\/[^/?#\s]+@/i.test(candidate[0]) ||
          [...url.hash.matchAll(/\b([A-Za-z0-9_-]+)\s*[:=]/g)].some(match => CREDENTIAL_PARAMETER.test(match[1]))) {
        findings.push({ code: "SENSITIVE_CONTENT", kind: "credential_url" });
      }
    }
  }
  return findings;
}

export function editorialText(value, field, maximum = 240, { empty = false, preserve = false } = {}) {
  if (typeof value !== "string" || value.length > maximum || (!empty && !value.trim()) ||
      [...value].some(character => { const point = character.codePointAt(0); return point >= 0xD800 && point <= 0xDFFF; })) {
    throw new ApiError(400, "INVALID_INPUT", `${field} 文本无效或超过长度限制。`);
  }
  return preserve ? value : value.trim();
}

export function editorialId(value, field = "id") {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) {
    throw new ApiError(400, "INVALID_INPUT", `${field} 标识符无效。`);
  }
  return value;
}

export function editorialInput(input, allowed) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new ApiError(400, "INVALID_INPUT", "请求必须是普通 JSON 对象。");
  }
  if (Object.keys(input).some(key => !allowed.includes(key))) {
    throw new ApiError(400, "UNKNOWN_FIELD", "请求包含未支持的字段。");
  }
  const seen = new WeakSet();
  const visit = value => {
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) return;
    if (typeof value !== "object" || seen.has(value)) throw new ApiError(400, "INVALID_INPUT", "请求不是有效 JSON 数据。");
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_FIELD.test(key)) throw new ApiError(400, "CREDENTIALS_NOT_ALLOWED", "登录凭据不得写入编辑或运营资料。");
      visit(child);
    }
  };
  visit(input);
  const findings = editorialSensitiveFindings(input);
  if (findings.length) throw new PolicyError("EDITORIAL_SENSITIVE_INPUT", "编辑资料包含敏感信息或凭据。", findings);
  return input;
}

export function editorialEtag(entity) {
  const { etag: _ignored, ...row } = entity;
  return `"${hashObject(row)}"`;
}

export function accountEditorialIdentity(account) {
  return { id: account.id, platform: account.platform, platformId: account.platformId ?? null,
    handle: account.handle, profileUrl: account.profileUrl ?? "", identityVersion: account.identityVersion ?? 1 };
}

export function destinationEditorialIdentity(destination) {
  return { id: destination.id, platformId: destination.platformId, accountId: destination.accountId ?? null,
    kind: destination.kind, locator: destination.locator, visibility: destination.visibility,
    identityVersion: destination.identityVersion };
}

export function claimEditorialFingerprint(claim) {
  return hashObject({ id: claim.id, type: claim.type ?? null, text: claim.text,
    source: claim.source ?? null, evidenceLevel: claim.evidenceLevel ?? null,
    sensitivity: claim.sensitivity ?? null, expiresAt: claim.expiresAt ?? null });
}

export function normalizeEditorialAssetRefs(value = [], locale) {
  if (!Array.isArray(value) || value.length > 64) throw new ApiError(400, "INVALID_ASSET_REFS", "媒体引用必须是最多 64 项的数组。");
  const keys = new Set();
  return value.map(ref => {
    editorialInput(ref, ["assetId", "sha256", "role", "alt", "caption", "locale"]);
    const assetId = editorialId(ref.assetId, "assetId");
    if (typeof ref.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(ref.sha256) || !ASSET_ROLES.has(ref.role)) {
      throw new ApiError(400, "INVALID_ASSET_REFS", "媒体摘要或用途无效。");
    }
    const key = `${assetId}:${ref.role}`;
    if (keys.has(key)) throw new ApiError(400, "DUPLICATE_ASSET_REF", "同一用途的媒体不能重复引用。");
    keys.add(key);
    if (ref.locale !== undefined && (!EDITORIAL_LOCALES.includes(ref.locale) || (ref.role !== "subtitle" && ref.locale !== locale))) {
      throw new ApiError(400, "ASSET_LOCALE_MISMATCH", "媒体说明语言与当前版本不一致。");
    }
    return { assetId, sha256: ref.sha256, role: ref.role,
      alt: editorialText(ref.alt ?? "", "alt", 1000, { empty: !["cover", "image", "poster"].includes(ref.role) }),
      caption: editorialText(ref.caption ?? "", "caption", 2000, { empty: true }), locale: ref.locale ?? locale };
  });
}

export function normalizeEditorialBlocks(value, body, assetRefs) {
  if (value === undefined) return body.split(/\n\s*\n/).filter(text => text.trim()).map(text => ({ type: "paragraph", text }));
  if (!Array.isArray(value) || !value.length || value.length > 1000) {
    throw new ApiError(400, "INVALID_DOCUMENT_BLOCKS", "正文块必须是 1 到 1000 项的数组。");
  }
  const refs = new Map();
  for (const ref of assetRefs) { const existing = refs.get(ref.assetId) ?? []; existing.push(ref); refs.set(ref.assetId, existing); }
  let total = 0;
  const text = (value, field, maximum = 50_000, empty = false) => {
    const result = editorialText(value, field, maximum, { empty, preserve: true }); total += result.length; return result;
  };
  const blocks = value.map(block => {
    if (!block || typeof block !== "object" || Array.isArray(block)) throw new ApiError(400, "INVALID_DOCUMENT_BLOCKS", "正文块无效。");
    switch (block.type) {
      case "paragraph": case "quote":
        editorialInput(block, ["type", "text"]);
        return { type: block.type, text: text(block.text, "block.text") };
      case "heading":
        editorialInput(block, ["type", "text", "level"]);
        if (![2, 3].includes(block.level)) throw new ApiError(400, "INVALID_DOCUMENT_BLOCKS", "标题层级只能为 2 或 3。");
        return { type: "heading", level: block.level, text: text(block.text, "heading", 500) };
      case "list":
        editorialInput(block, ["type", "ordered", "items"]);
        if (typeof block.ordered !== "boolean" || !Array.isArray(block.items) || !block.items.length || block.items.length > 200) {
          throw new ApiError(400, "INVALID_DOCUMENT_BLOCKS", "列表格式无效。");
        }
        return { type: "list", ordered: block.ordered, items: block.items.map(item => text(item, "list.item", 5000)) };
      case "code": {
        editorialInput(block, ["type", "text", "language"]);
        const language = editorialText(block.language ?? "", "language", 40, { empty: true });
        if (language && !/^[A-Za-z0-9_+.-]+$/.test(language)) throw new ApiError(400, "INVALID_DOCUMENT_BLOCKS", "代码语言标识无效。");
        return { type: "code", text: text(block.text, "code"), language };
      }
      case "image": {
        editorialInput(block, ["type", "assetId", "alt", "caption"]);
        const ref = refs.get(editorialId(block.assetId, "assetId"))?.find(item => ["cover", "image", "poster"].includes(item.role));
        if (!ref) throw new ApiError(400, "UNBOUND_DOCUMENT_ASSET", "图片块缺少相应的媒体引用。");
        return { type: "image", assetId: ref.assetId, alt: text(block.alt, "image.alt", 1000), caption: text(block.caption ?? "", "image.caption", 2000, true) };
      }
      case "video": {
        editorialInput(block, ["type", "assetId", "posterAssetId", "caption"]);
        const ref = refs.get(editorialId(block.assetId, "assetId"))?.find(item => item.role === "video");
        if (!ref) throw new ApiError(400, "UNBOUND_DOCUMENT_ASSET", "视频块缺少视频引用。");
        const result = { type: "video", assetId: ref.assetId, caption: text(block.caption ?? "", "video.caption", 2000, true) };
        if (block.posterAssetId !== undefined) {
          const poster = refs.get(editorialId(block.posterAssetId, "posterAssetId"))?.find(item => ["poster", "cover"].includes(item.role));
          if (!poster) throw new ApiError(400, "UNBOUND_DOCUMENT_ASSET", "视频封面缺少引用。");
          result.posterAssetId = poster.assetId;
        }
        return result;
      }
      default: throw new ApiError(400, "INVALID_DOCUMENT_BLOCKS", "不支持此正文块类型。");
    }
  });
  if (total > 100_000) throw new ApiError(400, "DOCUMENT_TOO_LARGE", "正文块总文字超过限制。");
  return blocks;
}

export function editorialEditionSnapshot(edition) {
  const snapshot = { schema: EDITORIAL_SCHEMA, id: edition.id, familyId: edition.familyId, storyId: edition.storyId,
    locale: edition.locale, format: edition.format, editorialRevision: edition.editorialRevision,
    sourceEditionId: edition.sourceEditionId, supersedesEditionId: edition.supersedesEditionId,
    title: edition.title, summary: edition.summary, body: edition.body, blocks: edition.blocks,
    claimIds: edition.claimIds, claimBindings: edition.claimBindings, assetRefs: edition.assetRefs };
  return edition.snapshotSchema === EDITORIAL_NATIVE_EDITION_SCHEMA ? { ...snapshot, schema: EDITORIAL_NATIVE_EDITION_SCHEMA,
    formatLineage: edition.formatLineage, formatTransformKey: edition.formatTransformKey } : snapshot;
}

export function editorialVariantSnapshot(content) {
  const snapshot = { schema: EDITORIAL_SCHEMA, id: content.id, storyId: content.storyId, editionId: content.editionId,
    editionHash: content.editionHash, locale: content.locale, format: content.format,
    title: content.title, summary: content.summary, body: content.body, blocks: content.blocks,
    platforms: content.platforms, opinion: content.opinion,
    claimIds: content.claimIds, claimBindings: content.claimBindings, assetRefs: content.assetRefs,
    destinationSnapshot: content.destinationSnapshot, accountSnapshot: content.accountSnapshot };
  return content.snapshotSchema === EDITORIAL_NATIVE_SCHEMA ? { ...snapshot, schema: EDITORIAL_NATIVE_SCHEMA,
    candidateId: content.candidateId, publicationPackage: content.publicationPackage, packageHash: content.packageHash,
    qualityReportHashes: content.qualityReportHashes, reviewEnvelope: content.reviewEnvelope,
    reviewSnapshotHash: content.reviewSnapshotHash } : snapshot;
}

export function assertEditorialAssets(state, refs, { reviewed = false } = {}) {
  for (const ref of refs) {
    const asset = (state.mediaAssets ?? []).find(row => row.id === ref.assetId);
    if (!asset || asset.sha256 !== ref.sha256 || asset.kind !== ROLE_KINDS[ref.role]) {
      throw new PolicyError("EDITORIAL_ASSET_MISMATCH", "媒体引用不存在、类型不符或摘要发生变化。");
    }
    if (asset.status === "revoked" || (reviewed && (asset.status !== "reviewed" || asset.review?.rightsConfirmed !== true || asset.review?.privacyConfirmed !== true))) {
      throw new PolicyError("EDITORIAL_ASSET_NOT_REVIEWED", "媒体权利或隐私审阅尚未通过，或许可已撤销。");
    }
  }
}

export function validateEditorialVariant(state, content, account, { now = new Date(), requireReady = true, requireApproval = false } = {}) {
  if (!isEditorialVariantSchema(content?.snapshotSchema)) return;
  if (hashObject(editorialVariantSnapshot(content)) !== content.snapshotHash) throw new PolicyError("EDITORIAL_SNAPSHOT_CHANGED", "渠道版本与原快照不一致。");
  if (content.snapshotSchema === EDITORIAL_NATIVE_SCHEMA) {
    const review = validateCandidateForReview(state, content.candidateId, { packageHash: content.packageHash,
      qualityReportHashes: content.qualityReportHashes, reviewSnapshotHash: content.reviewSnapshotHash, now, assertCurrentBindings: requireReady });
    const pkg = review.package;
    if (hashObject(pkg) !== hashObject(content.publicationPackage) || hashObject(review.envelope) !== hashObject(content.reviewEnvelope) ||
        pkg.storyId !== content.storyId || pkg.locale !== content.locale || pkg.editorialFormat !== content.format ||
        pkg.title !== content.title || pkg.summary !== content.summary || pkg.body !== content.body ||
        hashObject(pkg.orderedBlocks) !== hashObject(content.blocks) || hashObject(pkg.orderedMediaRefs) !== hashObject(content.assetRefs) ||
        hashObject(pkg.destinationIdentitySnapshot) !== hashObject(content.destinationSnapshot) || hashObject(pkg.accountIdentitySnapshot) !== hashObject(content.accountSnapshot)) {
      throw new PolicyError("NATIVE_PACKAGE_CHANGED", "渠道稿与已独立终检的完整原生包不一致。");
    }
    if (requireApproval && (content.approval?.reviewSnapshotHash !== content.reviewSnapshotHash || content.approval?.packageHash !== content.packageHash)) {
      throw new PolicyError("EXACT_EDITORIAL_REVIEW_REQUIRED", "原生包缺少准确的完整审核快照批准。");
    }
  }
  const edition = (state.editions ?? []).find(row => row.id === content.editionId);
  if (!edition || hashObject(editorialEditionSnapshot(edition)) !== edition.snapshotHash || edition.snapshotHash !== content.editionHash) {
    throw new PolicyError("EDITORIAL_EDITION_CHANGED", "来源语言修订不存在或发生变化。");
  }
  const destination = (state.destinations ?? []).find(row => row.id === content.destinationId);
  if (!destination || hashObject(destinationEditorialIdentity(destination)) !== hashObject(content.destinationSnapshot)) {
    throw new PolicyError("EDITORIAL_DESTINATION_CHANGED", "发布目的地与原快照不一致。");
  }
  if (requireReady && (destination.status !== "active" || destination.identityReview?.status !== "verified" || destination.policyStatus !== "reviewed")) {
    throw new PolicyError("DESTINATION_NOT_READY", "发布目的地的身份和规则尚未核实。");
  }
  if (destination.accountId) {
    const current = state.accounts.find(row => row.id === destination.accountId);
    if (!current || (account && current.id !== account.id) || hashObject(accountEditorialIdentity(current)) !== hashObject(content.accountSnapshot)) {
      throw new PolicyError("ACCOUNT_IDENTITY_CHANGED", "渠道版本的账号身份发生变化。");
    }
    if (requireReady && (current.status !== "active" || current.identityReview?.status !== "verified" || current.policyStatus !== "reviewed")) {
      throw new PolicyError("ACCOUNT_NOT_READY", "目标账号身份和规则尚未核实。");
    }
  } else if (account) throw new PolicyError("EDITORIAL_TARGET_MISMATCH", "官网版本不能作为外部账号发布。");
  for (const binding of content.claimBindings) {
    const claim = state.claims.find(row => row.id === binding.claimId);
    if (!claim || claimEditorialFingerprint(claim) !== binding.hash) throw new PolicyError("EDITORIAL_CLAIM_CHANGED", "绑定事实或来源发生变化，请建立新修订。");
  }
  if (requireReady) {
    validateContentForApproval(content, state.claims, { now });
    assertEditorialAssets(state, content.assetRefs, { reviewed: true });
    if (content.format === "image_text" && !content.assetRefs.some(ref => ref.role === "image")) {
      throw new PolicyError("GALLERY_ASSET_REQUIRED", "图文版本至少需要一张获准的正文图片。");
    }
    if (content.format === "video" && !content.assetRefs.some(ref => ref.role === "video")) {
      throw new PolicyError("VIDEO_ASSET_REQUIRED", "视频版本必须绑定获准的真实视频文件。");
    }
  }
  if (requireApproval && content.approval?.snapshotHash !== content.snapshotHash) {
    throw new PolicyError("EDITORIAL_APPROVAL_REQUIRED", "渠道版本缺少适用的精确快照审批。");
  }
}

export function publicEditorialClaim(claim, { now = new Date() } = {}) {
  if (!isClaimPubliclyExportable(claim, { now }) || claim.source?.visibility !== "public" || claim.sensitivity !== "low") return null;
  let url;
  try { url = requirePublicUrl(claim.source.url, "claim.source.url", { allowHttp: true }); }
  catch { return null; }
  const label = String(claim.source.label ?? "公开来源").trim().slice(0, 240);
  if (scanSensitiveText(`${label}\n${url}`).length) return null;
  return { id: claim.id, type: claim.type, text: claim.text, source: { label, url, visibility: "public" },
    evidenceLevel: claim.evidenceLevel, expiresAt: claim.expiresAt ?? null };
}

// Startup integrity checks are independent of current publication eligibility:
// expired Claims and revoked assets remain valid history, while ambiguous IDs,
// missing parent links and altered immutable snapshots stop the writer.
export function assertEditorialStateIntegrity(state) {
  if (![2, 3].includes(state.schemaVersion)) return;
  const fail = () => { throw new ApiError(503, "STATE_EDITORIAL_INVALID", "编辑状态的唯一标识、修订引用或不可变快照不完整，停止启动并保留原文件。"); };
  if (!Array.isArray(state.migrations) || !state.migrations.some(row => row.id === "content-platform-v1")) fail();
  const indexes = {};
  for (const key of ["accounts", "claims", "content", "stories", "editions", "destinations", "websiteReleases", "websiteRoutes", "mediaAssets"]) {
    if (!Array.isArray(state[key])) fail();
    const index = new Map();
    for (const row of state[key]) {
      if (!row || typeof row !== "object" || typeof row.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(row.id) || index.has(row.id)) fail();
      index.set(row.id, row);
    }
    indexes[key] = index;
  }
  for (const key of ["editorialRequests", "mediaAssetRequests"]) if (!Array.isArray(state[key])) fail();
  const editionRevisions = new Set();
  for (const row of state.editions) {
    if (!isEditorialEditionSchema(row.snapshotSchema) || !indexes.stories.has(row.storyId) || !EDITORIAL_LOCALES.includes(row.locale) ||
        !EDITORIAL_FORMATS.includes(row.format) || row.familyId !== `${row.storyId}-${row.locale}-${row.format}` ||
        !Number.isSafeInteger(row.editorialRevision) || row.editorialRevision < 1 || !Array.isArray(row.claimIds) || !Array.isArray(row.claimBindings) || !Array.isArray(row.assetRefs)) fail();
    const key = `${row.familyId}:${row.editorialRevision}`;
    if (editionRevisions.has(key) || hashObject(editorialEditionSnapshot(row)) !== row.snapshotHash) fail();
    editionRevisions.add(key);
    if (row.supersedesEditionId) {
      const previous = indexes.editions.get(row.supersedesEditionId);
      if (!previous || previous.familyId !== row.familyId || previous.editorialRevision !== row.editorialRevision - 1) fail();
    } else if (row.editorialRevision !== 1) fail();
    if (row.sourceEditionId) {
      const source = indexes.editions.get(row.sourceEditionId);
      if (!source || source.storyId !== row.storyId || source.locale === row.locale || source.format !== row.format) fail();
    }
    if (row.snapshotSchema === EDITORIAL_NATIVE_EDITION_SCHEMA) {
      const lineage = row.formatLineage;
      if (!lineage || lineage.schema !== "pengmanager.format-lineage/v1" || !Array.isArray(lineage.derivedFromEditionRefs) || !lineage.derivedFromEditionRefs.length ||
          !/^[a-f0-9]{64}$/.test(lineage.transformSpecHash ?? "") || !/^[a-f0-9]{64}$/.test(row.formatTransformKey ?? "")) fail();
      const { lineageHash, ...base } = lineage;
      if (hashObject(base) !== lineageHash) fail();
      for (const ref of lineage.derivedFromEditionRefs) {
        const source = indexes.editions.get(ref.id);
        if (!source || source.id === row.id || source.storyId !== row.storyId || source.snapshotHash !== ref.sha256 || source.editorialRevision !== ref.revision) fail();
      }
    }
    for (const ref of row.assetRefs) if (!indexes.mediaAssets.has(ref.assetId)) fail();
  }
  for (const row of state.destinations) {
    if (row.accountId && (!indexes.accounts.has(row.accountId) || indexes.accounts.get(row.accountId).platformId !== row.platformId)) fail();
  }
  const visitingEditions = new Set(), checkedEditions = new Set();
  const visitEdition = row => {
    if (visitingEditions.has(row.id)) fail();
    if (checkedEditions.has(row.id)) return;
    visitingEditions.add(row.id);
    const parents = [...(row.sourceEditionId ? [row.sourceEditionId] : []), ...(row.formatLineage?.derivedFromEditionRefs ?? []).map(ref => ref.id)];
    for (const parentId of parents) { const parent = indexes.editions.get(parentId); if (!parent) fail(); visitEdition(parent); }
    visitingEditions.delete(row.id); checkedEditions.add(row.id);
  };
  state.editions.forEach(visitEdition);
  for (const row of state.content.filter(item => item.snapshotSchema !== undefined)) {
    const edition = indexes.editions.get(row.editionId), destination = indexes.destinations.get(row.destinationId);
    if (!isEditorialVariantSchema(row.snapshotSchema) || !edition || !destination || !indexes.stories.has(row.storyId) ||
        edition.storyId !== row.storyId || edition.locale !== row.locale || edition.format !== row.format || edition.snapshotHash !== row.editionHash ||
        !Array.isArray(row.assetRefs) || hashObject(editorialVariantSnapshot(row)) !== row.snapshotHash) fail();
    for (const ref of row.assetRefs) if (!indexes.mediaAssets.has(ref.assetId)) fail();
    if (row.snapshotSchema === EDITORIAL_NATIVE_SCHEMA) {
      const candidate = state.nativeCandidatePackages?.find(candidate => candidate.id === row.candidateId);
      if (!candidate || candidate.packageHash !== row.packageHash || hashObject(candidate.package) !== hashObject(row.publicationPackage) ||
          hashObject(row.reviewEnvelope) !== row.reviewSnapshotHash || row.reviewEnvelope.packageHash !== row.packageHash ||
          hashObject(row.reviewEnvelope.qualityReportHashes) !== hashObject(row.qualityReportHashes)) fail();
    }
    if (row.supersedesContentId) {
      const previous = indexes.content.get(row.supersedesContentId);
      if (!previous || previous.storyId !== row.storyId || previous.locale !== row.locale || previous.format !== row.format || previous.destinationId !== row.destinationId) fail();
    }
  }
  const familyPaths = new Map();
  for (const row of state.websiteReleases) {
    const content = indexes.content.get(row.contentId);
    if (!content || !isEditorialVariantSchema(content.snapshotSchema) || content.storyId !== row.storyId || content.editionId !== row.editionId ||
        content.locale !== row.locale || content.format !== row.format || content.snapshotHash !== row.contentSnapshotHash ||
        !row.publicSnapshot || hashObject(row.publicSnapshot) !== row.snapshotHash || row.publicSnapshot.canonicalPath !== row.canonicalPath) fail();
    const key = `${row.storyId}:${row.locale}:${row.format}`;
    if (familyPaths.has(key) && familyPaths.get(key) !== row.canonicalPath) fail();
    familyPaths.set(key, row.canonicalPath);
  }
  const paths = new Set(), families = new Set();
  for (const row of state.websiteRoutes) {
    const key = `${row.storyId}:${row.locale}:${row.format}`;
    if (!indexes.stories.has(row.storyId) || typeof row.canonicalPath !== "string" || paths.has(row.canonicalPath) || families.has(key)) fail();
    paths.add(row.canonicalPath); families.add(key);
    if (row.activeReleaseId !== null) {
      const release = indexes.websiteReleases.get(row.activeReleaseId);
      if (!release || release.canonicalPath !== row.canonicalPath || release.storyId !== row.storyId || release.locale !== row.locale ||
          release.format !== row.format || !["live_unverified", "published"].includes(release.status)) fail();
    }
  }
}

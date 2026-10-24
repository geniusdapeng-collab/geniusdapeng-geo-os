import { DATA_MODES } from "../domain/constants.mjs";
import { ApiError, PolicyError } from "../domain/errors.mjs";
import { hashText, hashObject } from "../domain/hash.mjs";
import {
  classifyInteraction,
  hasNegativeMention,
  isClaimPubliclyExportable,
  scanSensitiveText,
  validateContentForApproval,
  validatePublication,
} from "../domain/policy.mjs";
import { transitionContent } from "../domain/state-machine.mjs";
import { verifyEventChain } from "../storage/json-store.mjs";
import { MAIN_PROFILE, SYSTEM_IDENTITY } from "../domain/identity.mjs";
import { requirePublicUrl } from "../domain/public-url.mjs";

const CONTENT_TYPES = new Set([
  "article",
  "social_post",
  "image_text",
  "video",
  "talking_head",
  "opinion",
]);

function requireText(value, field, maxLength = 20_000) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(400, "INVALID_INPUT", `${field} 不能为空。`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new ApiError(400, "INVALID_INPUT", `${field} 超过最大长度。`);
  }
  return trimmed;
}

function requireArray(value, field) {
  if (!Array.isArray(value)) {
    throw new ApiError(400, "INVALID_INPUT", `${field} 必须是数组。`);
  }
  return value;
}

function nextId(prefix, rows, { width = 3, compact = false } = {}) {
  const max = rows.reduce((current, row) => {
    const pattern = compact ? `^${prefix}(\\d+)$` : `^${prefix}-(\\d+)$`;
    const match = String(row.id).match(new RegExp(pattern));
    return match ? Math.max(current, Number(match[1])) : current;
  }, 0);
  const number = String(max + 1).padStart(width, "0");
  return compact ? `${prefix}${number}` : `${prefix}-${number}`;
}

function publicClaim(claim) {
  // Public approval never exports private source notes or credentials.
  if (claim.source?.visibility !== "public" || (claim.sensitivity && claim.sensitivity !== "low")) return null;
  let sourceUrl;
  try {
    sourceUrl = requirePublicUrl(claim.source.url, "claim.source.url", { allowHttp: true });
  } catch { return null; }
  const label = String(claim.source.label ?? "公开来源").trim().slice(0, 240);
  if (scanSensitiveText(`${label}\n${sourceUrl}`).length) return null;
  return {
    id: claim.id,
    type: claim.type,
    text: claim.text,
    source: { label, url: sourceUrl, visibility: "public" },
    evidenceLevel: claim.evidenceLevel,
    expiresAt: claim.expiresAt,
  };
}

export class GeoOsService {
  constructor({ store, clock = () => new Date() }) {
    this.store = store;
    this.clock = clock;
  }

  get entity() {
    return this.store.snapshot().entity;
  }

  bootstrap() {
    const state = this.store.snapshot();
    return {
      schemaVersion: state.schemaVersion,
      revision: state.revision,
      system: state.system ?? { ...SYSTEM_IDENTITY },
      entity: state.entity,
      accounts: state.accounts,
      claims: state.claims,
      queries: state.queries,
      content: state.content,
      contentBank: state.contentBank,
      publications: state.publications,
      interactions: state.interactions,
      observations: state.observations,
      mediaJobs: state.mediaJobs ?? [],
      metrics: this.metrics(),
      summary: this.summary(),
      eventHead: state.events.at(-1)?.hash ?? null,
      updatedAt: state.updatedAt,
    };
  }

  summary() {
    const state = this.store.snapshot();
    const statusCounts = Object.fromEntries(
      ["draft", "fact_check", "approved", "scheduled", "published", "blocked"].map(
        (status) => [status, state.content.filter((item) => item.status === status).length],
      ),
    );
    const claimCounts = Object.fromEntries(
      ["draft", "verified", "approved", "retired"].map((status) => [
        status,
        state.claims.filter((claim) => claim.state === status).length,
      ]),
    );

    return {
      revision: state.revision,
      accounts: state.accounts.length,
      activeAccounts: state.accounts.filter((account) => account.status === "active").length,
      claims: state.claims.length,
      claimCounts,
      content: state.content.length,
      statusCounts,
      contentBank: state.contentBank.length,
      queries: state.queries.length,
      observations: state.observations.length,
      interactions: state.interactions.length,
      mediaJobs: state.mediaJobs?.length ?? 0,
      publications: state.publications.length,
      eventHead: state.events.at(-1)?.hash ?? null,
    };
  }

  async approveClaim(id, input) {
    const state = this.store.snapshot();
    const claim = state.claims.find((item) => item.id === id);
    if (!claim) {
      throw new ApiError(404, "CLAIM_NOT_FOUND", `找不到 Claim ${id}。`);
    }

    const publicLevel = input.publicLevel ?? claim.publicLevel;
    if (!["private", "approved_public"].includes(publicLevel)) {
      throw new ApiError(400, "INVALID_PUBLIC_LEVEL", "公开级别只能是 private 或 approved_public。");
    }
    if (publicLevel === "approved_public") {
      if (!claim.source?.url) {
        throw new PolicyError(
          "PUBLIC_SOURCE_REQUIRED",
          "公开 Claim 必须带可访问的公开来源 URL。",
        );
      }
      const sensitive = scanSensitiveText(claim.text);
      if (sensitive.length > 0) {
        throw new PolicyError("PUBLIC_CLAIM_SENSITIVE", "公开 Claim 包含敏感信息。", sensitive);
      }
    }

    const approvedBy = requireText(input.approvedBy, "approvedBy", 120);
    const { result } = await this.store.mutate(
      {
        type: "claim.approved",
        actor: approvedBy,
        payload: { claimId: id, publicLevel },
      },
      (next) => {
        const row = next.claims.find((item) => item.id === id);
        if (!row) {
          throw new ApiError(404, "CLAIM_NOT_FOUND", `找不到 Claim ${id}。`);
        }
        Object.assign(row, {
          state: "approved",
          publicLevel,
          approvedBy,
          approvedAt: this.clock().toISOString(),
        });
        return row;
      },
    );
    return result;
  }

  async createContent(input) {
    const title = requireText(input.title, "title", 240);
    const body = requireText(input.body, "body", 50_000);
    const contentType = input.contentType ?? "article";
    if (!CONTENT_TYPES.has(contentType)) {
      throw new ApiError(400, "INVALID_CONTENT_TYPE", `未知内容类型：${contentType}`);
    }
    const claimIds = [...new Set(requireArray(input.claimIds ?? [], "claimIds").map(String))];
    const platforms = [
      ...new Set(requireArray(input.platforms ?? [], "platforms").map(String).map((item) => item.trim())),
    ].filter(Boolean);
    const opinion = Boolean(input.opinion) || contentType === "opinion";

    if (!opinion && claimIds.length === 0) {
      throw new PolicyError("EVIDENCE_REQUIRED", "非观点内容必须绑定至少一条 Claim。");
    }
    if (platforms.length === 0) {
      throw new ApiError(400, "PLATFORM_REQUIRED", "至少选择一个目标平台。");
    }

    const sensitive = scanSensitiveText(`${title}\n${body}`);
    if (sensitive.length > 0) {
      throw new PolicyError("DRAFT_CONTAINS_SENSITIVE_CONTENT", "草稿包含敏感信息。", sensitive);
    }

    const actor = input.owner?.trim() || MAIN_PROFILE.englishName;
    const { result } = await this.store.mutate(
      {
        type: "content.created",
        actor,
        payload: { title, contentType, claimIds, platforms },
      },
      (state) => {
        const knownClaims = new Set(state.claims.map((claim) => claim.id));
        const missing = claimIds.filter((id) => !knownClaims.has(id));
        if (missing.length > 0) {
          throw new ApiError(400, "CLAIM_NOT_FOUND", `找不到 Claim：${missing.join(", ")}`);
        }
        const knownPlatforms = new Set(state.accounts.map((account) => account.platform));
        const missingPlatforms = platforms.filter((platform) => !knownPlatforms.has(platform));
        if (missingPlatforms.length > 0) {
          throw new ApiError(
            400,
            "PLATFORM_NOT_FOUND",
            `未配置平台：${missingPlatforms.join(", ")}`,
          );
        }

        const at = this.clock().toISOString();
        const content = {
          id: nextId("CNT", state.content),
          title,
          contentType,
          claimIds,
          body,
          status: "draft",
          version: 1,
          platforms,
          owner: actor,
          opinion,
          visibility: "private",
          createdAt: at,
          updatedAt: at,
          approval: null,
        };
        state.content.push(content);
        return content;
      },
    );
    return result;
  }

  async transitionContent(id, input) {
    const target = requireText(input.target, "target", 40);
    const actor = requireText(input.actor, "actor", 120);
    const note = typeof input.note === "string" ? input.note.trim() : "";

    const { result } = await this.store.mutate(
      {
        type: "content.transitioned",
        actor,
        payload: { contentId: id, target },
      },
      (state) => {
        const index = state.content.findIndex((item) => item.id === id);
        if (index === -1) {
          throw new ApiError(404, "CONTENT_NOT_FOUND", `找不到内容 ${id}。`);
        }
        if (target === "approved") {
          validateContentForApproval(state.content[index], state.claims, {
            now: this.clock(),
          });
        }
        state.content[index] = transitionContent(
          state.content[index],
          target,
          { approvedBy: input.approvedBy || actor, note },
          { now: this.clock() },
        );
        return state.content[index];
      },
    );
    return result;
  }

  async recordPublication(input) {
    const contentId = requireText(input.contentId, "contentId", 80);
    const accountId = requireText(input.accountId, "accountId", 80);
    const actor = requireText(input.actor, "actor", 120);
    const receipt = input.receipt ?? {};
    if (typeof receipt !== "object" || Array.isArray(receipt)) {
      throw new ApiError(400, "INVALID_INPUT", "receipt 必须是对象。");
    }
    for (const field of ["url", "publishedAt", "capturedBy", "dataMode"]) {
      if (receipt[field] !== undefined && typeof receipt[field] !== "string") {
        throw new ApiError(400, "INVALID_INPUT", `receipt.${field} 必须是文本。`);
      }
    }

    const { result } = await this.store.mutate(
      {
        type: "publication.receipt_recorded",
        actor,
        payload: {
          contentId,
          accountId,
          dataMode: receipt.dataMode,
        },
      },
      (state) => {
        const contentIndex = state.content.findIndex((item) => item.id === contentId);
        const account = state.accounts.find((item) => item.id === accountId);
        const content = state.content[contentIndex];
        validatePublication({
          account,
          content,
          receipt,
          claims: state.claims,
          now: this.clock(),
        });

        const safeReceipt = {
          ...receipt,
          url: requirePublicUrl(receipt.url, "receipt.url", { allowHttp: true }),
        };
        const sensitive = scanSensitiveText(`${actor}\n${safeReceipt.url}\n${receipt.capturedBy}`);
        if (sensitive.length) {
          throw new PolicyError("PUBLICATION_CONTAINS_SENSITIVE_CONTENT", "发布回执包含敏感信息或凭据，请先移除。", sensitive);
        }

        const at = this.clock().toISOString();
        const contentHash = hashText(`${content.title}\n${content.body}`);
        const publication = {
          id: nextId("PUB", state.publications),
          contentId,
          accountId,
          platform: account.platform,
          url: safeReceipt.url,
          publishedAt: receipt.publishedAt,
          capturedBy: receipt.capturedBy.trim(),
          dataMode: receipt.dataMode,
          contentHash,
          receiptHash: hashObject(safeReceipt),
          recordedAt: at,
          recordedBy: actor,
        };
        state.publications.push(publication);
        state.content[contentIndex] = {
          ...content,
          status: "published",
          version: content.version + 1,
          publicationId: publication.id,
          updatedAt: at,
        };
        return publication;
      },
    );
    return result;
  }

  classifyInteraction(input) {
    return classifyInteraction(input.text, {
      approvedFaq: Boolean(input.approvedFaq),
    });
  }

  async createInteraction(input) {
    const text = requireText(input.text, "text", 10_000);
    const actor = input.actor?.trim() || "system";
    const classification = classifyInteraction(text, {
      approvedFaq: Boolean(input.approvedFaq),
    });
    const { result } = await this.store.mutate(
      {
        type: "interaction.classified",
        actor,
        payload: {
          channel: input.channel || "manual",
          level: classification.level,
          category: classification.category,
        },
      },
      (state) => {
        const at = this.clock().toISOString();
        const interaction = {
          id: nextId("INT", state.interactions, { width: 4 }),
          channel: input.channel?.trim() || "manual",
          authorType: input.authorType?.trim() || "unknown",
          text,
          classification,
          status: "classified",
          createdAt: at,
        };
        state.interactions.push(interaction);
        return interaction;
      },
    );
    return result;
  }

  async createQuery(input) {
    const text = requireText(input.text, "text", 500);
    const actor = input.actor?.trim() || MAIN_PROFILE.englishName;
    const { result } = await this.store.mutate(
      {
        type: "geo.query_created",
        actor,
        payload: { text, priority: input.priority || "P1" },
      },
      (state) => {
        const query = {
          id: nextId("Q", state.queries, { width: 3, compact: true }),
          text,
          locale: input.locale?.trim() || "zh-CN",
          intent: input.intent?.trim() || "general",
          priority: ["P0", "P1", "P2"].includes(input.priority) ? input.priority : "P1",
          surfaces: Array.isArray(input.surfaces) && input.surfaces.length
            ? input.surfaces.map(String)
            : ["DeepSeek Search"],
          state: "approved",
          createdAt: this.clock().toISOString(),
        };
        state.queries.push(query);
        return query;
      },
    );
    return result;
  }

  async recordObservation(input) {
    const queryId = requireText(input.queryId, "queryId", 80);
    const surface = requireText(input.surface, "surface", 120);
    const answer = requireText(input.answer, "answer", 100_000);
    const dataMode = input.dataMode ?? "draft";
    if (!DATA_MODES.includes(dataMode)) {
      throw new ApiError(400, "INVALID_DATA_MODE", `未知数据模式：${dataMode}`);
    }
    const citations = requireArray(input.citations ?? [], "citations");
    const actor = input.actor?.trim() || "system";

    const { result } = await this.store.mutate(
      {
        type: "geo.observation_recorded",
        actor,
        payload: { queryId, surface, dataMode },
      },
      (state) => {
        const query = state.queries.find((item) => item.id === queryId);
        if (!query) {
          throw new ApiError(404, "QUERY_NOT_FOUND", `找不到查询 ${queryId}。`);
        }

        const aliases = state.entity.aliases;
        const mentioned = aliases.some((alias) =>
          answer.toLowerCase().includes(alias.toLowerCase()),
        );
        const citationUrls = citations
          .map((citation) => (typeof citation === "string" ? citation : citation?.url))
          .filter(Boolean);
        const ownedCitations = citationUrls.filter((url) =>
          state.entity.ownedUrlPrefixes.some((prefix) => url.startsWith(prefix)),
        );
        const at = this.clock().toISOString();
        const observation = {
          id: nextId("OBS", state.observations, { width: 4 }),
          queryId,
          surface,
          answer,
          answerHash: hashText(answer),
          citations,
          dataMode,
          providerEvidence:
            input.providerEvidence && typeof input.providerEvidence === "object"
              ? input.providerEvidence
              : null,
          derived: {
            mentioned,
            negativeMention: mentioned && hasNegativeMention(answer),
            ownedCitationCount: ownedCitations.length,
            citationCount: citationUrls.length,
            recommendedRank: Number.isInteger(input.recommendedRank)
              ? input.recommendedRank
              : null,
          },
          collectedAt: input.collectedAt || at,
          createdAt: at,
        };
        state.observations.push(observation);
        return observation;
      },
    );
    return result;
  }

  metrics() {
    const state = this.store.snapshot();
    const byMode = Object.fromEntries(DATA_MODES.map((mode) => [mode, 0]));
    const qualified = state.observations.filter((item) =>
      ["real", "imported"].includes(item.dataMode),
    );
    for (const observation of state.observations) {
      byMode[observation.dataMode] += 1;
    }

    const total = qualified.length;
    const rate = (count) => (total === 0 ? null : Number((count / total).toFixed(4)));
    const observedQueryIds = new Set(qualified.map((item) => item.queryId));

    return {
      dataModes: byMode,
      qualifiedSamples: total,
      status: total === 0 ? "no_real_or_imported_observations" : "measured",
      mentionRate: rate(qualified.filter((item) => item.derived.mentioned).length),
      ownedCitationRate: rate(
        qualified.filter((item) => item.derived.ownedCitationCount > 0).length,
      ),
      negativeMentionRate: rate(
        qualified.filter((item) => item.derived.negativeMention).length,
      ),
      queryCoverage:
        state.queries.length === 0
          ? null
          : Number((observedQueryIds.size / state.queries.length).toFixed(4)),
      observedQueries: observedQueryIds.size,
      totalQueries: state.queries.length,
    };
  }

  publicPreview() {
    const state = this.store.snapshot();
    const claims = state.claims
      .filter((claim) => isClaimPubliclyExportable(claim, { now: this.clock() }))
      .map(publicClaim)
      .filter(Boolean);
    return {
      generatedAt: this.clock().toISOString(),
      system: state.system ?? { ...SYSTEM_IDENTITY },
      entity: {
        publicName: state.entity.publicName,
        brandName: state.entity.brandName,
        englishName: state.entity.englishName,
        englishBrandName: state.entity.englishBrandName,
        headline: state.entity.headline,
        nameZh: state.entity.nameZh,
        nameEn: state.entity.nameEn,
        displayName: state.entity.displayName,
        englishDisplayName: state.entity.englishDisplayName,
        displayNameZh: state.entity.displayNameZh,
        displayNameEn: state.entity.displayNameEn,
        bio: state.entity.bio,
        englishBio: state.entity.englishBio,
        bioZh: state.entity.bioZh,
        bioEn: state.entity.bioEn,
      },
      claims,
      note: "Only approved_public, unexpired and non-sensitive claims are included.",
    };
  }

  events(limit = 100) {
    const state = this.store.snapshot();
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return {
      verification: verifyEventChain(state.events),
      events: state.events.slice(-safeLimit),
    };
  }
}

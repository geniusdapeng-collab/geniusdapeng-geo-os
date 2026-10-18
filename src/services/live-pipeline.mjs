import { ApiError, PolicyError } from "../domain/errors.mjs";
import { hashObject } from "../domain/hash.mjs";

export class LivePipelineService {
  constructor({
    service,
    deepSeek,
    github,
    geoEvidence,
    videoEdit,
    clock = () => new Date(),
  }) {
    this.service = service;
    this.deepSeek = deepSeek;
    this.github = github;
    this.geoEvidence = geoEvidence;
    this.videoEdit = videoEdit;
    this.clock = clock;
  }

  async adapterHealth() {
    const entries = await Promise.all(
      Object.entries({
        deepSeek: this.deepSeek,
        github: this.github,
        geoEvidence: this.geoEvidence,
        videoEdit: this.videoEdit,
      }).map(async ([name, adapter]) => [name, await adapter.health()]),
    );
    return Object.fromEntries(entries);
  }

  async generateContent({
    brief,
    claimIds = [],
    platform = "GitHub",
    contentType = "social_post",
  }) {
    const state = this.service.store.snapshot();
    const claims = claimIds.map((id) => state.claims.find((claim) => claim.id === id));
    if (claims.some((claim) => !claim)) {
      throw new ApiError(404, "CLAIM_NOT_FOUND", "生成内容引用了不存在的 Claim。");
    }
    if (claims.length === 0) {
      throw new PolicyError("EVIDENCE_REQUIRED", "模型生成内容必须绑定至少一条 Claim。");
    }
    if (claims.some((claim) => claim.state !== "approved")) {
      throw new PolicyError("CLAIM_NOT_APPROVED", "模型只能使用已经批准的事实。");
    }

    const generated = await this.deepSeek.generateContent({
      brief,
      claims,
      platform,
      contentType,
    });
    const content = await this.service.createContent({
      title: generated.title,
      body: generated.body,
      contentType,
      claimIds,
      platforms: [platform],
      owner: "PengStack + DeepSeek",
      opinion: false,
    });

    await this.service.store.mutate(
      {
        type: "content.model_receipt_recorded",
        actor: "DeepSeek",
        payload: {
          contentId: content.id,
          model: generated.model,
          responseId: generated.responseId,
        },
      },
      (next) => {
        const row = next.content.find((item) => item.id === content.id);
        row.generation = {
          provider: "deepseek",
          model: generated.model,
          responseId: generated.responseId,
          responseHash: generated.responseHash,
          hook: generated.hook ?? null,
          cta: generated.cta ?? null,
          hashtags: Array.isArray(generated.hashtags) ? generated.hashtags : [],
          generatedAt: this.clock().toISOString(),
        };
        return row.generation;
      },
    );

    return {
      content: this.service.store
        .snapshot()
        .content.find((item) => item.id === content.id),
      model: {
        name: generated.model,
        responseId: generated.responseId,
        usage: generated.usage,
        responseHash: generated.responseHash,
      },
    };
  }

  async collectDeepSeek({ queryIds, limit = 12 } = {}) {
    const state = this.service.store.snapshot();
    const selected = queryIds?.length
      ? state.queries.filter((query) => queryIds.includes(query.id))
      : state.queries.slice(0, Math.max(1, Math.min(Number(limit) || 12, 50)));
    if (selected.length === 0) {
      throw new ApiError(400, "QUERY_REQUIRED", "没有可采集的查询。");
    }

    const results = [];
    for (const query of selected) {
      try {
        const answer = await this.deepSeek.answerQuery(query);
        const observation = await this.service.recordObservation({
          queryId: query.id,
          surface: answer.evidence.surface,
          answer: answer.answer,
          citations: answer.citations,
          dataMode: "real",
          collectedAt: this.clock().toISOString(),
          actor: "DeepSeek live collector",
        });
        results.push({
          queryId: query.id,
          status: "success",
          observationId: observation.id,
          answerHash: observation.answerHash,
          evidence: answer.evidence,
        });
      } catch (error) {
        results.push({
          queryId: query.id,
          status: "failed",
          error: error.message,
        });
      }
    }

    return {
      requested: selected.length,
      successful: results.filter((result) => result.status === "success").length,
      failed: results.filter((result) => result.status === "failed").length,
      results,
      metrics: this.service.metrics(),
      receiptHash: hashObject({
        results: results.map((result) => ({
          queryId: result.queryId,
          status: result.status,
          observationId: result.observationId ?? null,
          error: result.error ?? null,
        })),
        collectedAt: this.clock().toISOString(),
      }),
    };
  }

  async runGeoEvidence(input) {
    return this.geoEvidence.runVisibility(input);
  }

  async enrichCover(input) {
    return this.videoEdit.enrichCover(input);
  }

  async publishContentToGitHub({
    contentId,
    accountId = "github",
    label = "geo-live-smoke",
  }) {
    const state = this.service.store.snapshot();
    const content = state.content.find((item) => item.id === contentId);
    const account = state.accounts.find((item) => item.id === accountId);
    if (!content) {
      throw new ApiError(404, "CONTENT_NOT_FOUND", `找不到内容 ${contentId}。`);
    }
    if (content.status !== "scheduled") {
      throw new PolicyError(
        "CONTENT_NOT_SCHEDULED",
        "模型驱动发布前，内容必须经过审批并进入 scheduled。",
      );
    }
    if (!account || account.platform !== "GitHub") {
      throw new PolicyError("GITHUB_ACCOUNT_REQUIRED", "需要一个启用并审阅过的 GitHub 账号。");
    }

    const issue = await this.github.createIssue({
      title: content.title,
      body: `${content.body}\n\n---\n\n由鹏栈 GEO 控制面通过 GitHub 官方 REST API 发布。模型：${content.generation?.model ?? "未记录"}；内容版本：v${content.version}。`,
      label,
    });
    const publication = await this.service.recordPublication({
      contentId,
      accountId,
      actor: "PengStack live publisher",
      receipt: {
        url: issue.url,
        publishedAt: issue.createdAt || this.clock().toISOString(),
        capturedBy: "geniusdapeng-collab",
        dataMode: "real",
      },
    });
    return {
      issue,
      publication,
      contentId,
      accountId,
    };
  }
}

import { ApiError, PolicyError } from "../domain/errors.mjs";
import { hashObject, hashText } from "../domain/hash.mjs";
import { requirePublicUrl as publicUrl } from "../domain/public-url.mjs";
import { classifyInteraction, validatePublication } from "../domain/policy.mjs";
import { EDITORIAL_SCHEMA, EDITORIAL_NATIVE_SCHEMA, isEditorialVariantSchema, EDITORIAL_PUBLICATION_AUTHORIZATION, editorialEtag, editorialInput,
  editorialSensitiveFindings, editorialVariantSnapshot, validateEditorialVariant } from "../domain/editorial.mjs";
import { JsonStore } from "../storage/json-store.mjs";

const tails = new WeakMap();
const SECRET_FIELD = /^(?:cookies?|passwords?|secrets?|(?:access[_-]?)?tokens?|api[_-]?key|authorization|credentials|storage[_-]?state|local[_-]?storage|session[_-]?storage|headers)$/i;
const VALID_STATUSES = new Set(["draft", "active", "paused"]);
const POLICY_STATUSES = new Set(["reviewed", "manual_review_required"]);

function accountIdentity(account) {
  return {
    id: account.id,
    platform: account.platform,
    handle: account.handle,
    profileUrl: account.profileUrl ?? "",
  };
}

function text(value, field, max = 120) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new ApiError(400, "INVALID_INPUT", `${field} 必须是 1 到 ${max} 字的文本。`);
  }
  return value.trim();
}

function safeInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ApiError(400, "INVALID_INPUT", "请求必须是对象。");
  }
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_FIELD.test(key)) {
        throw new ApiError(400, "CREDENTIALS_NOT_ALLOWED", "账号密码、Cookie 和登录凭据只保留在本机浏览器，不得提交到后台。");
      }
      visit(child);
    }
  };
  visit(input);
  const findings = editorialSensitiveFindings(input, { credentialUrls: false });
  if (findings.length) {
    throw new PolicyError("OPERATION_CONTAINS_SENSITIVE_CONTENT", "运营记录包含敏感信息或凭据，请先移除。", findings);
  }
}

function timestamp(value, field, now) {
  const raw = text(value, field, 80);
  const at = new Date(raw);
  if (!Number.isFinite(at.getTime()) || at.getTime() > now.getTime() + 60_000) {
    throw new ApiError(400, "INVALID_TIMESTAMP", `${field} 必须是有效且不晚于当前时间的时间。`);
  }
  return at.toISOString();
}

function accountFor(state, id) {
  const account = state.accounts.find((row) => row.id === id);
  if (!account) throw new ApiError(404, "ACCOUNT_NOT_FOUND", `找不到账号 ${id}。`);
  return account;
}

function operationFor(state, id) {
  const operation = (state.accountOperations ?? []).find((row) => row.id === id);
  if (!operation) throw new ApiError(404, "OPERATION_NOT_FOUND", `找不到运营动作 ${id}。`);
  return operation;
}

function expectedState(operation, statuses) {
  if (!statuses.includes(operation.status)) {
    throw new ApiError(409, "INVALID_OPERATION_TRANSITION", `当前 ${operation.status} 状态不能执行此动作。`);
  }
}

function nextId(rows) {
  const number = rows.reduce((max, row) => Math.max(max, Number(String(row.id).match(/^OP-(\d+)$/)?.[1] ?? 0)), 0) + 1;
  return `OP-${String(number).padStart(4, "0")}`;
}

function normalizedReceipt(operation, source, now) {
  if (!["real", "imported"].includes(source.dataMode)) throw new ApiError(400, "INVALID_RECEIPT_DATA_MODE", "只有 real 或 imported 回执可完成运营动作。");
  if (!["browser_readback", "manual_readback"].includes(source.verificationMethod)) throw new ApiError(400, "RECEIPT_VERIFICATION_REQUIRED", "必须记录由浏览器或本人手工回读核验。");
  const receipt = {
    url: publicUrl(source.url, "receipt.url"), publishedAt: timestamp(source.publishedAt, "receipt.publishedAt", now),
    capturedBy: text(source.capturedBy, "receipt.capturedBy"), dataMode: source.dataMode,
    verificationMethod: source.verificationMethod, verifiedAt: timestamp(source.verifiedAt, "receipt.verifiedAt", now),
    verifiedBy: text(source.verifiedBy, "receipt.verifiedBy"), contentHash: operation.contentHash,
  };
  if (new Date(receipt.verifiedAt).getTime() < new Date(receipt.publishedAt).getTime()) throw new ApiError(400, "RECEIPT_VERIFICATION_BEFORE_PUBLICATION", "回读核验时间不能早于发布时间。");
  if (source.contentHash !== undefined && source.contentHash !== operation.contentHash) throw new ApiError(409, "RECEIPT_CONTENT_MISMATCH", "回执正文哈希与批准的内容不一致。");
  if (operation.snapshotSchema !== undefined) {
    if (!isEditorialVariantSchema(operation.snapshotSchema) || source.editorialSnapshotHash !== operation.editorialSnapshotHash) {
      throw new ApiError(409, "RECEIPT_EDITORIAL_SNAPSHOT_MISMATCH", "回执必须绑定获准的完整编辑快照。");
    }
    const expected = [...new Map(operation.editorialSnapshot.assetRefs.map(ref => [`${ref.assetId}:${ref.sha256}`, { assetId: ref.assetId, sha256: ref.sha256 }])).values()]
      .sort((a, b) => a.assetId.localeCompare(b.assetId));
    if (!Array.isArray(source.assetHashes) || source.assetHashes.some(row => !row || typeof row !== "object" || Object.keys(row).length !== 2 || typeof row.assetId !== "string" || typeof row.sha256 !== "string") ||
        hashObject([...source.assetHashes].sort((a, b) => a.assetId.localeCompare(b.assetId))) !== hashObject(expected)) {
      throw new ApiError(409, "RECEIPT_EDITORIAL_ASSETS_MISMATCH", "回读必须核对这一快照的全部媒体引用。");
    }
    receipt.editorialSnapshotHash = operation.editorialSnapshotHash;
    receipt.assetHashes = expected;
    if (operation.snapshotSchema === EDITORIAL_NATIVE_SCHEMA) {
      const pkg = operation.editorialSnapshot.publicationPackage;
      const artifacts = pkg.artifactRefs.map(ref => ({ artifactId: ref.id, sha256: ref.sha256 })).sort((a, b) => a.artifactId.localeCompare(b.artifactId));
      if (source.packageHash !== operation.packageHash || source.reviewSnapshotHash !== operation.reviewSnapshotHash ||
          !Array.isArray(source.artifactHashes) || source.artifactHashes.some(row => !row || typeof row !== "object" || Object.keys(row).length !== 2 || typeof row.artifactId !== "string" || typeof row.sha256 !== "string") ||
          hashObject([...source.artifactHashes].sort((a, b) => a.artifactId.localeCompare(b.artifactId))) !== hashObject(artifacts)) {
        throw new ApiError(409, "RECEIPT_NATIVE_PACKAGE_MISMATCH", "回读必须绑定原生完整包、审核快照及全部实际附件。");
      }
      receipt.packageHash = operation.packageHash; receipt.reviewSnapshotHash = operation.reviewSnapshotHash; receipt.artifactHashes = artifacts;
    }
  }
  return receipt;
}

function assertEditorialOperation(state, operation, content, account, now) {
  if (content.snapshotSchema === undefined && operation.snapshotSchema === undefined) return;
  if (!isEditorialVariantSchema(content.snapshotSchema) || operation.snapshotSchema !== content.snapshotSchema ||
      operation.editorialSnapshotHash !== content.snapshotHash || hashObject(operation.editorialSnapshot) !== operation.editorialSnapshotHash) {
    throw new ApiError(409, "EDITORIAL_SNAPSHOT_CHANGED", "运营动作的完整编辑快照发生变化。");
  }
  validateEditorialVariant(state, content, account, { now, requireReady: true, requireApproval: true });
  if (content.destinationSnapshot.visibility !== "public") {
    throw new PolicyError("RESTRICTED_RECEIPT_WORKFLOW_REQUIRED", "受限社区或私有作品不能借用公共发布回执流程。");
  }
  if (operation.approval && operation.approval.editorialSnapshotHash !== operation.editorialSnapshotHash) {
    throw new ApiError(409, "EDITORIAL_APPROVAL_MISMATCH", "运营审批未绑定这一完整编辑快照。");
  }
  if (operation.snapshotSchema === EDITORIAL_NATIVE_SCHEMA && (operation.packageHash !== content.packageHash || operation.reviewSnapshotHash !== content.reviewSnapshotHash ||
      operation.approval && (operation.approval.packageHash !== content.packageHash || operation.approval.reviewSnapshotHash !== content.reviewSnapshotHash))) {
    throw new ApiError(409, "NATIVE_PACKAGE_CHANGED", "运营动作或原始审批未绑定准确的最终原生包与独立终检。");
  }
}

function assertReady(state, operation, now) {
  const account = accountFor(state, operation.accountId);
  if (account.platform !== operation.platform) {
    throw new ApiError(409, "ACCOUNT_PLATFORM_CHANGED", "目标账号的平台发生变化，请重新建立动作。");
  }
  if (!operation.accountSnapshot || hashObject(accountIdentity(account)) !== hashObject(operation.accountSnapshot)) {
    throw new ApiError(409, "ACCOUNT_IDENTITY_CHANGED", "账号 handle 或公开主页已变化，旧授权不适用于新账号，请重新建立动作。");
  }
  if (operation.type === "publish") {
    const content = state.content.find((row) => row.id === operation.contentId);
    if (!content) throw new ApiError(404, "CONTENT_NOT_FOUND", "待发布内容不存在。");
    if (hashText(`${content.title}\n${content.body}`) !== operation.contentHash) {
      throw new ApiError(409, "OPERATION_CONTENT_CHANGED", "正文已变化，必须重新建立并审批运营动作。");
    }
    assertEditorialOperation(state, operation, content, account, now);
    validatePublication({
      account,
      content,
      claims: state.claims,
      now,
      requireReceipt: false,
    });
  } else {
    if (account.status !== "active" || account.policyStatus !== "reviewed") {
      throw new ApiError(409, "ACCOUNT_NOT_READY", "回复前必须启用账号并记录平台规则已审阅。");
    }
    if (hashText(operation.replyText) !== operation.contentHash) {
      throw new ApiError(409, "OPERATION_CONTENT_CHANGED", "回复正文与审批快照不一致。");
    }
    if (operation.classification.level === "L3") {
      throw new ApiError(409, "REPLY_BLOCKED", "垃圾或诱导互动不得进入回复执行。");
    }
    if (operation.classification.level === "L0" && operation.executionMode !== "manual") {
      throw new ApiError(409, "HUMAN_ONLY_INTERACTION", "高风险互动只能由本人手工处理并登记回执。");
    }
  }
}

export class AccountOperationsService {
  constructor({ service, clock = () => new Date(), productionArtifacts = null, mediaAssets = null }) {
    this.service = service;
    this.store = service.store;
    this.clock = clock;
    this.productionArtifacts = productionArtifacts;
    this.mediaAssets = mediaAssets;
  }

  async #verifyNativeContent(content) {
    if (content?.snapshotSchema !== EDITORIAL_NATIVE_SCHEMA) return;
    if (typeof this.productionArtifacts?.verifyReferences !== "function") throw new ApiError(503, "NATIVE_ARTIFACT_VERIFICATION_UNAVAILABLE", "原生发布前必须配置真实附件字节核对。");
    await this.productionArtifacts.verifyReferences(content.publicationPackage.artifactRefs);
    if (content.assetRefs.length) {
      if (typeof this.mediaAssets?.verifyForRelease !== "function") throw new ApiError(503, "MEDIA_VERIFICATION_UNAVAILABLE", "原生发布前必须核对真实媒体。");
      await this.mediaAssets.verifyForRelease(content.assetRefs);
    }
  }

  list() {
    const state = this.store.snapshot();
    return (state.accountOperations ?? []).map(row => {
      const reconciliation = (state.externalResultReconciliations ?? []).find(item => item.id === row.reconciliationId);
      return { ...row, etag: editorialEtag(row), ...(reconciliation ? { reconciliation: {
        id: reconciliation.id, reason: reconciliation.reason, incidentCodes: [...reconciliation.incidentCodes],
        recordedAt: reconciliation.recordedAt, recordedBy: reconciliation.recordedBy,
        approvedSnapshotHash: reconciliation.approvedSnapshotHash,
      } } : {}) };
    });
  }

  // Serialize the two ledger writes during publication, including across service instances.
  async #serialize(callback) {
    const previous = tails.get(this.store) ?? Promise.resolve();
    const run = previous.then(callback);
    tails.set(this.store, run.catch(() => undefined));
    return run;
  }

  async updateAccount(id, input) {
    safeInput(input);
    const actor = text(input.actor, "actor");
    return this.#serialize(async () => {
      const { result } = await this.store.mutate(
        { type: "account.updated", actor, payload: { accountId: id } },
        (state) => {
          const account = accountFor(state, id);
          if (input.handle !== undefined) account.handle = text(input.handle, "handle", 160);
          if (input.profileUrl !== undefined) account.profileUrl = input.profileUrl === "" ? "" : publicUrl(input.profileUrl, "profileUrl");
          if (input.status !== undefined) {
            if (!VALID_STATUSES.has(input.status)) throw new ApiError(400, "INVALID_ACCOUNT_STATUS", "账号状态只能是 draft、active 或 paused。");
            account.status = input.status;
          }
          if (input.policyStatus !== undefined) {
            if (!POLICY_STATUSES.has(input.policyStatus)) throw new ApiError(400, "INVALID_POLICY_STATUS", "平台规则状态无效。");
            account.policyStatus = input.policyStatus;
          }
          if (input.policyCheckedAt !== undefined) account.policyCheckedAt = timestamp(input.policyCheckedAt, "policyCheckedAt", this.clock());
          if (account.policyStatus === "reviewed" && !account.policyCheckedAt) {
            throw new ApiError(400, "POLICY_REVIEW_TIME_REQUIRED", "规则已审阅必须记录审阅时间。");
          }
          if (input.policyStatus === "reviewed") account.policyReviewedBy = actor;
          account.updatedAt = this.clock().toISOString();
          return account;
        },
      );
      return result;
    });
  }

  async create(input) {
    safeInput(input);
    const accountId = text(input.accountId, "accountId", 80);
    const actor = text(input.actor, "actor");
    if (!["publish", "reply"].includes(input.type)) throw new ApiError(400, "INVALID_OPERATION_TYPE", "动作类型只能是 publish 或 reply。");
    const executionMode = input.executionMode ?? "browser";
    if (!["browser", "manual"].includes(executionMode)) throw new ApiError(400, "INVALID_EXECUTION_MODE", "执行方式只能是 browser 或 manual。");
    return this.#serialize(async () => {
      if (input.type === "publish") await this.#verifyNativeContent(this.store.snapshot().content.find(row => row.id === input.contentId));
      const { result } = await this.store.mutate(
        { type: "account.operation_created", actor, payload: { accountId, operationType: input.type } },
        (state) => {
          const account = accountFor(state, accountId);
          const at = this.clock().toISOString();
          state.accountOperations ??= [];
          const row = {
            id: nextId(state.accountOperations), accountId, platform: account.platform,
            accountSnapshot: accountIdentity(account),
            type: input.type, executionMode, status: "draft", createdBy: actor,
            createdAt: at, updatedAt: at, approval: null, execution: null, receipt: null,
            publicationId: null, failure: null,
          };
          if (input.type === "publish") {
            row.contentId = text(input.contentId, "contentId", 80);
            const content = state.content.find((item) => item.id === row.contentId);
            if (!content) throw new ApiError(404, "CONTENT_NOT_FOUND", "待发布内容不存在。");
            if (content.status === "published" || state.accountOperations.some((item) => item.type === "publish" && item.contentId === row.contentId && item.status !== "failed")) {
              throw new ApiError(409, "PUBLICATION_OPERATION_EXISTS", "此内容已有发布动作或发布记录，请复用原动作。");
            }
            if (!content.platforms.includes(account.platform)) throw new ApiError(409, "TARGET_PLATFORM_MISMATCH", "内容目标平台不包含该账号。");
            safeInput({ title: content.title, body: content.body });
            row.contentSnapshot = { title: content.title, body: content.body, version: content.version };
            row.contentHash = hashText(`${content.title}\n${content.body}`);
            if (content.snapshotSchema !== undefined) {
              if (!isEditorialVariantSchema(content.snapshotSchema)) throw new PolicyError("EDITORIAL_SCHEMA_UNSUPPORTED", "未知编辑版本不能进入旧发布流程。");
              validateEditorialVariant(state, content, account, { now: this.clock(), requireReady: true, requireApproval: true });
              if (content.destinationSnapshot.visibility !== "public") throw new PolicyError("RESTRICTED_RECEIPT_WORKFLOW_REQUIRED", "受限目的地需要独立回执合同。");
              row.snapshotSchema = content.snapshotSchema;
              row.editorialSnapshot = editorialVariantSnapshot(content);
              row.editorialSnapshotHash = content.snapshotHash;
              row.destinationId = content.destinationId;
              if (content.snapshotSchema === EDITORIAL_NATIVE_SCHEMA) { row.packageHash = content.packageHash; row.reviewSnapshotHash = content.reviewSnapshotHash; }
            }
          } else {
            row.replyText = text(input.replyText, "replyText", 10_000);
            row.targetUrl = publicUrl(input.targetUrl, "targetUrl");
            let incoming = "";
            if (input.interactionId !== undefined && input.interactionId !== "") {
              row.interactionId = text(input.interactionId, "interactionId", 80);
              const interaction = state.interactions.find((item) => item.id === row.interactionId);
              if (!interaction) throw new ApiError(404, "INTERACTION_NOT_FOUND", "原始互动不存在。");
              incoming = interaction.text;
            }
            row.classification = classifyInteraction(`${incoming}\n${row.replyText}`);
            row.contentHash = hashText(row.replyText);
          }
          state.accountOperations.push(row);
          return row;
        },
      );
      return result;
    });
  }

  async approve(id, input) {
    safeInput(input);
    const approvedBy = text(input.approvedBy, "approvedBy");
    const authorizationNote = text(input.authorizationNote, "authorizationNote", 2_000);
    return this.#serialize(async () => {
      const snapshot = this.store.snapshot(), original = operationFor(snapshot, id);
      await this.#verifyNativeContent(snapshot.content.find(row => row.id === original.contentId));
      const { result } = await this.store.mutate(
        { type: "account.operation_approved", actor: approvedBy, payload: { operationId: id } },
        (state) => {
          const row = operationFor(state, id);
          expectedState(row, ["draft"]);
          assertReady(state, row, this.clock());
          row.approval = { approvedBy, authorizationNote, approvedAt: this.clock().toISOString(), contentHash: row.contentHash };
          if (isEditorialVariantSchema(row.snapshotSchema)) row.approval.editorialSnapshotHash = row.editorialSnapshotHash;
          if (row.snapshotSchema === EDITORIAL_NATIVE_SCHEMA) { row.approval.packageHash = row.packageHash; row.approval.reviewSnapshotHash = row.reviewSnapshotHash; }
          row.status = "approved";
          row.updatedAt = this.clock().toISOString();
          return row;
        },
      );
      return result;
    });
  }

  async start(id, input) {
    safeInput(input);
    const actor = text(input.actor, "actor");
    return this.#serialize(async () => {
      const snapshot = this.store.snapshot(), original = operationFor(snapshot, id);
      await this.#verifyNativeContent(snapshot.content.find(row => row.id === original.contentId));
      const { result } = await this.store.mutate(
        { type: "account.operation_started", actor, payload: { operationId: id } },
        (state) => {
          const row = operationFor(state, id);
          expectedState(row, ["approved"]);
          assertReady(state, row, this.clock());
          row.status = "in_progress";
          row.execution = { actor, startedAt: this.clock().toISOString(), mode: row.executionMode };
          row.updatedAt = this.clock().toISOString();
          return row;
        },
      );
      return result;
    });
  }

  async complete(id, input) {
    safeInput(input);
    const actor = text(input.actor, "actor");
    safeInput(input.receipt);
    return this.#serialize(async () => {
      const state = this.store.snapshot();
      const operation = operationFor(state, id);
      const source = input.receipt;
      const receipt = normalizedReceipt(operation, source, this.clock());
      const receiptHash = hashObject(receipt);
      if (operation.status === "completed") {
        if (operation.receipt.receiptHash !== receiptHash) throw new ApiError(409, "RECEIPT_CONFLICT", "动作已完成，不能以不同回执覆盖原记录。");
        return operation;
      }
      await this.#verifyNativeContent(state.content.find(row => row.id === operation.contentId));
      expectedState(operation, ["in_progress"]);
      const approvedAt = Date.parse(operation.approval?.approvedAt), startedAt = Date.parse(operation.execution?.startedAt);
      if (operation.approval?.contentHash !== operation.contentHash || !Number.isFinite(approvedAt) || !Number.isFinite(startedAt) ||
          startedAt < approvedAt || startedAt > this.clock().getTime() + 60_000) {
        throw new ApiError(409, "OPERATION_AUTHORIZATION_INVALID", "原始审批或执行时间无效，不能登记新的完成回执。");
      }
      if (Date.parse(receipt.publishedAt) < Math.max(approvedAt, startedAt)) {
        throw new ApiError(400, "RECEIPT_BEFORE_AUTHORIZATION", "平台结果发生时间不能早于本次原始审批或执行开始。");
      }
      if (state.accountOperations.some((row) => row.id !== id && row.accountId === operation.accountId && row.receipt?.url === receipt.url)) {
        throw new ApiError(409, "DUPLICATE_PLATFORM_RECEIPT", "该平台结果已由另一个动作登记。");
      }
      if (state.publications.some(row => row.accountId === operation.accountId && row.contentId !== operation.contentId && row.url === receipt.url)) {
        throw new ApiError(409, "DUPLICATE_PLATFORM_RECEIPT", "该平台结果已由其他内容的发布账本登记。");
      }
      let publicationId = null;
      if (operation.type === "publish") {
        const existing = state.publications.find((row) => row.contentId === operation.contentId);
        if (existing) {
          if (existing.accountId !== operation.accountId || existing.receiptHash !== receiptHash || existing.contentHash !== operation.contentHash) {
            throw new ApiError(409, "PUBLICATION_RECEIPT_CONFLICT", "内容已有其他发布回执，不能重复登记。");
          }
          publicationId = existing.id;
        } else {
          assertReady(state, operation, this.clock());
          const publication = await this.service.recordPublication({ contentId: operation.contentId, accountId: operation.accountId, actor, receipt,
            [EDITORIAL_PUBLICATION_AUTHORIZATION]: isEditorialVariantSchema(operation.snapshotSchema) ? { operationId: operation.id, snapshotHash: operation.editorialSnapshotHash,
              ...(operation.snapshotSchema === EDITORIAL_NATIVE_SCHEMA ? { packageHash: operation.packageHash, reviewSnapshotHash: operation.reviewSnapshotHash } : {}) } : null });
          publicationId = publication.id;
        }
      } else {
        assertReady(state, operation, this.clock());
      }
      const { result } = await this.store.mutate(
        { type: "account.operation_completed", actor, payload: { operationId: id, receiptHash, dataMode: receipt.dataMode, publicationId } },
        (next) => {
          const row = operationFor(next, id);
          expectedState(row, ["in_progress"]);
          if (row.approval?.contentHash !== row.contentHash) throw new ApiError(409, "OPERATION_CONTENT_CHANGED", "审批正文哈希不一致。");
          if (isEditorialVariantSchema(row.snapshotSchema) && row.approval.editorialSnapshotHash !== row.editorialSnapshotHash) throw new ApiError(409, "EDITORIAL_APPROVAL_MISMATCH", "编辑审批摘要不一致。");
          if (row.snapshotSchema === EDITORIAL_NATIVE_SCHEMA && (row.approval.packageHash !== row.packageHash || row.approval.reviewSnapshotHash !== row.reviewSnapshotHash)) throw new ApiError(409, "NATIVE_PACKAGE_CHANGED", "原生审批与回读的包摘要不一致。");
          row.receipt = { ...receipt, receiptHash, recordedAt: this.clock().toISOString(), recordedBy: actor };
          row.publicationId = publicationId;
          row.status = "completed";
          row.updatedAt = this.clock().toISOString();
          return row;
        },
      );
      return result;
    });
  }

  async reconcile(id, input, ctx) {
    editorialInput(input, ["approvedSnapshotHash", "accountConfirmed", "contentConfirmed", "receipt", "reason"]);
    if (!ctx || ctx.method === "agent" || !["session", "local"].includes(ctx.method)) throw new ApiError(403, "AGENT_SCOPE_DENIED", "历史结果调和仅允许管理员。");
    const actor = text(ctx.actor, "actor"), reason = text(input.reason, "reason", 2000);
    if (typeof ctx.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(ctx.idempotencyKey)) throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "结果调和必须使用稳定幂等键。");
    if (input.accountConfirmed !== true || input.contentConfirmed !== true) throw new PolicyError("RECONCILIATION_READBACK_REQUIRED", "调和前必须实际核对原账号及完整获准正文和媒体。");
    safeInput(input.receipt);
    const keyHash = hashObject({ actor, id, key: ctx.idempotencyKey }), requestHash = hashObject(input);
    return this.#serialize(async () => {
      const payload = { operationId: id };
      const { result } = await this.store.mutate({ type: "account.operation_reconciled", actor, payload }, state => {
        state.operationReconciliationRequests ??= [];
        const prior = state.operationReconciliationRequests.find(row => row.keyHash === keyHash);
        if (prior) {
          if (prior.requestHash !== requestHash) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "同一幂等键不能用于不同调和请求。");
          return JsonStore.noChange(prior.result);
        }
        const operation = operationFor(state, id);
        if (!ctx.ifMatch) throw new ApiError(428, "PRECONDITION_REQUIRED", "先读取动作并提供 If-Match。");
        if (ctx.ifMatch !== editorialEtag(operation)) throw new ApiError(412, "PRECONDITION_FAILED", "动作已变化，请重新核对。");
        expectedState(operation, ["in_progress", "completed"]);
        if (!operation.approval || !operation.execution || !operation.accountSnapshot || operation.approval.contentHash !== operation.contentHash) {
          throw new PolicyError("ORIGINAL_APPROVAL_REQUIRED", "调和必须保留原始审批、账号快照与已开始执行记录。");
        }
        const approvedAt = Date.parse(operation.approval.approvedAt), startedAt = Date.parse(operation.execution.startedAt);
        if (!Number.isFinite(approvedAt) || !Number.isFinite(startedAt) || startedAt < approvedAt || startedAt > this.clock().getTime() + 60_000) {
          throw new PolicyError("ORIGINAL_APPROVAL_REQUIRED", "原始审批与执行时间无效，不能以调和绕过授权时间。");
        }
        const approvedHash = isEditorialVariantSchema(operation.snapshotSchema) ? operation.editorialSnapshotHash : operation.contentHash;
        if (input.approvedSnapshotHash !== approvedHash) throw new PolicyError("RECONCILIATION_SNAPSHOT_MISMATCH", "调和请求与原始获准快照不一致。");
        if (operation.snapshotSchema !== undefined && (!isEditorialVariantSchema(operation.snapshotSchema) ||
            hashObject(operation.editorialSnapshot) !== approvedHash || operation.approval.editorialSnapshotHash !== approvedHash)) {
          throw new PolicyError("ORIGINAL_APPROVAL_REQUIRED", "原始完整编辑快照或审批已不一致。");
        }
        if (operation.snapshotSchema === EDITORIAL_NATIVE_SCHEMA && (operation.approval.packageHash !== operation.packageHash || operation.approval.reviewSnapshotHash !== operation.reviewSnapshotHash ||
            operation.editorialSnapshot.packageHash !== operation.packageHash || operation.editorialSnapshot.reviewSnapshotHash !== operation.reviewSnapshotHash)) {
          throw new PolicyError("ORIGINAL_APPROVAL_REQUIRED", "原始原生包或完整审核快照与批准不符。");
        }
        const exactText = operation.type === "publish" ? `${operation.contentSnapshot?.title}\n${operation.contentSnapshot?.body}` : operation.replyText;
        if (hashText(exactText) !== operation.contentHash) throw new PolicyError("RECONCILIATION_SNAPSHOT_MISMATCH", "原始正文快照已变化。");
        const receipt = normalizedReceipt(operation, input.receipt, this.clock()), receiptHash = hashObject(receipt);
        if (new Date(receipt.publishedAt).getTime() < Math.max(approvedAt, startedAt)) {
          throw new PolicyError("RECONCILIATION_BEFORE_AUTHORIZATION", "真实发布时间不能早于原始审批或执行开始。");
        }
        if (operation.status === "completed") {
          if (operation.receipt?.receiptHash !== receiptHash) throw new ApiError(409, "RECEIPT_CONFLICT", "已完成动作的原回执不能覆盖。");
          const result = { ...operation, etag: editorialEtag(operation) };
          return JsonStore.noChange(result);
        }
        if ((state.accountOperations ?? []).some(row => row.id !== id && row.accountId === operation.accountId && row.receipt?.url === receipt.url)) {
          throw new ApiError(409, "DUPLICATE_PLATFORM_RECEIPT", "此平台结果已由其他动作登记。");
        }
        if (state.publications.some(row => row.accountId === operation.accountId && row.contentId !== operation.contentId && row.url === receipt.url)) {
          throw new ApiError(409, "DUPLICATE_PLATFORM_RECEIPT", "此平台结果已由其他内容的发布账本登记。");
        }
        const now = this.clock().toISOString(), deviations = [];
        const account = state.accounts.find(row => row.id === operation.accountId);
        if (!account) deviations.push("ACCOUNT_MISSING");
        else {
          if (hashObject(accountIdentity(account)) !== hashObject(operation.accountSnapshot)) deviations.push("ACCOUNT_IDENTITY_CHANGED");
          if (account.status !== "active") deviations.push("ACCOUNT_NOT_ACTIVE");
          if (account.policyStatus !== "reviewed") deviations.push("PLATFORM_POLICY_NOT_REVIEWED");
        }
        let publicationId = operation.publicationId ?? null;
        if (operation.type === "publish") {
          const content = state.content.find(row => row.id === operation.contentId);
          const unchanged = content && hashText(`${content.title}\n${content.body}`) === operation.contentHash &&
            (!isEditorialVariantSchema(operation.snapshotSchema) || hashObject(editorialVariantSnapshot(content)) === approvedHash);
          if (!unchanged) deviations.push("CURRENT_CONTENT_CHANGED_OR_MISSING");
          if (isEditorialVariantSchema(operation.snapshotSchema) && content && account) {
            try { validateEditorialVariant(state, content, account, { now: this.clock(), requireReady: true, requireApproval: true }); }
            catch (error) { if (error instanceof ApiError) deviations.push(error.code); else throw error; }
          }
          for (const claimId of content?.claimIds ?? []) {
            const claim = state.claims.find(row => row.id === claimId);
            if (!claim || claim.state !== "approved" || (claim.expiresAt && (!Number.isFinite(Date.parse(claim.expiresAt)) || Date.parse(claim.expiresAt) <= this.clock().getTime()))) deviations.push("CURRENT_CLAIM_NOT_VALID");
          }
          const existing = state.publications.find(row => row.contentId === operation.contentId);
          if (existing) {
            if (existing.accountId !== operation.accountId || existing.contentHash !== operation.contentHash || existing.receiptHash !== receiptHash) throw new ApiError(409, "PUBLICATION_RECEIPT_CONFLICT", "既有发布账本与原始回执不一致。");
            publicationId = existing.id;
          } else {
            const maximum = state.publications.reduce((max, row) => Math.max(max, Number(String(row.id).match(/^PUB-(\d+)$/)?.[1] ?? 0)), 0);
            publicationId = `PUB-${String(maximum + 1).padStart(3, "0")}`;
            state.publications.push({ id: publicationId, contentId: operation.contentId, accountId: operation.accountId,
              platform: operation.platform, url: receipt.url, publishedAt: receipt.publishedAt, capturedBy: receipt.capturedBy,
              dataMode: receipt.dataMode, contentHash: operation.contentHash, receiptHash, recordedAt: now, recordedBy: actor,
              origin: "historical_result_reconciliation", originalContentSnapshot: structuredClone(operation.contentSnapshot),
              ...(isEditorialVariantSchema(operation.snapshotSchema) ? { snapshotSchema: operation.snapshotSchema, editorialSnapshotHash: approvedHash, editorialSnapshot: structuredClone(operation.editorialSnapshot),
                ...(operation.snapshotSchema === EDITORIAL_NATIVE_SCHEMA ? { packageHash: operation.packageHash, reviewSnapshotHash: operation.reviewSnapshotHash, artifactHashes: receipt.artifactHashes } : {}) } : {}) });
          }
          if (unchanged && content.status === "scheduled") Object.assign(content, { status: "published", version: content.version + 1, publicationId, updatedAt: now });
        }
        state.externalResultReconciliations ??= [];
        const reconciliationId = `REC-${String(state.externalResultReconciliations.length + 1).padStart(5, "0")}`;
        const incidentCodes = [...new Set(deviations)];
        state.externalResultReconciliations.push({ id: reconciliationId, operationId: id, approvedSnapshotHash: approvedHash,
          originalAccountSnapshot: structuredClone(operation.accountSnapshot), reason,
          receipt: { ...receipt, receiptHash }, incidentCodes, recordedBy: actor, recordedAt: now });
        operation.receipt = { ...receipt, receiptHash, recordedAt: now, recordedBy: actor };
        operation.publicationId = publicationId; operation.reconciliationId = reconciliationId;
        operation.status = "completed"; operation.updatedAt = now;
        Object.assign(payload, { reconciliationId, receiptHash, publicationId, incidentCodes });
        const result = { ...operation, etag: editorialEtag(operation) };
        state.operationReconciliationRequests.push({ keyHash, requestHash, result: structuredClone(result), at: now });
        return result;
      });
      return result;
    });
  }

  async fail(id, input) {
    safeInput(input);
    const actor = text(input.actor, "actor");
    const reason = text(input.reason, "reason", 2_000);
    return this.#serialize(async () => {
      const { result } = await this.store.mutate(
        { type: "account.operation_failed", actor, payload: { operationId: id } },
        (state) => {
          const row = operationFor(state, id);
          expectedState(row, ["draft", "approved", "in_progress"]);
          if (row.type === "publish" && state.publications.some((item) => item.contentId === row.contentId)) throw new ApiError(409, "PUBLICATION_ALREADY_RECORDED", "发布已入账，请重试原回执以恢复动作状态。");
          row.status = "failed";
          row.failure = { actor, reason, failedAt: this.clock().toISOString() };
          row.updatedAt = this.clock().toISOString();
          return row;
        },
      );
      return result;
    });
  }
}

import { ApiError, PolicyError } from "../domain/errors.mjs";
import { hashObject, hashText } from "../domain/hash.mjs";
import { requirePublicUrl as publicUrl } from "../domain/public-url.mjs";
import { classifyInteraction, scanSensitiveText, validatePublication } from "../domain/policy.mjs";

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
  const serialized = JSON.stringify(input);
  const findings = scanSensitiveText(serialized);
  if (/\b(?:cookie|set-cookie|sessionid|session_id)\s*[:=]\s*\S+/i.test(serialized)) {
    findings.push({ code: "SENSITIVE_CONTENT", kind: "browser_session", message: "不得在运营记录中保存浏览器会话。" });
  }
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
  constructor({ service, clock = () => new Date() }) {
    this.service = service;
    this.store = service.store;
    this.clock = clock;
  }

  list() {
    return this.store.snapshot().accountOperations ?? [];
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
      const { result } = await this.store.mutate(
        { type: "account.operation_approved", actor: approvedBy, payload: { operationId: id } },
        (state) => {
          const row = operationFor(state, id);
          expectedState(row, ["draft"]);
          assertReady(state, row, this.clock());
          row.approval = { approvedBy, authorizationNote, approvedAt: this.clock().toISOString(), contentHash: row.contentHash };
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
      if (!["real", "imported"].includes(source.dataMode)) throw new ApiError(400, "INVALID_RECEIPT_DATA_MODE", "只有 real 或 imported 回执可完成运营动作。");
      if (!["browser_readback", "manual_readback"].includes(source.verificationMethod)) throw new ApiError(400, "RECEIPT_VERIFICATION_REQUIRED", "必须记录由浏览器或本人手工回读核验。");
      const receipt = {
        url: publicUrl(source.url, "receipt.url"),
        publishedAt: timestamp(source.publishedAt, "receipt.publishedAt", this.clock()),
        capturedBy: text(source.capturedBy, "receipt.capturedBy"), dataMode: source.dataMode,
        verificationMethod: source.verificationMethod,
        verifiedAt: timestamp(source.verifiedAt, "receipt.verifiedAt", this.clock()),
        verifiedBy: text(source.verifiedBy, "receipt.verifiedBy"), contentHash: operation.contentHash,
      };
      if (new Date(receipt.verifiedAt).getTime() < new Date(receipt.publishedAt).getTime()) throw new ApiError(400, "RECEIPT_VERIFICATION_BEFORE_PUBLICATION", "回读核验时间不能早于发布时间。");
      if (source.contentHash !== undefined && source.contentHash !== operation.contentHash) throw new ApiError(409, "RECEIPT_CONTENT_MISMATCH", "回执正文哈希与批准的内容不一致。");
      const receiptHash = hashObject(receipt);
      if (operation.status === "completed") {
        if (operation.receipt.receiptHash !== receiptHash) throw new ApiError(409, "RECEIPT_CONFLICT", "动作已完成，不能以不同回执覆盖原记录。");
        return operation;
      }
      expectedState(operation, ["in_progress"]);
      if (state.accountOperations.some((row) => row.id !== id && row.accountId === operation.accountId && row.receipt?.url === receipt.url)) {
        throw new ApiError(409, "DUPLICATE_PLATFORM_RECEIPT", "该平台结果已由另一个动作登记。");
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
          const publication = await this.service.recordPublication({ contentId: operation.contentId, accountId: operation.accountId, actor, receipt });
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

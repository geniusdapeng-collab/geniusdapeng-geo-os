import { CONTENT_TRANSITIONS, CONTENT_STATES } from "./constants.mjs";
import { ApiError, PolicyError } from "./errors.mjs";

export function assertContentState(value) {
  if (!CONTENT_STATES.includes(value)) {
    throw new ApiError(400, "INVALID_CONTENT_STATE", `未知内容状态：${value}`);
  }
}

export function transitionContent(content, target, options, { now = new Date() } = {}) {
  assertContentState(target);

  if (target === "published") {
    throw new PolicyError(
      "PUBLICATION_RECEIPT_REQUIRED",
      "发布必须通过回执接口完成，不能直接切换状态。",
    );
  }

  const allowed = CONTENT_TRANSITIONS[content.status] ?? [];
  if (!allowed.includes(target)) {
    throw new PolicyError(
      "INVALID_TRANSITION",
      `内容不能从 ${content.status} 直接切换到 ${target}。`,
    );
  }

  if (target === "approved" && !options.approvedBy?.trim()) {
    throw new PolicyError("APPROVER_REQUIRED", "进入 approved 前必须记录审批人。");
  }

  return {
    ...content,
    status: target,
    version: content.version + 1,
    updatedAt: now.toISOString(),
    approval:
      target === "approved"
        ? {
            approvedBy: options.approvedBy.trim(),
            approvedAt: now.toISOString(),
            note: options.note?.trim() || "",
          }
        : content.approval ?? null,
  };
}

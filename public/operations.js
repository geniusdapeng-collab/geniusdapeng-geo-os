const labels = { draft: "待授权", approved: "已授权", in_progress: "执行中", completed: "已完成", failed: "已结束 · 未完成" };
const accountLabels = { draft: "未启用", active: "已启用", paused: "已暂停", archived: "已归档" };
const EDITORIAL_SCHEMA = "pengmanager.editorial-snapshot/v2";
const incidentLabels = {
  ACCOUNT_MISSING: "当前账号资料已不存在", ACCOUNT_IDENTITY_CHANGED: "当前账号身份与原授权不同",
  ACCOUNT_NOT_ACTIVE: "当前账号未启用", PLATFORM_POLICY_NOT_REVIEWED: "当前平台规则尚未审阅",
  CURRENT_CONTENT_CHANGED_OR_MISSING: "当前正文已修改或不存在", CURRENT_CLAIM_NOT_VALID: "当前事实依据已失效或不再获准",
};

function html(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function link(url, label = "打开平台结果") {
  try {
    const parsed = new URL(url);
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) return "";
    return `<a class="text-link" href="${html(parsed.href)}" target="_blank" rel="noopener noreferrer">${html(label)} ↗</a>`;
  } catch { return ""; }
}

function time(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "未记录";
}

function localInput(value = new Date()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const item = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${item.year}-${item.month}-${item.day}T${item.hour}:${item.minute}`;
}

function isoInput(value) {
  const date = new Date(`${value}:00+08:00`);
  if (!Number.isFinite(date.getTime())) throw new Error("请填写有效的北京时间。");
  return date.toISOString();
}

function actorField(name, label, person) {
  return `<label><span>${label}</span><input name="${name}" value="${html(person)}" required maxlength="120" autocomplete="name" /></label>`;
}

function feedback() {
  return '<p class="form-error" data-form-error role="alert" hidden></p><p class="form-status" data-form-status aria-live="polite"></p>';
}

export function contentMatchesAccount(content, account) {
  if (!account || account.status === "archived") return false;
  if (content.editionId) return content.accountSnapshot?.id === account.id && content.destinationSnapshot?.accountId === account.id;
  return content.platforms?.includes(account.platform) === true;
}

function approvedSnapshotHash(row) { return row.snapshotSchema === EDITORIAL_SCHEMA ? row.editorialSnapshotHash : row.contentHash; }

export function operationMediaReferences(row) {
  if (row.snapshotSchema !== EDITORIAL_SCHEMA) return [];
  return [...new Map((row.editorialSnapshot?.assetRefs || []).map(ref => [`${ref.assetId}:${ref.sha256}`, ref])).values()]
    .sort((a, b) => a.assetId.localeCompare(b.assetId));
}

function originalEditorialSnapshot(row) {
  if (row.snapshotSchema !== EDITORIAL_SCHEMA) return "";
  const snapshot = row.editorialSnapshot || {};
  return `<details class="operation-snapshot"><summary>查看原获准的完整编辑快照、目的地与媒体</summary><p class="operation-note">${html(snapshot.locale)} · ${html(snapshot.format)} · ${html(snapshot.destinationId || row.destinationId)}</p><div class="operation-body">${html(snapshot.summary || "")}</div><h4>原页面结构与全部文字</h4><pre class="operation-structured-source">${html(JSON.stringify(snapshot.blocks || [], null, 2))}</pre><h4>原媒体顺序、替代文字、图注与字幕语言</h4><pre class="operation-structured-source">${html(JSON.stringify(snapshot.assetRefs || [], null, 2))}</pre><h4>原发布目的地</h4><pre class="operation-structured-source">${html(JSON.stringify(snapshot.destinationSnapshot || {}, null, 2))}</pre><p class="operation-hash">完整编辑快照 SHA-256 <code>${html(row.editorialSnapshotHash)}</code></p></details>`;
}

function mediaReadbackFields(row) {
  const references = operationMediaReferences(row);
  if (!references.length) return "";
  return `<fieldset class="operation-media-readback"><legend>逐项实际核对原素材在平台的呈现</legend><p class="operation-note">请在真实平台打开并核对图序、画面、图注及字幕。下方摘要标识原定稿素材；勾选表示你实际完成了比对，服务器不会代替你打开外部平台。</p>${references.map(ref => `<div><p><strong>${html(ref.assetId)} · ${html(ref.role)}${ref.locale ? ` · ${html(ref.locale)}` : ""}</strong></p><p>${html(ref.alt || ref.caption || "原快照未附文字说明")}</p><a class="text-link" href="/api/media/assets/${encodeURIComponent(ref.assetId)}/bytes" target="_blank" rel="noopener noreferrer">打开原定稿素材 ↗</a><code>${html(ref.sha256)}</code><label class="check-label"><input type="checkbox" name="assetConfirmed-${html(ref.assetId)}" value="${html(ref.sha256)}" required /><span>我已在实际平台核对此项素材与原获准版本一致。</span></label></div>`).join("")}</fieldset>`;
}

function actualReceiptFields() {
  return `<div class="form-grid">
    <label class="wide"><span>已经实际发布的公开结果链接</span><input type="url" name="url" required maxlength="2000" placeholder="填写实际打开并核对过的结果地址" /></label>
    <label><span>真实发布时间（北京时间）</span><input type="datetime-local" name="publishedAt" required /></label>
    <label><span>实际发布 / 采集人</span><input name="capturedBy" required maxlength="120" autocomplete="off" /></label>
    <label><span>真实数据来源</span><select name="dataMode" required><option value="">选择这份回执的真实来源</option><option value="real">real · 本次实际执行后采集</option><option value="imported">imported · 导入已发生的真实记录</option></select></label>
    <label><span>本次实际回读方式</span><select name="verificationMethod" required><option value="">选择实际完成的核对方式</option><option value="browser_readback">浏览器打开结果并核对</option><option value="manual_readback">本人手工打开结果并核对</option></select></label>
    <label><span>真实回读时间（北京时间）</span><input type="datetime-local" name="verifiedAt" required /></label>
    <label><span>实际回读核验人</span><input name="verifiedBy" required maxlength="120" autocomplete="off" /></label>
  </div>`;
}

export function buildOperationReceipt(row, fields) {
  const value = name => String(fields[name] || "");
  if (fields.contentConfirmed !== "on") throw new Error("请实际核对原完整标题、正文与媒体后，再确认回读声明。");
  for (const name of ["url", "publishedAt", "capturedBy", "verifiedAt", "verifiedBy"]) if (!value(name).trim()) throw new Error("请完整填写真实结果、实际时间及采集 / 核验人，不使用默认值替代。");
  if (!["real", "imported"].includes(value("dataMode")) || !["browser_readback", "manual_readback"].includes(value("verificationMethod"))) throw new Error("请选择回执的真实来源和实际回读方式。");
  const publishedAt = isoInput(value("publishedAt")), verifiedAt = isoInput(value("verifiedAt"));
  if (Date.parse(verifiedAt) < Date.parse(publishedAt)) throw new Error("实际回读时间不能早于真实发布时间。");
  const receipt = { url: value("url"), publishedAt, capturedBy: value("capturedBy"), dataMode: value("dataMode"), verificationMethod: value("verificationMethod"), verifiedAt, verifiedBy: value("verifiedBy"), contentHash: row.contentHash };
  if (row.snapshotSchema !== undefined) {
    if (row.snapshotSchema !== EDITORIAL_SCHEMA || !row.editorialSnapshotHash || !row.editorialSnapshot) throw new Error("原完整编辑快照不完整，不能登记此回执。请先核对原授权记录。");
    const references = operationMediaReferences(row);
    for (const ref of references) if (fields[`assetConfirmed-${ref.assetId}`] !== ref.sha256) throw new Error(`请在实际平台核对原素材 ${ref.assetId}，不能只凭附件存在就确认。`);
    receipt.editorialSnapshotHash = row.editorialSnapshotHash;
    receipt.assetHashes = references.map(ref => ({ assetId: ref.assetId, sha256: ref.sha256 }));
  }
  return receipt;
}

export function buildReconciliationInput(row, fields) {
  if (!row.approval || !row.execution || !row.accountSnapshot || !["in_progress", "completed"].includes(row.status)) throw new Error("缺少原授权、执行或账号快照，不能使用历史结果调和。");
  if (fields.accountConfirmed !== "on") throw new Error("请实际核对原账号身份后再确认，当前同平台账号不能代替原账号。");
  if (!String(fields.reason || "").trim()) throw new Error("请说明为何普通完成流程无法准确恢复这份真实结果。");
  if (!approvedSnapshotHash(row) || fields.approvedSnapshotHash !== approvedSnapshotHash(row)) throw new Error("原获准快照已变化，请刷新并重新核对，不覆盖旧授权。");
  return { approvedSnapshotHash: approvedSnapshotHash(row), accountConfirmed: true, contentConfirmed: true, receipt: buildOperationReceipt(row, fields), reason: fields.reason };
}

export function createOperationReconciler({ api, createKey = () => {
  if (!globalThis.crypto?.randomUUID) throw new Error("当前页面无法生成安全请求标识，请使用 HTTPS 管理后台。");
  return `web-${globalThis.crypto.randomUUID()}`;
} }) {
  const attempts = new Map();
  return async (row, input) => {
    const signature = `${row.id}:${JSON.stringify(input)}`;
    let attempt = attempts.get(signature);
    if (!attempt) {
      if (!row.etag) throw new Error("当前动作缺少版本校验值，请刷新并重新核对。");
      attempt = { key: createKey(), etag: row.etag };
      attempts.set(signature, attempt);
    }
    try {
      const result = await api(`/api/operations/${encodeURIComponent(row.id)}/reconcile`, { method: "POST", headers: { "Idempotency-Key": attempt.key, "If-Match": attempt.etag }, body: JSON.stringify(input) });
      attempts.delete(signature);
      return result;
    } catch (error) {
      if (error.status >= 400 && error.status < 500) attempts.delete(signature);
      throw error;
    }
  };
}

function approvalForm(row, person) {
  return `<details class="operation-action"><summary>授权这一次${row.type === "publish" ? "发布" : "回复"}</summary>
    <form data-operation-form="approve" data-operation-id="${html(row.id)}" class="operation-inline-form">
      ${actorField("approvedBy", "授权人", person)}
      <label><span>本次授权范围</span><textarea name="authorizationNote" required maxlength="2000" rows="3" placeholder="例如：允许 Codex 使用本机已登录的该账号，发布上方精确正文一次。"></textarea></label>
      <label class="check-label"><input type="checkbox" required /><span>我已核对目标账号和完整正文，授权执行这一次动作。</span></label>
      ${feedback()}<button class="primary-button" type="submit">确认授权</button>
    </form></details>`;
}

function receiptForm(row) {
  return `<details class="operation-action"><summary>登记完成回执</summary>
    <form data-operation-form="complete" data-operation-id="${html(row.id)}" data-snapshot-hash="${html(approvedSnapshotHash(row))}" class="operation-inline-form">
      <p class="operation-note">先打开平台结果，核对原账号、完整正文、素材与发布状态。请填写实际发生的时间与人员；后台保存你的回读记录，不会代替你核验外部页面。</p>
      ${actualReceiptFields()}${mediaReadbackFields(row)}
      <label><span>实际后台登记人</span><input name="actor" required maxlength="120" autocomplete="off" /></label>
      <label class="check-label"><input type="checkbox" name="contentConfirmed" required /><span>我已打开真实平台结果，核对上方原获准的完整标题、正文、结构与全部媒体，确认本次实际结果一致。</span></label>
      ${feedback()}<button class="primary-button" type="submit">保存真实回执并完成</button>
    </form></details>`;
}

function reconciliationForm(row) {
  if (row.status !== "in_progress" || !row.approval || !row.execution || !row.accountSnapshot) return "";
  return `<details class="operation-action operation-reconciliation"><summary>原结果已发生、普通完成受阻：管理员调和</summary>
    <form data-operation-form="reconcile" data-operation-id="${html(row.id)}" data-operation-etag="${html(row.etag || "")}" data-snapshot-hash="${html(approvedSnapshotHash(row))}" class="operation-inline-form">
      <p class="operation-note">仅用于原授权与实际执行已经存在、外部结果确实发生，但账号或正文等变化阻断普通完成的情况。请先核对原结果。此操作只补齐原回执与偏差记录，不重新发布，不批准新正文，也不把当前账号改成原账号。</p>
      <p class="operation-hash">本次绑定原获准快照 SHA-256 <code>${html(approvedSnapshotHash(row))}</code></p>
      <input type="hidden" name="approvedSnapshotHash" value="${html(approvedSnapshotHash(row))}" />
      <label class="check-label"><input type="checkbox" name="accountConfirmed" required /><span>我已在真实平台核对原账号 ${html(row.accountSnapshot.handle)}（${html(row.accountSnapshot.id)}）与上方原主页，确认这份结果属于原授权账号。</span></label>
      ${actualReceiptFields()}${mediaReadbackFields(row)}
      <label class="check-label"><input type="checkbox" name="contentConfirmed" required /><span>我已对照原完整正文、结构、语言、目的地与全部媒体，确认实际结果对应原获准版本，未用当前修改后的正文替代。</span></label>
      <label><span>普通完成受阻的实际原因与本次核对依据</span><textarea name="reason" required maxlength="2000" rows="4" placeholder="只记录已查明的真实情况，不填写令牌、Cookie、私密联系资料或虚构审批。"></textarea></label>
      <p class="operation-field-hint">管理员身份由本次登录会话记录。若结果仍不明确，先保留执行中状态继续核对，不能用失败或调和清除未知结果。</p>
      ${feedback()}<button class="ghost-button" type="submit"${row.etag ? "" : " disabled"}>登记原真实结果与偏差 · 不重新发布</button>
      ${!row.etag ? '<p class="form-error">当前动作缺少版本校验值，请刷新并核对服务版本后再处理。</p>' : ""}
    </form></details>`;
}

function failureForm(row, person) {
  return `<details class="operation-action operation-danger"><summary>记录失败 / 结束动作</summary>
    <form data-operation-form="fail" data-operation-id="${html(row.id)}" class="operation-inline-form">
      ${actorField("actor", "记录人", person)}
      <label><span>实际原因</span><textarea name="reason" rows="3" required maxlength="2000" placeholder="记录未完成的原因。若平台已经发布成功，请登记原始回执，避免重复发布。"></textarea></label>
      ${feedback()}<button class="ghost-button" type="submit">记录并结束</button>
    </form></details>`;
}

export function renderOperations(rows, { profile = {}, accounts = [], content = null } = {}) {
  const person = profile.nameZh || "李大鹏";
  if (!rows.length) return '<div class="empty-panel operation-empty"><strong>还没有运营动作</strong><p>先准备一条已排期内容，或新建一次回复。完成授权、实际执行与回读后，真实结果会保存在这里。</p></div>';
  return [...rows].reverse().map((row) => {
    const account = accounts.find((item) => item.id === row.accountId);
    const expectedAccount = row.accountSnapshot ?? account;
    const identityChanged = row.accountSnapshot && (!account || row.accountSnapshot.platform !== account.platform ||
      row.accountSnapshot.handle !== account.handle || row.accountSnapshot.profileUrl !== (account.profileUrl ?? ""));
    const currentContent = content?.find(item => item.id === row.contentId);
    const contentChanged = content && row.type === "publish" && (!currentContent || currentContent.title !== row.contentSnapshot?.title || currentContent.body !== row.contentSnapshot?.body ||
      row.snapshotSchema === EDITORIAL_SCHEMA && currentContent.snapshotHash !== row.editorialSnapshotHash);
    const title = row.type === "publish" ? row.contentSnapshot?.title || row.contentId : "回复评论 / 帖子";
    const body = row.type === "publish" ? row.contentSnapshot?.body : row.replyText;
    const approval = row.approval;
    const receipt = row.receipt;
    return `<article class="operation-card" data-operation-card="${html(row.id)}">
      <div class="operation-card-heading"><div><p class="eyebrow">${html(row.id)} · ${html(row.platform)}</p><h3>${html(title)}</h3><p class="operation-subtitle">${html(expectedAccount?.handle || row.accountId)} · ${row.executionMode === "browser" ? "本机浏览器执行" : "本人手工执行"}</p></div><span class="status-chip ${html(row.status)}">${html(labels[row.status] || row.status)}</span></div>
      ${identityChanged && ["draft", "approved", "in_progress"].includes(row.status) ? `<p class="form-error">此动作建立后，账号 handle 或主页已变化。${row.status === "in_progress" ? "先核对原外部结果；结果已发生时处理原回执，不要再次发布。" : "旧授权不适用于新账号，请核对原账号并重新建立动作。"}</p>` : ""}
      ${contentChanged && row.status === "in_progress" ? '<p class="form-error">当前内容已不同于原获准快照，或已不存在。先核对外部是否已经成功；原结果已发生时可由管理员调和，不能重新发帖来补账。</p>' : ""}
      <div class="operation-original-account"><strong>原授权账号</strong><p>${html(expectedAccount?.platform || row.platform)} · ${html(expectedAccount?.handle || row.accountId)} · ${html(expectedAccount?.id || row.accountId)}</p>${expectedAccount?.profileUrl ? link(expectedAccount.profileUrl, "打开原授权主页核对") : '<p class="operation-field-hint">原记录未提供可打开的主页，不能用当前相似账号补造原身份。</p>'}</div>
      ${row.targetUrl ? `<div class="operation-target">${link(row.targetUrl, "打开要回复的帖子 / 评论")}</div>` : ""}
      <details class="operation-snapshot"><summary>查看完整${row.type === "publish" ? "发布内容" : "回复正文"}与校验哈希</summary><div class="operation-body">${html(body)}</div><p class="operation-hash">正文 SHA-256 <code>${html(row.contentHash)}</code></p></details>
      ${originalEditorialSnapshot(row)}
      <dl class="operation-facts"><div><dt>创建</dt><dd>${html(row.createdBy)} · ${html(time(row.createdAt))}</dd></div>
      ${approval ? `<div><dt>授权</dt><dd>${html(approval.approvedBy)} · ${html(time(approval.approvedAt))}<p>${html(approval.authorizationNote)}</p></dd></div>` : ""}
      ${row.execution ? `<div><dt>执行</dt><dd>${html(row.execution.actor)} · ${html(time(row.execution.startedAt))}</dd></div>` : ""}</dl>
      ${receipt ? `<div class="operation-receipt"><span class="eyebrow">已登记完成回执 · ${html(receipt.dataMode)}</span><p>${link(receipt.url)}</p><dl class="operation-facts"><div><dt>发布</dt><dd>${html(receipt.capturedBy)} · ${html(time(receipt.publishedAt))}</dd></div><div><dt>回读</dt><dd>${receipt.verificationMethod === "browser_readback" ? "浏览器回读" : "本人手工回读"} · ${html(receipt.verifiedBy)} · ${html(time(receipt.verifiedAt))}</dd></div><div><dt>登记</dt><dd>${html(receipt.recordedBy)} · ${html(time(receipt.recordedAt))}</dd></div></dl><p class="operation-field-hint">以上为执行者登记的核验记录。</p></div>` : ""}
      ${row.failure ? `<div class="operation-failure"><strong>未完成原因</strong><p>${html(row.failure.reason)}</p><small>${html(row.failure.actor)} · ${html(time(row.failure.failedAt))}</small></div>` : ""}
      ${row.reconciliationId ? `<div class="operation-recovered"><strong>原结果已调和 · ${html(row.reconciliationId)}</strong><p>已保留原授权与回执，并登记本次偏差；没有重新发布。当前账号、正文与事实仍按各自的现状处理。</p>${row.reconciliation ? `<p>${html(row.reconciliation.reason)} · ${html(row.reconciliation.recordedBy)} · ${html(time(row.reconciliation.recordedAt))}</p>${row.reconciliation.incidentCodes?.length ? `<ul>${row.reconciliation.incidentCodes.map(code => `<li>${html(incidentLabels[code] || code)}</li>`).join("")}</ul>` : '<p>本次调和未记录额外偏差。</p>'}` : '<p>偏差详情以管理员事件记录为准。</p>'}</div>` : ""}
      ${row.classification?.level === "L0" ? '<p class="operation-note">此互动涉及高风险事项，只能由本人手工处理。</p>' : ""}
      ${row.status === "draft" ? approvalForm(row, person) : ""}
      ${row.status === "approved" ? `<form data-operation-form="start" data-operation-id="${html(row.id)}" class="operation-inline-form"><p class="operation-note">标记后，请在本机浏览器实际执行这一次动作。此按钮不会触发外部发布。</p>${actorField("actor", "实际执行人", person)}${feedback()}<button class="primary-button" type="submit">标记开始执行</button></form>` : ""}
      ${row.status === "in_progress" ? receiptForm(row) : ""}
      ${reconciliationForm(row)}
      ${["draft", "approved", "in_progress"].includes(row.status) ? failureForm(row, person) : ""}
    </article>`;
  }).join("");
}

export function mountOperations({ api, getData, reload, showError, profile }) {
  let rows = [];
  let loading = false;
  const receiptDrafts = new Map();
  const reconcileOperation = createOperationReconciler({ api });
  const form = document.querySelector("#operation-create-form");
  const person = () => (typeof profile === "function" ? profile() : profile) ?? {};
  const data = () => getData() ?? { accounts: [], content: [], claims: [], interactions: [] };
  const receiptFormKey = item => `${item.dataset.operationForm}:${item.dataset.operationId}:${item.dataset.snapshotHash || ""}`;

  function captureReceiptDrafts() {
    for (const item of document.querySelectorAll('[data-operation-form="complete"], [data-operation-form="reconcile"]')) {
      receiptDrafts.set(receiptFormKey(item), [...item.elements].filter(field => field.name && field.type !== "checkbox" && field.type !== "hidden").map(field => ({ name: field.name, value: field.value })));
    }
  }

  function restoreReceiptDrafts() {
    for (const item of document.querySelectorAll('[data-operation-form="complete"], [data-operation-form="reconcile"]')) {
      const draft = receiptDrafts.get(receiptFormKey(item));
      if (!draft) continue;
      for (const field of item.elements) {
        if (!field.name || field.type === "checkbox" || field.type === "hidden") continue;
        const saved = draft.find(value => value.name === field.name);
        if (saved) field.value = saved.value;
      }
    }
  }

  async function submit(formElement, callback) {
    const controls = [...formElement.querySelectorAll("button, input, select, textarea")].map((element) => [element, element.disabled]);
    const errorPanel = formElement.querySelector("[data-form-error]");
    const status = formElement.querySelector("[data-form-status]");
    if (errorPanel) { errorPanel.hidden = true; errorPanel.textContent = ""; }
    formElement.setAttribute("aria-busy", "true");
    for (const [element] of controls) element.disabled = true;
    if (status) status.textContent = "正在保存…";
    try {
      await callback();
      await reload();
      return true;
    } catch (error) {
      const findings = error.details?.findings?.map((item) => item.message).filter(Boolean).join("；");
      const uncertain = ["complete", "reconcile"].includes(formElement.dataset.operationForm) && (error.status >= 500 || ["TypeError", "SyntaxError", "NetworkError"].includes(error.name));
      const message = `${error.message}${findings ? ` ${findings}` : ""}${uncertain ? " 结果尚未确认，请先刷新原动作核对；不要重新发布。重试时保留原回执与实际时间，调和会沿用原请求标识。" : ""}`;
      if (errorPanel?.isConnected) {
        errorPanel.textContent = message;
        errorPanel.hidden = false;
        errorPanel.tabIndex = -1;
        errorPanel.focus();
      } else showError(new Error(message));
      if (status) status.textContent = "未保存，请根据提示调整后重试。";
      return false;
    } finally {
      formElement.removeAttribute("aria-busy");
      for (const [element, disabled] of controls) if (element.isConnected) element.disabled = disabled;
      if (status?.isConnected && status.textContent === "正在保存…") status.textContent = "已保存。";
    }
  }

  function updateCreateFields() {
    if (!form) return;
    const publish = form.elements.type.value === "publish";
    for (const label of form.querySelectorAll("[data-publish-field], [data-reply-field]")) {
      const active = label.hasAttribute("data-publish-field") ? publish : !publish;
      label.hidden = !active;
      for (const element of label.querySelectorAll("input, textarea, select")) {
        element.disabled = !active;
        element.required = active && element.name !== "interactionId";
      }
    }
    const current = data();
    const account = current.accounts.find((item) => item.id === form.elements.accountId.value);
    const selectedContent = form.elements.contentId.value;
    const available = current.content.filter((item) => item.status === "scheduled" && contentMatchesAccount(item, account) && !rows.some((row) => row.type === "publish" && row.contentId === item.id && row.status !== "failed"));
    form.elements.contentId.innerHTML = available.length ? available.map((item) => `<option value="${html(item.id)}">${html(item.title)} · ${html(item.id)}</option>`).join("") : '<option value="">该账号还没有可发布的已排期内容</option>';
    if (available.some((item) => item.id === selectedContent)) form.elements.contentId.value = selectedContent;
    form.querySelector('button[type="submit"]').disabled = !account || (publish && !available.length);
    document.querySelector("#operation-content-hint").innerHTML = available.length ? "一条内容只对应一次账号发布。请核对下面的正文，再提交草稿。" : '先在<a class="text-link" href="#content">内容工厂</a>完成 Claim 审批、内容批准与排期。已有动作的内容不会重复列出。';
    let preview = form.querySelector(".operation-create-preview");
    if (!preview) { preview = document.createElement("div"); preview.className = "operation-create-preview wide"; form.querySelector(".form-grid").append(preview); }
    const content = available.find((item) => item.id === form.elements.contentId.value);
    preview.hidden = !publish || !content;
    preview.innerHTML = content ? `<strong>${html(content.title)}</strong><div class="operation-body">${html(content.body)}</div>` : "";
  }

  function renderCreate() {
    const current = data();
    const selected = form.elements.accountId.value;
    form.elements.accountId.innerHTML = current.accounts.filter(account => account.status !== "archived").map((account) => `<option value="${html(account.id)}">${html(account.platform)} · ${html(account.handle)} · ${html(accountLabels[account.status] || account.status)}</option>`).join("");
    if (current.accounts.some((item) => item.id === selected && item.status !== "archived")) form.elements.accountId.value = selected;
    if (!form.elements.actor.value) form.elements.actor.value = person().nameZh || "李大鹏";
    form.elements.interactionId.innerHTML = '<option value="">不关联已有互动</option>' + current.interactions.map((item) => `<option value="${html(item.id)}">${html(item.id)} · ${html(item.text.slice(0, 60))}</option>`).join("");
    updateCreateFields();
  }

  function renderClaims() {
    const target = document.querySelector("#claim-approval-list");
    target.innerHTML = data().claims.length ? data().claims.map((claim) => {
      const approved = claim.state === "approved";
      return `<details class="claim-review">
        <summary><span><strong>${html(claim.id)}</strong> ${html(claim.text)}</span><span class="status-chip ${approved ? "approved" : "draft"}">${approved ? "已批准" : claim.state === "retired" ? "已退役" : "待核对批准"}</span></summary>
        <div class="claim-source">
          <p>${html(claim.source?.label || "来源未提供说明")}</p>${link(claim.source?.url, "查看事实来源")}
          ${claim.approvedBy ? `<p>审批人 ${html(claim.approvedBy)} · ${html(time(claim.approvedAt))}</p>` : ""}
          <p>${claim.publicLevel === "approved_public" ? "已批准公开；公开主页仍会检查来源、有效期与敏感信息。" : "当前仅在后台使用。"}</p>
        </div>
        <form data-claim-approval="${html(claim.id)}" class="operation-inline-form">
          ${actorField("approvedBy", approved ? "复核人" : "审批人", person().nameZh || "李大鹏")}
          <label><span>事实公开级别</span><select name="publicLevel"><option value="private" ${claim.publicLevel === "approved_public" ? "" : "selected"}>仅在后台使用</option><option value="approved_public" ${claim.publicLevel === "approved_public" ? "selected" : ""}>允许公开导出（需公开来源）</option></select></label>
          <label class="check-label"><input type="checkbox" required /><span>我已核对事实、来源与所选公开范围。</span></label>
          ${feedback()}<button class="primary-button" type="submit">${approved ? "复核并更新公开范围" : "批准这条事实"}</button>
        </form>
      </details>`;
    }).join("") : '<div class="empty-panel">暂无事实条目。纯观点内容可以不绑定 Claim。</div>';
  }

  function decorateAccounts() {
    for (const card of document.querySelectorAll("#account-grid [data-account-id]")) {
      card.querySelector(".account-settings")?.remove();
      const account = data().accounts.find((item) => item.id === card.dataset.accountId);
      if (!account) continue;
      const date = account.policyCheckedAt ? localInput(account.policyCheckedAt).slice(0, 10) : "";
      card.insertAdjacentHTML("beforeend", `<details class="account-settings"><summary>运营设置</summary><form data-account-settings="${html(account.id)}" class="operation-inline-form">
        <label><span>实际账号 handle</span><input name="handle" value="${html(account.handle)}" required maxlength="160" /></label>
        <label><span>公开个人主页（可选）</span><input name="profileUrl" type="url" value="${html(account.profileUrl || "")}" placeholder="https://平台/我的主页" maxlength="2000" /></label>
        <label><span>账号状态</span><select name="status">${Object.entries(accountLabels).map(([value, label]) => `<option value="${value}" ${account.status === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
        <p class="operation-field-hint">当前身份：${account.identityReview?.status === "verified" ? "已核对" : "待核对"}；规则：${account.policyStatus === "reviewed" ? "已审阅" : "待审阅"}。修改资料不会自动制造核对记录；身份变化后旧审批可能失效。</p>
        <label class="check-label"><input type="checkbox" name="identityConfirmed" /><span>本次已实际打开并核对这个账号的身份。</span></label>
        <label class="check-label"><input type="checkbox" name="policyReviewed" /><span>本次已实际重新审阅该平台规则。</span></label>
        <label><span>实际规则审阅日期（北京时间；本次勾选规则审阅时必填）</span><input name="policyCheckedAt" type="date" value="${html(date)}" /></label>
        <label><span>本次核对说明（勾选身份或规则核对时必填）</span><textarea name="reviewNote" rows="2" maxlength="2000"></textarea></label>
        <label><span>暂停 / 归档原因（对应状态必填）</span><textarea name="reason" rows="2" maxlength="2000"></textarea></label>
        <p class="operation-field-hint">变更以当前登录的管理会话记录。归档不会删除历史；执行结果未明时先去运营动作核对。完整目的地和账号历史见编辑出版。</p>
        ${account.profileUrl ? link(account.profileUrl, "打开账号主页") : ""}${feedback()}<button class="primary-button" type="submit">保存运营设置</button></form></details>`);
    }
  }

  function renderContentControls() {
    const next = { draft: ["fact_check", "送交事实核验"], fact_check: ["approved", "批准此内容"], approved: ["scheduled", "确认排期"], blocked: ["draft", "返回草稿"] };
    for (const card of document.querySelectorAll("#content-list [data-content-id]")) {
      card.querySelector(".operation-content-controls")?.remove();
      const content = data().content.find((item) => item.id === card.dataset.contentId);
      if (!content) continue;
      if (content.editionId && (content.status !== "scheduled" && content.status !== "published" || content.destinationSnapshot?.kind === "owned_origin")) {
        card.insertAdjacentHTML("beforeend", '<div class="operation-content-controls"><p class="operation-note">这是独立语言 / 渠道版本，必须按完整正文与素材校验值审阅。</p><a class="text-link" href="#editorial">进入编辑出版核对当前精确版本 →</a></div>');
        continue;
      }
      const action = next[content.status];
      const pending = content.claimIds.filter((id) => !data().claims.some((claim) => claim.id === id && claim.state === "approved"));
      let markup = "";
      if (action) markup = `<form data-content-transition-form="${html(content.id)}" class="operation-inline-form"><input type="hidden" name="target" value="${action[0]}" />${actorField("actor", action[0] === "approved" ? "审批人" : "操作者", person().nameZh || "李大鹏")}${action[0] === "approved" ? '<label class="check-label"><input type="checkbox" required /><span>我已核对完整正文、事实依据及目标平台。</span></label>' : ""}${action[0] === "approved" && pending.length ? `<p class="operation-field-hint">请先批准事实：${html(pending.join("、"))}。</p>` : ""}${feedback()}<button class="primary-button" type="submit" ${action[0] === "approved" && pending.length ? "disabled" : ""}>${action[1]}</button></form>`;
      else if (content.status === "scheduled") markup = `<p class="operation-note">已通过内容审批与排期，可以准备一次账号发布。</p><button class="primary-button" data-prepare-publication="${html(content.id)}" type="button">建立发布动作</button>`;
      else if (content.status === "published") {
        const publication = data().publications?.find((item) => item.id === content.publicationId);
        markup = publication ? `${link(publication.url)}<p class="operation-field-hint">${html(time(publication.publishedAt))} · ${html(publication.dataMode)}</p>` : '<p class="operation-field-hint">已发布；请在运营动作中查看完整回执。</p>';
      }
      card.insertAdjacentHTML("beforeend", `<div class="operation-content-controls">${markup}</div>`);
    }
  }

  function render() {
    captureReceiptDrafts();
    document.querySelector("#operation-count").textContent = `${rows.length} 次动作 · ${rows.filter((row) => row.status === "completed").length} 次已完成`;
    document.querySelector("#operations-list").innerHTML = renderOperations(rows, { profile: person(), accounts: data().accounts, content: data().content });
    restoreReceiptDrafts();
    renderCreate();
    renderClaims();
    decorateAccounts();
    renderContentControls();
  }

  form.addEventListener("change", updateCreateFields);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const fields = new FormData(form);
    const input = Object.fromEntries(fields);
    if (input.type === "publish") { delete input.replyText; delete input.targetUrl; delete input.interactionId; }
    else delete input.contentId;
    const saved = await submit(form, () => api("/api/operations", { method: "POST", body: JSON.stringify(input) }));
    if (saved) { form.reset(); renderCreate(); document.querySelector("#operations-list").scrollIntoView({ behavior: "smooth", block: "start" }); }
  });

  document.addEventListener("submit", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLFormElement)) return;
    const action = target.dataset.operationForm;
    const accountId = target.dataset.accountSettings;
    const claimId = target.dataset.claimApproval;
    const contentId = target.dataset.contentTransitionForm;
    if (!action && !accountId && !claimId && !contentId) return;
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(target));
    if (["complete", "reconcile"].includes(action)) captureReceiptDrafts();
    await submit(target, async () => {
      if (accountId) {
        const path = `/api/accounts/${encodeURIComponent(accountId)}`;
        const input = { handle: fields.handle, profileUrl: fields.profileUrl || "", status: fields.status };
        if (fields.identityConfirmed === "on") input.identityConfirmed = true;
        if (fields.policyReviewed === "on") {
          if (!fields.policyCheckedAt) throw new Error("请填写实际规则审阅日期。");
          input.policyStatus = "reviewed";
          input.policyCheckedAt = `${fields.policyCheckedAt}T00:00:00+08:00`;
        }
        if (input.identityConfirmed || input.policyStatus === "reviewed") {
          if (!String(fields.reviewNote || "").trim()) throw new Error("请说明本次实际身份 / 规则核对的依据。");
          input.reviewNote = fields.reviewNote;
        }
        if (["paused", "archived"].includes(input.status) && !String(fields.reason || "").trim()) throw new Error("请填写暂停或归档原因。");
        if (String(fields.reason || "").trim()) input.reason = fields.reason;
        const signature = JSON.stringify(input);
        if (target.dataset.requestBody !== signature || !target.dataset.requestKey || !target.dataset.requestEtag) {
          const current = await api(path);
          const previous = data().accounts.find(account => account.id === accountId);
          if (!current.etag) throw new Error("账号缺少版本校验值，请刷新后在编辑出版中操作。");
          if (previous && ["handle", "profileUrl", "status", "identityVersion", "revision"].some(key => (previous[key] ?? "") !== (current[key] ?? ""))) throw new Error("账号资料已被更新。请刷新并重新核对当前身份，避免覆盖其他修改。");
          if (!globalThis.crypto?.randomUUID) throw new Error("当前页面无法生成安全请求标识，请使用 HTTPS 管理后台。");
          target.dataset.requestBody = signature;
          target.dataset.requestKey = `web-${globalThis.crypto.randomUUID()}`;
          target.dataset.requestEtag = current.etag;
        }
        let result;
        try {
          result = await api(path, { method: "PATCH", headers: { "If-Match": target.dataset.requestEtag, "Idempotency-Key": target.dataset.requestKey }, body: signature });
        } catch (error) {
          if (error.status >= 400 && error.status < 500) {
            delete target.dataset.requestBody; delete target.dataset.requestKey; delete target.dataset.requestEtag;
          }
          throw error;
        }
        delete target.dataset.requestBody; delete target.dataset.requestKey; delete target.dataset.requestEtag;
        return result;
      }
      if (claimId) return api(`/api/claims/${encodeURIComponent(claimId)}/approve`, { method: "POST", body: JSON.stringify(fields) });
      if (contentId) return api(`/api/content/${encodeURIComponent(contentId)}/transition`, { method: "POST", body: JSON.stringify({ ...fields, approvedBy: fields.actor }) });
      const id = target.dataset.operationId;
      let input = fields;
      if (action === "reconcile") {
        const operation = rows.find(row => row.id === id);
        if (!operation) throw new Error("原动作已变化，请刷新并核对记录。");
        return reconcileOperation({ ...operation, etag: target.dataset.operationEtag }, buildReconciliationInput(operation, fields));
      }
      if (action === "complete") {
        const operation = rows.find((row) => row.id === id);
        if (!operation) throw new Error("原动作已变化，请刷新并核对记录。");
        input = { actor: fields.actor, receipt: buildOperationReceipt(operation, fields) };
      }
      return api(`/api/operations/${encodeURIComponent(id)}/${action}`, { method: "POST", body: JSON.stringify(input) });
    });
  });

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-prepare-publication]");
    if (!button) return;
    const content = data().content.find((item) => item.id === button.dataset.preparePublication);
    const account = data().accounts.find((item) => content && contentMatchesAccount(content, item));
    if (!content || !account) return;
    form.elements.type.value = "publish";
    form.elements.accountId.value = account.id;
    updateCreateFields();
    form.elements.contentId.value = content.id;
    updateCreateFields();
    window.location.hash = "operations";
    requestAnimationFrame(() => form.scrollIntoView({ behavior: "smooth", block: "start" }));
  });

  return {
    render,
    async load() {
      if (loading) return;
      loading = true;
      try { rows = await api("/api/operations"); }
      finally { loading = false; }
    },
  };
}

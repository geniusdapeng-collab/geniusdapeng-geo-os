const html = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
const LABELS = {
  idle: "等待任务", queued: "排队中", planning: "平台策划", drafting: "深度改写", checking: "独立核验", revising: "返修中", polishing: "最终润色", final_checking: "独立终检", running: "执行中", leased: "工位已领取", pending: "等待依赖", succeeded: "步骤完成", completed: "准备完成", ready_for_review: "等待完整人审", materialized: "已转待核草稿", skipped: "已跳过", skip: "跳过", needs_input: "等待真实输入", blocked: "已阻断", blocked_budget: "预算待配置", failed: "失败", cancelled: "已取消", cancel_requested: "取消已记录", deadline_exceeded: "已到期", needs_reconcile: "需要核对原结果", unknown: "结果未知", unknown_usage: "用量未知 · 预留保留", reserved: "已预留", settled: "已结算", approved: "已批准", draft: "草稿", reviewed: "使用范围已审", revoked: "已撤销", staged: "待使用权审核", committed: "真实文件已入库", active: "有效", expired: "已过期", passed: "通过", failed_known: "已知失败", unverified: "未验证", prepare: "准备", prepare_only: "仅准备", manual_only: "仅人工外发", separately_authorized: "外发另行授权", ineligible: "不适用", ai_assisted_draft: "允许范围内辅助起草", author_led_editor_assist: "作者主导，限定编辑辅助", human_original_copyedit: "本人原稿限定校对", human_only: "仅本人创作",
};
const FORMS = { article: "文章", image_text: "图文卡片", video: "真实视频包", thread: "有序串文", document: "分页文档", repository_change: "仓库变更包", model_card: "模型卡", dataset_card: "数据集卡", notebook: "Notebook", demo_bundle: "Demo 文件包", community_message: "社区消息" };
const DIMENSIONS = { deterministic: "确定性合同", semantic: "语义与事实", media: "实际媒体内容", artistic: "表达与艺术" };
const TERMINAL = new Set(["completed", "cancelled", "deadline_exceeded", "failed", "skipped", "materialized"]);
const array = value => Array.isArray(value) ? value : [];
const label = value => LABELS[value] || ({ awaiting_quality: "等待最终独立检查", pending_review: "待审核", research: "研究", outline: "组织结构", copyedit: "限定校对", translate: "翻译", draft: "辅助起草", generate_media: "媒体制作", deterministic: "确定性合同", semantic: "语义与事实", media: "实际媒体内容", artistic: "表达与艺术" })[value] || value || "未记录";
const json = value => html(JSON.stringify(value ?? null, null, 2));
const timestamp = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "未记录";
const hash = (name, value) => `<p class="co-hash"><span>${html(name)}</span><code>${html(value || "服务未返回；不能据此审核")}</code></p>`;
const empty = (title, copy = "") => `<div class="co-empty"><strong>${html(title)}</strong>${copy ? `<p>${html(copy)}</p>` : ""}</div>`;
const chip = value => `<span class="co-status" data-status="${html(value)}">${html(label(value))}</span>`;
const feedback = () => '<p class="form-error" data-co-error role="alert" hidden></p><p class="form-status" data-co-status role="status" aria-live="polite"></p>';
const options = (entries, selected = "") => entries.map(([value, text]) => `<option value="${html(value)}"${value === selected ? " selected" : ""}>${html(text)}</option>`).join("");
const check = (name, text) => `<label class="co-check"><input type="checkbox" name="${html(name)}" required /><span>${html(text)}</span></label>`;
const form = (action, id = "", etag = "") => `<form class="co-form" data-co-form="${html(action)}" data-id="${html(id)}" data-etag="${html(etag)}">`;

export function formatBudgetValue(value, { currency = "", micros = false } = {}) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "未知 / 未配置";
  return micros ? `${(Number(value) / 1_000_000).toLocaleString("zh-CN", { maximumFractionDigits: 6 })} ${currency}`.trim() : Number(value).toLocaleString("zh-CN");
}

export function contentOpsError(error) {
  const unconfirmed = error?.requestUnconfirmed === true || error?.status >= 500 || !error?.status && (error instanceof TypeError || error instanceof SyntaxError);
  const code = error?.code || (unconfirmed ? "REQUEST_UNCONFIRMED" : "INPUT_REVIEW_REQUIRED");
  const tips = {
    AUTH_REQUIRED: "登录已过期，请重新登录管理后台。", AGENT_SCOPE_DENIED: "当前身份不能使用管理员准备与审核功能。", WORKER_SCOPE_DENIED: "工位授权不包含这项任务。", SCHEMA_MIGRATION_REQUIRED: "当前账本尚未完成 v3 迁移。请先执行管理员迁移与完整备份流程。", SCHEMA_VERSION_UNSUPPORTED: "当前服务与账本版本不兼容，请核对部署版本。", BUDGET_CONFIG_REQUIRED: "预算未配置，尚未启动付费步骤。请创建新预算授权、更新计划并重新校验。", PRICING_REQUIRED: "缺少有效价格快照，不能把未知价格当作免费。", SOURCE_OUTDATED: "母版或输入已更新。请读取差异，更新计划并重新校验。", QUALITY_REPORT_STALE: "终检与当前最终包不一致，需要对这一版本重新独立终检。", QUALITY_RECHECK_REQUIRED: "必需的最终检查未完成，不能转为可批准成品。", ATTEMPT_UNKNOWN: "原请求结果未知。先核对原尝试，预留不会自动释放。", PRECONDITION_FAILED: "当前对象版本已变化。请刷新并重新核对后提交。", ADAPTER_NOT_READY: "指定工位适配器尚未就绪，目录存在不代表可执行。", RESTORE_NOT_VERIFIED: "完整恢复尚未验证，当前操作被阻断。",
  };
  const findings = array(error?.details?.findings || error?.details?.gaps).map(item => item.message || item.explanation || item.code).filter(Boolean);
  return `${code} · ${tips[code] || error?.message || "请求未确认完成，请刷新当前记录后核对。"}${findings.length ? `\n${findings.join("\n")}` : ""}${unconfirmed ? "\n网络结果未确认；输入与原请求标识已保留。先刷新记录，再决定是否重试。" : ""}`;
}

function bullets(values) { const rows = typeof values === "string" ? [values] : array(values); return rows.length ? `<ul>${rows.map(value => `<li>${html(typeof value === "string" ? label(value) : value.message || value.explanation || value.code || JSON.stringify(value))}</li>`).join("")}</ul>` : '<p class="co-muted">未列出</p>'; }

export function renderOperatorProfiles(profiles = [], { query = "", destinations = [], accounts = [] } = {}) {
  const needle = query.trim().toLowerCase();
  const matched = profiles.filter(profile => !needle || JSON.stringify(profile).toLowerCase().includes(needle));
  return `<div class="co-section-title"><div><h3>28 个平台岗位</h3><p>岗位按需工作；每份成品绑定具体账号、目的地与语言。</p></div><span>${matched.length} / ${profiles.length} 个岗位</span></div><label class="co-search"><span>查找岗位、原生成品或工作职责</span><input type="search" data-co-search value="${html(query)}" maxlength="160" placeholder="例如：小红书、视频、notebook" /></label><div class="co-profile-grid">${matched.length ? matched.map((profile, index) => {
    const platformId = profile.platformId || profile.id;
    const localDestinations = destinations.filter(row => row.platformId === platformId);
    const active = localDestinations.filter(row => row.status === "active");
    const localAccounts = accounts.filter(row => row.platformId === platformId && row.status !== "archived");
    const strategy = profile.strategy || {};
    return `<article class="co-profile" data-operator-platform="${html(platformId)}"><header><span class="co-ordinal">${String(index + 1).padStart(2, "0")}</span><span class="co-muted">版本 ${html(profile.version || profile.revision || 1)}</span></header><h4>${html(profile.nameZh || profile.name || profile.title || platformId)}</h4><p>${html(profile.readerNeed || profile.readerTask || strategy.readerNeed || profile.purpose || profile.description || "围绕真实母版，为具体读者准备可逐项审核的原生成品。")}</p><div class="co-tags">${array(profile.supportedNativeForms || profile.nativeForms).map(value => `<span>${html(FORMS[value] || value)}</span>`).join("")}</div><p class="co-config">${localAccounts.length} 个当前账号 · ${active.length} / ${localDestinations.length} 个启用目的地</p><details><summary>岗位职责、规则与质量要求</summary><dl class="co-definition"><dt>深度适配</dt><dd>${html(profile.adaptationStrategy || (typeof strategy === "string" ? strategy : strategy.adaptation || strategy.angle) || "按目的地、真实输入与已锁定规则执行。")}</dd><dt>质量检查</dt><dd>${bullets(profile.qualityGates || strategy.qualityGates)}</dd><dt>输入与边界</dt><dd>${bullets(profile.requiredInputs || profile.requirements || profile.prerequisites || profile.boundaries)}</dd></dl><pre class="co-json">${json(profile)}</pre></details></article>`;
  }).join("") : empty("没有匹配的岗位", "调整搜索词；完整目录与真实账号分别登记。")}</div>`;
}

export function renderBudgetLedger(job = {}) {
  const budget = job.budgetAuthorization || job.budget || {};
  const totals = job.budgetTotals || job.usageTotals || {};
  const currency = budget.currency || totals.currency || "";
  const reservations = array(job.reservations || job.modelBudgetReservations).map(row => ({ ...row,
    reservedInputTokens: row.reservedInputTokens ?? row.reserved?.inputTokens,
    reservedOutputTokens: row.reservedOutputTokens ?? row.reserved?.outputTokens,
    reservedCostMicros: row.reservedCostMicros ?? row.reserved?.costMicros,
    actualInputTokens: row.actualInputTokens ?? row.actual?.inputTokens ?? null,
    actualOutputTokens: row.actualOutputTokens ?? row.actual?.outputTokens ?? null,
    actualCostMicros: row.actualCostMicros ?? row.actual?.costMicros ?? null,
  }));
  const settled = reservations.filter(row => ["settled", "succeeded", "reconciled"].includes(row.status));
  const unknown = reservations.filter(row => ["unknown", "unknown_usage", "partially_settled", "needs_reconcile"].includes(row.status));
  const pending = reservations.filter(row => !["settled", "succeeded", "reconciled", "released", "failed_known"].includes(row.status));
  const sum = (rows, key) => rows.reduce((total, row) => total + (Number.isSafeInteger(row[key]) ? row[key] : 0), 0);
  const actual = totals.actualCostMicros ?? totals.used?.costMicros ?? (settled.length && settled.every(row => row.actualCostMicros !== null && row.actualCostMicros !== undefined) ? sum(settled, "actualCostMicros") : null);
  const cards = [["金额授权上限", formatBudgetValue(budget.maxCostMicros, { currency, micros: true })], ["实际已结算部分", formatBudgetValue(actual, { currency, micros: true })], ["未决最坏预留", formatBudgetValue(totals.reservedCostMicros ?? totals.reserved?.costMicros ?? sum(pending, "reservedCostMicros"), { currency, micros: true })], ["其中未知用量", `${totals.unknown?.count ?? unknown.length} 次 · ${formatBudgetValue(totals.unknownCostMicros ?? totals.unknown?.costMicros ?? sum(unknown, "reservedCostMicros"), { currency, micros: true })}`]];
  return `<section class="co-budget"><h4>预算与实际用量</h4><div class="co-metrics">${cards.map(([name, value]) => `<div><span>${html(name)}</span><strong>${html(value)}</strong></div>`).join("")}</div><p class="co-muted">调用上限 ${formatBudgetValue(budget.maxCalls)} · 输入 token ${formatBudgetValue(budget.maxInputTokens)} · 输出 token ${formatBudgetValue(budget.maxOutputTokens)} · 并发 ${formatBudgetValue(budget.maxInFlight)}<br />截止：${html(timestamp(budget.deadlineAt || job.deadlineAt))}。未知实际费用保留为未知；取消、到期和重启不释放原预留。</p>${reservations.length ? `<details><summary>逐底层请求账本（${reservations.length} 条）</summary><div class="co-stack">${reservations.map(row => `<article class="co-ledger-row"><div>${chip(row.status)}<strong>${html(row.id || row.callAttemptId || row.attemptId)}</strong><p>${html(row.provider || "")} / ${html(row.model || "")} · ${html(row.targetKey || "")}</p></div><dl><dt>输入 / 输出最坏预留</dt><dd>${formatBudgetValue(row.reservedInputTokens)} / ${formatBudgetValue(row.reservedOutputTokens)}</dd><dt>金额最坏预留</dt><dd>${formatBudgetValue(row.reservedCostMicros, { currency: row.currency || currency, micros: true })}</dd><dt>实际输入 / 输出</dt><dd>${formatBudgetValue(row.actualInputTokens)} / ${formatBudgetValue(row.actualOutputTokens)}</dd><dt>实际结算</dt><dd>${formatBudgetValue(row.actualCostMicros, { currency: row.currency || currency, micros: true })}</dd></dl><details><summary>查看准确尝试与回执绑定</summary><pre class="co-json">${json(row)}</pre></details></article>`).join("")}</div></details>` : '<p class="co-muted">尚无底层请求记录；这不表示已经免费执行。</p>'}</section>`;
}

export function renderSourceDifference(source = {}, candidate = {}) {
  const pack = candidate.package || candidate.publicationPackage || candidate;
  const oldLines = String(source.body || "").split("\n");
  const newLines = String(pack.body || "").split("\n");
  const oldSet = new Set(oldLines), newSet = new Set(newLines);
  const removed = oldLines.filter(line => line && !newSet.has(line));
  const added = newLines.filter(line => line && !oldSet.has(line));
  return `<details class="co-diff"><summary>母版与当前完整成品差异</summary>${!source.id ? '<p class="co-warning">未读取到准确母版，差异未验证。请先刷新源稿；不把空白当作原文。</p>' : ""}<p class="co-muted">母版 ${html(source.id || "未读取")} · ${html(source.title || "")}。以下保留两份全文，并按文本行标出新增与删除；重排可同时出现在两栏。</p><div class="co-diff-columns"><section><h5>冻结母版全文</h5><pre>${html(source.body || "尚未读取")}</pre></section><section><h5>当前平台成品全文</h5><pre>${html(pack.body || "")}</pre></section></div><div class="co-diff-columns"><section class="co-removed"><h5>删除 / 改写前（${removed.length} 行）</h5><pre>${html(removed.join("\n") || "无文本行删除")}</pre></section><section class="co-added"><h5>新增 / 改写后（${added.length} 行）</h5><pre>${html(added.join("\n") || "无文本行新增")}</pre></section></div></details>`;
}

function artifactUrl(artifact) { return artifact?.id ? `/api/content-ops/artifacts/${encodeURIComponent(artifact.id)}/bytes` : ""; }

export function buildArtifactMediaImport(artifact, fields) {
  const confirmed = typeof fields.get === "function" ? fields.get("confirmed") : fields.confirmed;
  if (confirmed !== "on") throw new Error("请实际核对这份准确文件与使用审核后，再导入私有媒体素材。");
  if (!artifact?.etag || artifact.status !== "reviewed" || !/^[a-f0-9]{64}$/.test(artifact.sha256 || "") || !["image/png", "image/jpeg", "image/webp", "video/mp4", "text/vtt"].includes(artifact.mime)) throw new Error("需要准确版本、真实媒体字节与已完成的附件使用审核，不能导入未审核或不支持的文件。");
  return { sha256: artifact.sha256 };
}

export function renderArtifactPreview(artifact = {}, { review = false } = {}) {
  const url = artifactUrl(artifact);
  const mime = String(artifact.mime || "");
  const preview = artifact.inspection?.preview || artifact.preview || artifact.inspection?.text || artifact.inspection?.previewText;
  const previewText = typeof preview === "string" ? preview : preview ? JSON.stringify(preview, null, 2) : "";
  const safeImage = ["image/png", "image/jpeg", "image/webp"].includes(mime);
  const content = !url ? '<p class="co-warning">缺少文件 ID，无法读取真实附件。</p>' : safeImage ? `<img src="${url}" alt="${html(artifact.alt || artifact.name || artifact.role || "实际附件预览")}" loading="lazy" data-co-media />` : mime === "video/mp4" ? `<video controls playsinline preload="metadata" data-co-media><source src="${url}" type="video/mp4" /></video>` : ["audio/wav", "audio/mpeg", "audio/mp3"].includes(mime) ? `<audio controls preload="metadata" src="${url}" data-co-media></audio>` : "";
  const previewError = artifact.previewError ? `<p class="co-error" role="alert">附件元数据读取未完成。${html(artifact.previewError)}</p>` : "";
  const reviewed = Boolean(artifact.review && (artifact.review.rightsConfirmed || artifact.review.status === "reviewed")) || artifact.status === "reviewed";
  const mediaBridge = review && reviewed && (artifact.origin === "worker_upload" || artifact.taskId) && ["image/png", "image/jpeg", "image/webp", "video/mp4", "text/vtt"].includes(mime) ? artifact.mediaAssetId ? `<p class="co-muted">已关联私有媒体 ${html(artifact.mediaAssetId)}。附件审核与媒体使用审核分别记录；仍需核对媒体状态与完整终检。</p><button type="button" class="ghost-button" data-co-media-review="${html(artifact.mediaAssetId)}">前往媒体素材 · 核对准确使用范围</button>` : `<details class="co-panel"><summary>将准确产物导入私有媒体素材</summary><p class="co-muted">图像、视频与 VTT 成品须显式关联现有媒体库才能进入完整包。这里只复制这份准确字节为私有待审核素材；下一步仍须在“编辑出版 → 媒体素材”独立核对使用范围，不批准正文或发布。</p>${form("artifact-import-media", artifact.id, artifact.etag)}${check("confirmed", "我已核对上述准确字节、完整实际内容与附件使用审核，将这一文件导入本项目私有媒体库；随后另行完成媒体使用审核。")}${feedback()}<button type="submit" class="ghost-button"${artifact.etag && !artifact.previewError ? "" : " disabled"}>导入准确私有媒体 · 待审核</button></form></details>` : "";
  return `<article class="co-artifact" data-artifact-id="${html(artifact.id)}"><header><div><strong>${html(artifact.name || artifact.role || artifact.id || "附件")}</strong><p>${html(mime)} · ${formatBudgetValue(artifact.bytes ?? artifact.size)} bytes</p></div>${chip(reviewed ? "reviewed" : artifact.status || "staged")}</header>${previewError}${content}<p class="co-media-failure" role="status" hidden>真实文件暂时无法读取或解码；此附件尚不能视为已预览。<button class="ghost-button" type="button" data-co-media-retry>重试读取</button></p>${previewText ? `<details open><summary>静态内容预览（不执行代码）</summary><pre class="co-file-text">${html(previewText)}</pre></details>` : !safeImage && mime !== "video/mp4" ? '<p class="co-muted">请读取服务端静态预览，并下载原文件完整核对；不能仅凭文件名批准。</p>' : ""}${artifact.inspection?.previewTruncated ? '<p class="co-warning">上方只是有界摘要，尚未显示完整文件。使用下方按钮读取完整静态预览。</p>' : ""}${url ? `<div class="co-artifact-actions"><a class="text-link" href="${url}" download>下载准确原文件 ↗</a>${!safeImage && mime !== "video/mp4" ? `<button class="ghost-button" type="button" data-co-artifact-preview="${html(artifact.id)}">读取完整静态预览</button>` : ""}</div><div data-co-preview-output></div>` : ""}${hash("实际文件 SHA-256", artifact.sha256)}${review && !reviewed ? `${form("artifact-review", artifact.id, artifact.etag)}${check("rightsConfirmed", "我已实际核对这份准确文件的来源与使用权。")}${check("privacyConfirmed", "我已检查全部内容、画面、元数据与隐私范围。")}${check("licenseConfirmed", "我已核对这份文件的许可及本次使用条件。")}<label><span>核对依据与使用范围</span><textarea name="note" required minlength="8" maxlength="2000" rows="3"></textarea></label>${feedback()}<button class="ghost-button" type="submit"${artifact.etag ? "" : " disabled"}>保存准确附件的使用审核</button>${!artifact.etag ? '<p class="co-muted">文件缺少版本校验值，请刷新后再审核。</p>' : ""}</form>` : ""}${mediaBridge}</article>`;
}

export function renderQualityReports(reports = [], candidate = {}) {
  const packageHash = candidate.packageHash || candidate.package?.packageHash;
  return `<section class="co-quality"><h4>独立最终检查</h4>${reports.length ? reports.map(report => {
    const stale = report.checkedPackageHash !== packageHash;
    const coverage = report.coverage || {};
    return `<article class="co-report">${chip(stale ? "unverified" : report.status)}${stale ? '<p class="co-warning">报告对应的最终包不同，不能用于当前成品审核。</p>' : ""}<p>检查器 ${html(report.checkerVersion || "未记录")} · ${html(timestamp(report.checkedAt))}</p><div class="co-quality-grid">${Object.entries(DIMENSIONS).map(([key, title]) => {
      const dimension = coverage[key] ?? coverage[`${key}Quality`] ?? report.dimensions?.[key];
      return `<div><strong>${title}</strong>${chip(typeof dimension === "string" ? dimension : dimension?.status || "unverified")}<p>${html(typeof dimension === "object" ? dimension.description || dimension.summary || JSON.stringify(dimension) : "覆盖范围见下方完整报告")}</p></div>`;
    }).join("")}</div>${bullets(report.semanticFindings || report.findings)}${hash("被检查包", report.checkedPackageHash)}${hash("检查上下文", report.checkContextHash)}${hash("完整报告", report.reportHash)}<details><summary>完整覆盖、问题定位、媒体依据与执行回执</summary><pre class="co-json">${json(report)}</pre></details></article>`;
  }).join("") : empty("尚无独立最终报告", "起草、技术检查或自评分不能代替对最终完整包的四维终检。")}</section>`;
}

export function candidateReviewReady(candidate = {}, reports = []) {
  if (candidate.status !== "ready_for_review" || !candidate.etag || !candidate.reviewSnapshotHash || !candidate.packageHash || !reports.length) return false;
  return reports.every(report => report.status === "passed" && report.checkedPackageHash === candidate.packageHash && Object.keys(DIMENSIONS).every(key => {
    const dimension = report.coverage?.[key] ?? report.coverage?.[`${key}Quality`] ?? report.dimensions?.[key];
    return (typeof dimension === "string" ? dimension : dimension?.status) === "passed";
  }) && !array(report.semanticFindings || report.findings).some(finding => ["blocker", "major"].includes(finding.severity) && !finding.resolved));
}

function reviewReportHashes(candidate) { return array(candidate.qualityReportHashes || candidate.reviewEnvelope?.qualityReportHashes || candidate.review?.qualityReportHashes); }

export const EDITORIAL_NATIVE_SCHEMA = "pengmanager.editorial-variant/v3";
export function nativePublicationPackage(row = {}) { return row.publicationPackage || row.editorialSnapshot?.publicationPackage || row.package || null; }

export function nativeArtifactReferences(row = {}) {
  return array(nativePublicationPackage(row)?.artifactRefs).map(ref => ({ ...ref, artifactId: ref.id || ref.artifactId }));
}

function artifactMatchesReference(current, ref) {
  return Boolean(current && !current.previewError && current.id === (ref.id || ref.artifactId) && current.sha256 === ref.sha256 && current.mime === ref.mime && (current.bytes ?? current.size) === ref.bytes && current.status === "reviewed" && (!ref.rightsReviewHash || current.rightsReviewHash === ref.rightsReviewHash) && (!ref.privacyReviewHash || current.privacyReviewHash === ref.privacyReviewHash));
}

function sourceMatchesReference(source, ref) {
  return Boolean(source && source.id === ref.id && (source.snapshotHash || source.ref?.sha256) === ref.sha256 && (source.editorialRevision ?? source.revision) === ref.revision);
}

export async function loadNativePackageReview(api, row, { editions = [] } = {}) {
  const pkg = nativePublicationPackage(row);
  if (!pkg || !(row.candidateId || pkg.candidateId)) throw new Error("原生完整包缺少准确候选引用，不能用当前正文替代。");
  const candidate = await api(`/api/content-ops/candidates/${encodeURIComponent(row.candidateId || pkg.candidateId)}`);
  if (candidate.packageHash !== (row.packageHash || pkg.packageHash) || candidate.reviewSnapshotHash !== (row.reviewSnapshotHash || row.editorialSnapshot?.reviewSnapshotHash)) throw new Error("当前候选与这份原获准包或完整审阅快照不同，不能替换原授权。");
  const results = await Promise.allSettled(array(pkg.artifactRefs).map(ref => api(`/api/content-ops/artifacts/${encodeURIComponent(ref.id || ref.artifactId)}`)));
  const artifacts = results.map((result, index) => {
    const ref = pkg.artifactRefs[index];
    if (result.status !== "fulfilled") return { ...ref, id: ref.id || ref.artifactId, previewError: contentOpsError(result.reason) };
    const current = result.value;
    const matches = artifactMatchesReference(current, ref);
    return matches ? current : { ...current, previewError: "附件当前字节、类型、大小或权利审核与原获准引用不同；不把当前替代文件当成原包。" };
  });
  const sourceRefs = array(pkg.sourceEditionRefs);
  const sourceResults = await Promise.allSettled(sourceRefs.map(async ref => {
    const source = editions.find(edition => edition.id === ref.id) || await api(`/api/editions/${encodeURIComponent(ref.id)}`);
    if (!sourceMatchesReference(source, ref)) throw new Error("来源版本与原包冻结的母版引用不同，差异未验证。");
    return source;
  }));
  const sources = sourceResults.filter(result => result.status === "fulfilled").map(result => result.value);
  const sourceErrors = sourceResults.flatMap((result, index) => result.status === "rejected" ? [{ id: sourceRefs[index].id, message: contentOpsError(result.reason) }] : []);
  const sourceError = sourceErrors.length ? sourceErrors.map(error => `${error.id}：${error.message}`).join("\n") : null;
  const refs = reviewReportHashes(row).length ? reviewReportHashes(row) : reviewReportHashes(candidate);
  const reports = array(candidate.reports).filter(report => refs.includes(report.reportHash));
  const ready = artifacts.every(artifact => !artifact.previewError) && candidateReviewReady(candidate, reports) && reports.length === refs.length && sources.length === sourceRefs.length && !sourceError;
  return { candidate, artifacts, reports, source: sources[0] || {}, sources, sourceError, sourceErrors, ready };
}

export function renderNativePackageReview(row = {}, review = null) {
  const pkg = nativePublicationPackage(row);
  if (!pkg) return '<p class="co-error" role="alert">原生包缺失；不能只审正文后批准。</p>';
  const candidate = { ...(review?.candidate || {}), id: row.candidateId || pkg.candidateId, package: pkg,
    packageHash: row.packageHash || pkg.packageHash, reviewSnapshotHash: row.reviewSnapshotHash || row.editorialSnapshot?.reviewSnapshotHash,
    qualityReportHashes: reviewReportHashes(row).length ? reviewReportHashes(row) : reviewReportHashes(review?.candidate || {}),
    reviewEnvelope: row.reviewEnvelope || row.editorialSnapshot?.reviewEnvelope, status: review?.candidate?.status || row.status || "unverified" };
  return `<div class="co-workspace co-inline-review">${!review ? '<p class="co-warning">尚未读取这份准确候选的独立报告与真实附件元数据；下方保留完整原生快照，需读取后逐项核对。</p>' : !review.ready ? '<p class="co-warning">当前报告、附件或来源未满足完整审阅条件，请保留错误与缺口；已有平台结果应按原授权核对，不重新外发。</p>' : ""}${review?.sourceError ? `<p class="co-error" role="alert">${html(review.sourceError)}</p>` : ""}${renderNativeCandidate(candidate, { artifacts: review?.artifacts || [], reports: review?.reports || [], source: review?.source || {}, sources: review?.sources || [], canMaterialize: false })}</div>`;
}

export function nativeReviewConfirmationFields(row = {}, { prefix = "nativeArtifactConfirmed" } = {}) {
  const pkg = nativePublicationPackage(row);
  if (!pkg) return "";
  return `<fieldset class="co-choice"><legend>逐项确认这个准确最终包</legend>${check("nativePackageConfirmed", "我已核对全部原生结构、顺序、目标设置与完整独立终检；本次确认仅针对显示的 packageHash 和 reviewSnapshotHash。")} ${nativeArtifactReferences(row).map(ref => `<label class="co-check"><input type="checkbox" name="${html(prefix)}-${html(ref.artifactId)}" value="${html(ref.sha256)}" required /><span>我已实际核对 ${html(ref.role || ref.artifactId)}（${html(ref.artifactId)}）全部内容与顺序，确认为这份准确字节。<br /><code>${html(ref.sha256)}</code></span></label>`).join("")}</fieldset>`;
}

export function assertNativeReviewConfirmations(row, fields, { prefix = "nativeArtifactConfirmed" } = {}) {
  const value = name => typeof fields.get === "function" ? fields.get(name) : fields[name];
  if (value("nativePackageConfirmed") !== "on") throw new Error("请实际核对这个完整原生包的全部有序项、目标设置与终检后确认。");
  for (const ref of nativeArtifactReferences(row)) if (value(`${prefix}-${ref.artifactId}`) !== ref.sha256) throw new Error(`请实际核对准确原生附件 ${ref.artifactId}，不能只凭文件名或上传成功确认。`);
}

export function nativeTextReviewKeys(pkg = {}) {
  const manifest = pkg.nativeManifest || {};
  const keys = ["title", "summary", "body", ...array(pkg.orderedBlocks).map((_, index) => `block:${index}`)];
  for (const [field, prefix] of [["segments", "segment"], ["chapters", "chapter"], ["outputs", "output"], ["pages", "page"], ["images", "image"], ["files", "file"]]) {
    for (const [index] of array(manifest[field]).entries()) keys.push(`${prefix}:${index}`);
  }
  if (manifest.settings) keys.push("native:settings");
  if (manifest.disclosures) keys.push("native:disclosures");
  return keys;
}

export function buildHumanQualityReview(candidate, fields) {
  const value = key => typeof fields.get === "function" ? fields.get(key) : fields[key];
  for (const name of ["independent", "fullText", "semantic", "artistic", "reviewed"]) if (value(name) !== "on") throw new Error("只有独立检查者实际读完最终全文、证据、全部附件并逐项核对后，才能提交这份人工终检。");
  const pkg = nativePublicationPackage(candidate);
  if (!pkg || !candidate.packageHash || !candidate.checkContextHash) throw new Error("未读取到准确最终包与检查上下文，不能签署终检。");
  const mediaEvidence = nativeArtifactReferences(candidate).map(ref => {
    if (value(`qualityArtifact-${ref.artifactId}`) !== ref.sha256) throw new Error(`请完整实际读取 / 播放 ${ref.artifactId} 后确认，不能凭文件存在签署覆盖。`);
    const method = value(`qualityMethod-${ref.artifactId}`), note = String(value(`qualityNote-${ref.artifactId}`) || "");
    if (!["human_full_read", "human_full_playback"].includes(method) || note.trim().length < 8) throw new Error(`请记录 ${ref.artifactId} 的真实完整检查方法与具体依据。`);
    return { artifactId: ref.artifactId, sha256: ref.sha256, method, coverage: "full", note };
  });
  let findings;
  try { findings = JSON.parse(String(value("findings") || "[]")); } catch { throw new Error("终检问题列表必须是有效 JSON 数组，输入已保留。"); }
  if (!Array.isArray(findings)) throw new Error("终检问题必须是数组，未发现问题时明确使用 []。");
  const assessment = String(value("assessment") || "");
  if (assessment.trim().length < 8) throw new Error("请给出实际检查结论、依据与局限，不能仅勾选通过。");
  return { checkedPackageHash: candidate.packageHash, checkContextHash: candidate.checkContextHash, checkerVersion: "pengmanager.independent-checker/v1", findings, coverage: { textKeys: [...new Set([...nativeTextReviewKeys(pkg), ...array(candidate.requiredCoverage?.textKeys)])], artifactHashes: [...new Set(nativeArtifactReferences(candidate).map(ref => ref.sha256))], semantic: "checked", artistic: "checked" }, mediaEvidence, assessment, reviewed: true };
}

export function renderHumanQualityReview(candidate = {}, artifacts = [], { sources = [] } = {}) {
  const references = nativeArtifactReferences(candidate);
  const metadataReady = references.every(ref => artifacts.some(row => artifactMatchesReference(row, ref))) && array(nativePublicationPackage(candidate)?.sourceEditionRefs).every(ref => sources.some(row => sourceMatchesReference(row, ref)));
  return `<details class="co-panel"><summary>独立人工最终检查（对无法由机器完整核对的媒体 / 表达逐项留证）</summary><p class="co-muted">请先完整阅读上方冻结包、来源差异、全文和每份真实文件。此表只记录独立终检，不能修改成品或批准发布；服务端会重算报告、四个维度与全部覆盖，未核实或未解决的严重问题不会放行。</p>${form("quality-review", candidate.id, candidate.etag)}${check("independent", "我独立于本包的起草、生成与最终润色上下文，具有本次实际检查权限。")} ${check("fullText", "我已逐项阅读最终标题、导语、全文、所有正文块、串文、章节、原生输出、文档页、图序、文件、设置、披露与全部来源限定。")} ${check("semantic", "我已独立核对事实、身份、数字、证据、翻译、必要限定与目的地规则，问题均在下方明示。")} ${check("artistic", "我已按这份最终成品实际核对可读 / 可听性、视觉层次、表达与叙事节奏；没有把技术闸当艺术检查。")} ${references.map(ref => `<fieldset class="co-choice"><legend>${html(ref.role || "真实附件")} · ${html(ref.artifactId)}</legend><label class="co-check"><input type="checkbox" name="qualityArtifact-${html(ref.artifactId)}" value="${html(ref.sha256)}" required /><span>我已完整实际读取 / 播放这份准确文件的全部内容；未覆盖片段不能勾选。<br /><code>${html(ref.sha256)}</code></span></label><label><span>实际完整检查方法</span><select name="qualityMethod-${html(ref.artifactId)}" required><option value="">选择已完成的方法</option><option value="human_full_read">独立人类完整阅读</option><option value="human_full_playback">独立人类完整播放画面、音轨与字幕</option></select></label><label><span>具体覆盖与检查依据</span><textarea name="qualityNote-${html(ref.artifactId)}" required minlength="8" maxlength="4000" rows="3" placeholder="写明实际查看的全部页 / 单元格 / 时间段、音轨字幕与检查要点；不编造运行或播放。"></textarea></label></fieldset>`).join("")}<label><span>全部问题 findings JSON（未发现问题时用 []；严重问题保持未解决）</span><textarea name="findings" rows="6" spellcheck="false">[]</textarea></label><p class="co-muted">每项字段：severity（blocker / major / minor / suggestion）、dimension（facts / policy / structure / disclosure / media / expression）、code、message、location；仅实际完成修正后才可附 resolved:true。</p><label><span>实际独立结论、依据与未覆盖局限</span><textarea name="assessment" required minlength="8" maxlength="20000" rows="4"></textarea></label>${check("reviewed", "上述阅读、播放与检查确实完成，只提交这一准确 packageHash 和 checkContextHash 的独立记录，不替代人工内容批准或发布授权。")} ${feedback()}<button class="ghost-button" type="submit"${metadataReady && candidate.etag ? "" : " disabled"}>保存真实独立终检记录</button>${!metadataReady ? '<p class="co-warning">真实附件元数据或准确来源母版尚未完整读取，不能签署整包覆盖。请先重新读取完整候选。</p>' : ""}</form></details>`;
}

export function buildUsageReconciliation(reservation, fields, { evidenceSha256 = "" } = {}) {
  const value = key => typeof fields.get === "function" ? fields.get(key) : fields[key];
  if (value("reviewed") !== "on") throw new Error("请逐项核对准确尝试、供应商请求、实际账单和全部单位后确认。");
  const providerRequestId = String(value("providerRequestId") || "").trim() || null;
  if (reservation.providerRequestId && reservation.providerRequestId !== providerRequestId) throw new Error("供应商请求 ID 必须保持原请求，不能换成别的账单清除预留。");
  const usage = { currency: reservation.currency };
  for (const key of ["inputTokens", "outputTokens", "costMicros"]) {
    if (value(key) === "" || value(key) === null || value(key) === undefined) throw new Error("实际用量或金额未知时不能补零结算；请保留原预留。");
    const number = Number(value(key));
    if (!Number.isSafeInteger(number) || number < 0) throw new Error("实际用量和金额必须是非负安全整数，并与原币种、单位一致。");
    usage[key] = number;
  }
  const sha256 = evidenceSha256 || String(value("evidenceSha256") || "").trim();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("需要准确账单 / 逐项审计证据的实际 SHA-256，不能仅声明没有费用。");
  const kind = value("evidenceKind"), description = String(value("description") || ""), reason = String(value("reason") || "");
  if (!["provider_billing_receipt", "administrator_itemized_audit"].includes(kind) || description.trim().length < 8 || reason.trim().length < 8) throw new Error("请提供实际供应商账单或逐项人工审计类型、证据说明和核对原因。");
  return { attemptId: reservation.attemptId, providerRequestId, usage, evidence: { kind, sha256, providerRequestId, reservationId: reservation.id, dimensions: ["inputTokens", "outputTokens", "costMicros", "currency"], description }, reason, reviewed: true };
}

function renderUsageReconciliations(job) {
  const reservations = array(job.reservations).filter(row => ["unknown_usage", "partially_settled"].includes(row.status));
  if (!reservations.length) return "";
  return `<details class="co-panel"><summary>逐请求核对未决实际用量（${reservations.length} 条；不会重新执行任务）</summary><p class="co-muted">只在已经取得准确账单或完成逐项人工审计后使用。不能用取消、忽略、重启或新预算清除未知预留。用量结算不证明原生产结果成功，也不会自动重启原任务。</p>${reservations.map(row => `${form("usage-reconcile", row.id, job.etag)}<h4>${html(row.id)} · ${html(row.attemptId)}</h4><p class="co-muted">${html(row.provider || "本地固定任务")} / ${html(row.model || "")} · 原币种 ${html(row.currency)} · ${html(label(row.status))}</p><div class="co-form-grid"><label class="wide"><span>准确供应商请求 ID（原未知且真实无 ID 时保留空）</span><input name="providerRequestId" maxlength="240" value="${html(row.providerRequestId || "")}" /></label>${[["inputTokens", "实际输入 token"], ["outputTokens", "实际输出 token"], ["costMicros", `实际账单金额（${row.currency} micros）`]].map(([key, title]) => `<label><span>${html(title)}</span><input name="${key}" type="number" min="0" step="1" max="9007199254740991" required${Number.isSafeInteger(row.actual?.[key]) ? ` value="${row.actual[key]}"` : ""} /></label>`).join("")}<label><span>实际证据类型</span><select name="evidenceKind" required><option value="">选择真实依据</option><option value="provider_billing_receipt">供应商实际计费回执</option><option value="administrator_itemized_audit">管理员逐项账单审计</option></select></label><label class="wide"><span>证据文件（可选，仅本页计算摘要，不上传账单原文）</span><input name="evidenceFile" type="file" /></label><label class="wide"><span>已有准确证据 SHA-256（未选文件时必填）</span><input name="evidenceSha256" pattern="[a-f0-9]{64}" maxlength="64" /></label><label class="wide"><span>逐项证据、实际请求与计价单位核对说明</span><textarea name="description" required minlength="8" maxlength="4000" rows="4"></textarea></label><label class="wide"><span>本次核对原因</span><textarea name="reason" required minlength="8" maxlength="4000" rows="3"></textarea></label></div>${check("reviewed", "我已核对这个准确尝试、供应商请求和证据中的实际输入、输出、金额与币种；未知值不补零，证据仍不完整时保留原预留。")} ${feedback()}<button class="ghost-button" type="submit"${job.etag ? "" : " disabled"}>保存准确用量审计 · 不重新执行</button></form>`).join("")}</details>`;
}

export function bindNativePackagePreviews(root, { api } = {}) {
  if (!root?.addEventListener) return;
  root.addEventListener("click", async event => {
    const button = event.target.closest?.("[data-co-artifact-preview], [data-co-caption-preview], [data-co-media-retry]");
    if (!button) return;
    if (button.hasAttribute("data-co-media-retry")) {
      const wrapper = button.closest(".co-artifact") || button.closest("li");
      const media = wrapper?.querySelector("[data-co-media]");
      const failure = wrapper?.querySelector(".co-media-failure");
      if (failure) failure.hidden = true;
      if (media?.tagName === "IMG") { const source = media.src; media.removeAttribute("src"); media.src = source; }
      else media?.load();
      return;
    }
    const artifact = button.hasAttribute("data-co-artifact-preview");
    const wrapper = artifact ? button.closest(".co-artifact") : button.parentElement;
    const output = wrapper?.querySelector(artifact ? "[data-co-preview-output]" : "[data-co-caption-output]");
    if (!output) return;
    button.disabled = true;
    const previous = button.textContent;
    button.textContent = "正在读取实际完整内容…";
    try {
      let content;
      if (artifact) {
        const payload = await api(`/api/content-ops/artifacts/${encodeURIComponent(button.dataset.coArtifactPreview)}/preview`);
        content = typeof payload.text === "string" ? payload.text : JSON.stringify(payload, null, 2);
        output.innerHTML = `<pre class="co-file-text">${html(content)}</pre>${payload.truncated ? '<p class="co-warning">此预览仍被标记截断，请下载原文件补齐实际核对。</p>' : ""}`;
      } else {
        const response = await fetch(`/api/media/assets/${encodeURIComponent(button.dataset.coCaptionPreview)}/bytes`, { credentials: "same-origin", headers: { Accept: "text/vtt" } });
        if (!response.ok) throw Object.assign(new Error("真实字幕读取失败。"), { status: response.status });
        content = await response.text();
        if (new TextEncoder().encode(content).length > 1_048_576) throw new Error("字幕超出完整预览上限，请下载原文件补齐核对。");
        output.innerHTML = `<pre>${html(content)}</pre>`;
      }
    } catch (error) { output.innerHTML = `<p class="co-error" role="alert">${html(contentOpsError(error))}</p>`; }
    finally { button.disabled = false; button.textContent = previous; }
  });
  root.addEventListener("error", event => {
    if (!event.target.matches?.("[data-co-media], [data-co-media] source")) return;
    const wrapper = event.target.closest(".co-artifact") || event.target.closest("li");
    const failure = wrapper?.querySelector(".co-media-failure");
    if (failure) failure.hidden = false;
  }, true);
}

function renderOrderedMedia(references = []) {
  const captions = references.filter(ref => ref.role === "subtitle" && ref.assetId);
  return `<h4>有序媒体引用与实际预览</h4><ol class="co-ordered">${references.map(ref => {
    const url = ref.assetId ? `/api/media/assets/${encodeURIComponent(ref.assetId)}/bytes` : "";
    const media = url && ["image", "cover", "poster"].includes(ref.role) ? `<img data-co-media class="co-exact-image" src="${url}" loading="lazy" alt="${html(ref.alt || ref.caption || "实际媒体预览")}" />` : url && ref.role === "video" ? `<video data-co-media class="co-exact-video" controls playsinline preload="metadata"><source src="${url}" type="video/mp4" />${captions.map(caption => `<track kind="captions" src="/api/media/assets/${encodeURIComponent(caption.assetId)}/bytes" srclang="${html(caption.locale || "zh-CN")}" label="${html(caption.caption || caption.locale || "字幕")}" />`).join("")}</video>` : "";
    return `<li><strong>${html(ref.role || "媒体")} · ${html(ref.assetId || ref.id)}</strong><p>替代文字：${html(ref.alt || "未提供")}<br />图注：${html(ref.caption || "未提供")}</p>${media}${media ? '<p class="co-media-failure" role="status" hidden>这份真实媒体未能读取或解码；尚未完成预览。<button class="ghost-button" type="button" data-co-media-retry>重试读取</button></p>' : ""}${url ? `<a class="text-link" href="${url}" download>下载精确媒体文件 ↗</a>${ref.role === "subtitle" ? `<button class="ghost-button" type="button" data-co-caption-preview="${html(ref.assetId)}">读取完整字幕</button><div data-co-caption-output></div>` : ""}` : ""}${hash("媒体 SHA-256", ref.sha256)}</li>`;
  }).join("")}</ol>`;
}

export function renderNativeCandidate(candidate = {}, { artifacts = [], reports = [], source = {}, sources = [], canMaterialize = true } = {}) {
  const pack = candidate.package || candidate.publicationPackage || candidate;
  const artifactRefs = array(pack.artifactRefs);
  const referenced = artifactRefs.map(ref => {
    const current = artifacts.find(row => row.id === (ref.id || ref.artifactId));
    return { ...current, ...ref, id: ref.id || ref.artifactId, ...(!artifactMatchesReference(current, ref) ? { previewError: current?.previewError || "附件的准确字节元数据、类型、大小或独立使用权审核尚未读取一致，不能据此签署完整审阅。" } : {}) };
  });
  const sourceRefs = array(pack.sourceEditionRefs);
  const sourceRows = sourceRefs.map(ref => ({ ref, source: [...sources, source].find(row => sourceMatchesReference(row, ref)) }));
  const sourceReady = sourceRows.every(row => row.source);
  const sourceDifferences = sourceRows.length ? sourceRows.map(row => `<section><h4>准确来源母版 · ${html(row.ref.id)}</h4>${hash("冻结来源", row.ref.sha256)}${renderSourceDifference(row.source || {}, pack)}</section>`).join("") : renderSourceDifference(source, pack);
  const orderedMedia = array(pack.orderedMediaRefs || pack.assetRefs);
  const blocks = array(pack.orderedBlocks || pack.blocks);
  const reportRows = [...new Map(reports.filter(row => row.candidateId === candidate.id || reviewReportHashes(candidate).includes(row.reportHash)).map(row => [row.reportHash || row.id, row])).values()];
  const acceptedHashes = reviewReportHashes(candidate);
  const acceptedReports = acceptedHashes.length ? reportRows.filter(row => acceptedHashes.includes(row.reportHash)) : reportRows;
  const ready = candidateReviewReady(candidate, acceptedReports) && (!acceptedHashes.length || acceptedReports.length === acceptedHashes.length) && referenced.every(ref => !ref.previewError) && sourceReady;
  return `<article class="co-candidate" data-candidate-id="${html(candidate.id)}"><header class="co-card-heading"><div><p class="eyebrow">${html(FORMS[pack.nativeForm] || pack.nativeForm)} · ${html(pack.locale)} · ${html(pack.platformId)}</p><h3>${html(pack.title || "无标题")}</h3><p>${html(candidate.id)} · ${html(candidate.targetKey || pack.targetKey)}</p></div>${chip(candidate.status)}</header>${pack.summary ? `<p class="co-summary">${html(pack.summary)}</p>` : ""}<h4>完整正文</h4><pre class="co-body" lang="${pack.locale === "en-US" ? "en" : "zh-CN"}">${html(pack.body || "")}</pre>${blocks.length ? `<details open><summary>有序正文结构（${blocks.length} 项）</summary><ol class="co-ordered">${blocks.map(block => `<li><strong>${html(block.type || block.key || "内容项")}</strong><pre>${html(block.text || block.body || (block.items ? block.items.join("\n") : JSON.stringify(block, null, 2)))}</pre></li>`).join("")}</ol></details>` : ""}<details open><summary>原生发布结构、顺序与设置</summary><pre class="co-json">${json(pack.nativeManifest || pack.settings || {})}</pre></details><details><summary>目标身份、真实来源与事实绑定</summary><pre class="co-json">${json({ destination: pack.destinationIdentitySnapshot || pack.destinationSnapshot, account: pack.accountIdentitySnapshot || pack.accountSnapshot, sourceEditionRefs: pack.sourceEditionRefs, sourceClaimBindings: pack.sourceClaimBindings, operatorProfileRef: pack.operatorProfileRef, rulesRef: pack.rulesRef, rightsReviewHashes: pack.rightsReviewHashes, privacyReviewHashes: pack.privacyReviewHashes })}</pre></details>${orderedMedia.length ? renderOrderedMedia(orderedMedia) : ""}<h4>真实原生附件 · ${referenced.length} 项</h4><div class="co-stack">${referenced.length ? referenced.map(ref => renderArtifactPreview(ref)).join("") : empty("此包没有原生附件", "正文与原生设置仍须完整审阅；视频和技术作品所需实物由服务端检查。")}</div>${sourceDifferences}${renderQualityReports(reportRows, candidate)}${hash("最终包", candidate.packageHash || pack.packageHash)}${hash("完整审阅快照", candidate.reviewSnapshotHash)}${canMaterialize ? `${form("materialize", candidate.id, candidate.etag)}${check("reviewed", "我已逐项阅读完整成品、全部有序项、真实附件、目标身份、源稿差异和独立报告；将这个准确版本转为待核草稿。")}${feedback()}<button class="primary-button" type="submit"${ready ? "" : " disabled"}>转为编辑出版待核草稿</button><p class="co-muted">${ready ? "这里只建立待核稿；下一步仍需独立内容批准、排期和单次外发授权。" : "需要当前包的有效独立终检、完整审阅快照、全部准确来源与附件元数据及版本校验值后才能转稿。"}</p></form>` : ""}</article>`;
}

export function createContentOpsRequester({ api, createKey = () => `co-web-${globalThis.crypto.randomUUID()}` } = {}) {
  const attempts = new Map();
  return async (path, body, { etag, needsEtag = false, raw = false, bytes = false, headers = {} } = {}) => {
    if (needsEtag && !etag) throw new Error("当前记录缺少准确版本校验值，请先刷新并重新核对。");
    const payload = bytes || raw ? body : JSON.stringify(body);
    const signature = `${path}:${bytes ? JSON.stringify(headers) : payload}`;
    const attempt = attempts.get(signature) || { key: createKey(), etag };
    attempts.set(signature, attempt);
    try {
      const result = await api(path, { method: "POST", headers: { ...headers, "Idempotency-Key": attempt.key, ...(attempt.etag ? { "If-Match": attempt.etag } : {}) }, body: payload });
      attempts.delete(signature);
      return result;
    } catch (error) {
      if (error.status >= 400 && error.status < 500) attempts.delete(signature);
      else if (error && typeof error === "object" && Object.isExtensible(error)) error.requestUnconfirmed = true;
      throw error;
    }
  };
}

function targetName(target, data = {}) {
  const destinationId = target.destinationId || target.destinationRef?.id;
  const destination = array(data.destinations).find(row => row.id === destinationId);
  const profile = array(data.profiles).find(row => (row.platformId || row.id) === target.platformId);
  return `${profile?.nameZh || profile?.name || target.platformId || "目标"} · ${destination?.name || destinationId || target.targetKey || ""}`;
}

function renderTargetRun(target, job, data) {
  const tasks = array(target.steps).length ? target.steps : array(job.tasks || job.blueprints).filter(row => row.targetKey === target.targetKey);
  const candidateId = target.candidateId || target.latestCandidateId;
  return `<section class="co-target"><header class="co-card-heading"><div><h4>${html(targetName(target, data))}</h4><p class="co-muted">${html(target.locale)} · ${html(FORMS[target.nativeForm] || target.nativeForm)} · ${html(target.targetKey)}</p></div>${chip(target.status)}</header>${bullets(target.blockingReasons || target.gaps || target.knownGaps)}<ol class="co-task-list">${tasks.map(task => `<li><strong>${html(task.label || task.kind || task.stepId || task.id)}</strong>${chip(task.status || "pending")}<p>${html(task.error?.message || task.reason || "")}</p>${task.attemptId ? `<p>尝试 ${html(task.attemptId)} · epoch ${html(task.epoch)}</p>` : ""}<details><summary>步骤、依赖与准确输入</summary><pre class="co-json">${json(task)}</pre></details></li>`).join("")}</ol>${candidateId ? `<button class="primary-button" type="button" data-co-candidate="${html(candidateId)}">阅读完整成品与报告</button>` : '<p class="co-muted">尚未形成最终成品；等待输入、执行和独立终检。</p>'}${!TERMINAL.has(job.status) && candidateId ? `<details><summary>只重做这个目标</summary>${form("revise", job.id || job.jobId, job.etag)}<input type="hidden" name="targetKey" value="${html(target.targetKey)}" /><input type="hidden" name="candidateId" value="${html(candidateId)}" /><label><span>明确要改的内容与原因</span><textarea name="instructions" required minlength="8" maxlength="4000" rows="4" placeholder="指出具体句段、字幕、图序或文件问题；修改会形成新候选并重新独立终检。"></textarea></label>${check("confirmed", "我授权在原任务剩余预算内返修这个目标；原成品与未知费用保留，新候选重新终检。")} ${feedback()}<button class="ghost-button" type="submit"${job.etag ? "" : " disabled"}>为此目标建立新修订</button></form></details>` : ""}</section>`;
}

export function renderContentOpsJob(job = {}, data = {}) {
  const targets = array(job.targets || job.targetRuns);
  const readyCount = targets.filter(row => ["ready_for_review", "materialized"].includes(row.status)).length;
  const skippedCount = targets.filter(row => ["skip", "skipped"].includes(row.status)).length;
  const failedCount = targets.filter(row => ["blocked", "failed", "needs_input", "blocked_budget", "needs_reconcile"].includes(row.status)).length;
  return `<article class="co-job"><header class="co-card-heading"><div><p class="eyebrow">准备工单 · ${html(job.id || job.jobId)}</p><h3>${html(job.goal || job.plan?.goal || "平台内容准备")}</h3><p class="co-muted">创建 ${html(timestamp(job.createdAt))} · 截止 ${html(timestamp(job.deadlineAt || job.budgetAuthorization?.deadlineAt))}</p></div>${chip(job.status)}</header><div class="co-metrics"><div><span>本次实际目标</span><strong>${targets.length}</strong></div><div><span>完整成品待审 / 已转稿</span><strong>${readyCount}</strong></div><div><span>明确跳过</span><strong>${skippedCount}</strong></div><div><span>缺输入 / 阻断 / 待核对</span><strong>${failedCount}</strong></div></div><p class="co-muted">准备完成、最终独立终检、人工内容批准与真实发布分别记录。跳过不计发布成功；本页不会对外发送。</p>${hash("准确计划", job.planHash || job.planRef?.sha256)}${hash("静态任务蓝图", job.blueprintHash || job.compiledBlueprintHash)}${renderBudgetLedger(job)}${renderUsageReconciliations(job)}<div class="co-stack">${targets.length ? targets.map(target => renderTargetRun(target, job, data)).join("") : empty("未返回目标明细", "读取完整工单后再判断准备进度。")}</div>${array(job.artifacts).length ? `<details class="co-panel"><summary>本工单真实产物与使用权审核（${job.artifacts.length}）</summary><div class="co-stack">${job.artifacts.map(row => renderArtifactPreview(row, { review: true })).join("")}</div></details>` : ""}${!TERMINAL.has(job.status) ? `<details class="co-cancel"><summary>取消后续准备步骤</summary>${form("cancel", job.id || job.jobId, job.etag)}<label><span>实际取消原因</span><textarea name="reason" required minlength="8" maxlength="2000" rows="3"></textarea></label>${check("confirmed", "停止尚未派发的后续步骤；已派发请求、真实产物与未知预留仍保留，不保证供应商未执行或未收费。")} ${feedback()}<button class="ghost-button" type="submit"${job.etag ? "" : " disabled"}>取消后续准备</button></form></details>` : ""}<details class="co-panel"><summary>完整任务、尝试与恢复记录</summary><pre class="co-json">${json(job)}</pre></details></article>`;
}

export function renderWorkers(workers = []) {
  return `${empty("本机工位与云端授权分别核对", "工位只领取固定任务并提交真实产物。云端授权、本机 owner 确认、适配器 ready 与实际生产验证分别记录；本页不展示或复制凭据。")}<div class="co-stack">${workers.length ? workers.map(worker => `<article class="co-worker"><header class="co-card-heading"><div><h3>${html(worker.name || worker.label || worker.workerId || worker.id)}</h3><p class="co-muted">${html(worker.workerId || worker.id)} · 最近联系 ${html(timestamp(worker.lastSeenAt || worker.heartbeatAt))}</p></div>${chip(worker.status || (worker.revokedAt ? "revoked" : "unverified"))}</header><p class="co-muted">授权到期：${html(timestamp(worker.expiresAt || worker.grant?.expiresAt))} · 本机 owner ${worker.localApproved || worker.localConfirmedAt ? "已确认限定范围" : "尚未确认"}</p><div class="co-worker-readiness">${array(worker.adapters || worker.readiness || worker.adapterReadiness).map(row => `<div><strong>${html(row.adapterId || row.id || row.kind)} · ${html(row.version)}</strong><span>${row.declared ? "目录已声明" : "目录待核"} · ${row.codePresent ? "代码在场" : "代码待核"} · ${row.ready ? "指定范围 ready" : "尚未 ready"} · ${row.productionVerified ? "有真实生产验证" : "尚无真实生产验证"}</span><p class="co-muted">${html(row.reason || row.blockedReason || "")}</p></div>`).join("") || '<p class="co-muted">尚未返回固定适配器的就绪依据。</p>'}</div>${hash("双端授权范围", worker.scopeHash || worker.grant?.scopeHash)}<details><summary>允许的工单、适配器与范围</summary><pre class="co-json">${json(worker)}</pre></details></article>`).join("") : empty("尚无已配对工位", "管理员需先创建限定配对挑战，再由本机 owner 在独立 worker 流程确认。目录中有工具不会自动建立工位权限。")}</div>`;
}

export function buildWorkerLocalTemplates(pairing, { jobs = [], budgets = [] } = {}) {
  const scope = pairing?.scope;
  if (!scope || !/^[a-f0-9]{64}$/.test(pairing.scopeHash || "") || !array(scope.jobIds).length) throw new Error("需要这次准确配对挑战的完整范围，不能从岗位目录推测本机权限。");
  const selectedJobs = scope.jobIds.map(id => {
    const job = jobs.find(row => row.id === id);
    if (!job || !Array.isArray(job.tasks)) throw new Error(`尚未读取准确工单 ${id} 的全部固定任务，不能导出本机范围。`);
    return job;
  });
  const budgetHashes = [...new Set(selectedJobs.map(job => job.budgetAuthorizationHash))];
  if (budgetHashes.length !== 1 || !/^[a-f0-9]{64}$/.test(budgetHashes[0] || "")) throw new Error("本机授权需要同一准确预算快照。无预算工单须先新建计划修订；不同预算应分别建立工位范围。");
  const budget = budgets.find(row => row.authorizationHash === budgetHashes[0]);
  if (!budget || selectedJobs.some(job => job.budgetAuthorizationId !== budget.id)) throw new Error("准确预算授权尚未完整读取，请刷新后重新核对。");
  const tasks = selectedJobs.flatMap(job => job.tasks).filter(task => task.permissionRequirements?.localOwnerRequired !== false && Boolean(task.permissionRequirements?.independentChecker) === Boolean(scope.checker) && scope.adapterIds.includes(task.adapterBinding?.adapterId) && (!scope.targetKeys.length || scope.targetKeys.includes(task.targetKey)));
  if (!tasks.length) throw new Error("这个范围没有与工位角色、目标及适配器一致的固定任务；请核对独立 checker 与起草工位的区别。");
  const bindings = [...new Map(tasks.map(task => [JSON.stringify(task.adapterBinding), task.adapterBinding])).values()];
  const bindingKeys = ["kind", "adapterId", "version", "entrypointSha", "validatorVersion", "fixedTransport", "nativeCapabilityId"];
  for (const binding of bindings) if (!/^[a-f0-9]{64}$/.test(binding?.entrypointSha || "") || Object.keys(binding).some(key => !bindingKeys.includes(key))) throw new Error("任务的固定适配器绑定尚不可核对，请先修复服务注册表，不能用目录存在代替准确版本。");
  const limits = { maxTempBytes: Math.min(scope.maxTempBytes, budget.maxTempBytes), maxRenderSeconds: Math.min(scope.maxRenderSeconds, budget.maxRenderSeconds), maxNativeProcesses: Math.min(scope.maxNativeProcesses, budget.maxNativeProcesses), maxCalls: Math.min(budget.maxCalls, 1000) };
  const maximums = { maxTempBytes: 2_000_000_000, maxRenderSeconds: 86_400, maxNativeProcesses: 100, maxCalls: 1000 };
  for (const [key, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < (["maxTempBytes", "maxCalls"].includes(key) ? 1 : 0) || value > maximums[key]) throw new Error("云端范围与本机资源上限不兼容，请建立实际可执行的受控范围后再导出。");
  const grant = { schema: "pengmanager.worker-local-grant/v1", workerId: scope.workerId, origin: scope.origin, workspaceId: scope.workspaceId, projectIds: [...scope.projectIds], jobIds: [...scope.jobIds], targetKeys: [...new Set(tasks.map(task => task.targetKey))], adapterBindings: structuredClone(bindings), scopeHash: pairing.scopeHash, budgetAuthorizationHash: budgetHashes[0], expiresAt: new Date(Math.min(Date.parse(scope.expiresAt), Date.parse(budget.deadlineAt))).toISOString(), limits, roles: [scope.checker ? "checker" : "worker"], ownerConfirmed: false };
  const directory = `/absolute/private/content-ops/${scope.workerId}`;
  const config = { schema: "pengmanager.worker-config/v1", origin: scope.origin, workerId: scope.workerId, dataDir: `${directory}/state`, grantFile: `${directory}/local-grant.json`, currency: budget.currency };
  return { grant, config };
}

const TABS = { profiles: "28 岗位", prepare: "建立准备计划", sources: "真实来源与规则", jobs: "工单与成品", budgets: "预算授权", workers: "本机工位" };
const SOURCE_ROLE_LABELS = { source_image: "真实源图片", source_video: "真实源视频", transcript: "真实逐字稿", timed_captions: "已有时间轴字幕", code: "真实源码 / 静态差异", dataset: "真实数据集", notebook: "真实 Notebook", run_log: "实际运行记录", rights_evidence: "许可与权利依据", model_weights: "真实模型张量（仅静态验证）" };

export function renderValidation(validation = {}, data = {}) {
  const plan = validation.normalizedPlan || validation.plan || {};
  const source = array(data.stories).find(row => row.id === plan.storyRef?.id);
  const expired = validation.expiresAt && new Date(validation.expiresAt).getTime() <= Date.now();
  return `<article class="co-panel"><h3>服务器校验快照</h3><p class="co-muted">校验只冻结数据；尚未创建工单、调用模型或工具。预算、来源或目标变化后须更新计划并重新校验。</p>${hash("校验记录", validation.validatedImportId || validation.id)}${hash("归一化计划", validation.planHash)}<p class="co-muted">有效期至 ${html(timestamp(validation.expiresAt))}${expired ? " · 已过期，请重新校验" : ""}</p><div class="co-stack">${array(validation.targets).map(target => {
    const selection = { ...array(plan.targets).find(row => row.targetKey === target.targetKey), ...target };
    return `<article class="co-target"><strong>${html(targetName(selection, data))}</strong>${chip(target.decision || target.status || "prepare")}<p class="co-muted">${html(selection.locale || "语言未返回")} · ${html(FORMS[selection.nativeForm] || selection.nativeForm || "形式未返回")}</p><p class="co-muted">${html(label(target.effectivePolicy?.creationMode))} · ${html(label(target.effectivePolicy?.deliveryMode))}<br />允许的 AI 操作：${html(array(target.effectivePolicy?.allowedAiActions).map(label).join("、") || "未获准")}</p>${bullets(target.gaps || target.knownGaps)}<details><summary>准确规则、条件与目标绑定</summary><pre class="co-json">${json(selection)}</pre></details></article>`;
  }).join("")}</div><details><summary>完整归一化计划与来源快照</summary><pre class="co-json">${json(plan)}</pre><pre class="co-json">${json(validation.sourceBindings)}</pre></details>${form("create-job", validation.validatedImportId || validation.id, validation.storyEtag || source?.etag)}${check("confirmed", "我已核对准确母版、全部目标、创作限制、真实输入缺口与预算范围，创建这份准确计划的准备工单。")}${feedback()}<button class="primary-button" type="submit"${expired || !validation.planHash || !(validation.storyEtag || source?.etag) ? " disabled" : ""}>${plan.budgetAuthorizationRef ? "创建受控准备工单" : "保存预算待配置工单"}</button><p class="co-muted">${plan.budgetAuthorizationRef ? "创建工单后仍需本机双端授权与固定适配器就绪。" : "未配置预算只保存草稿，不派发。补预算时新建计划修订并重新校验，旧工单与未知预留保留。"}</p></form></article>`;
}

export function mountContentOps({ api, getData = () => null, afterMaterialize, afterMediaImport } = {}) {
  const root = document.querySelector("#content-ops-root");
  if (!root) return { async load() { return false; }, render() {} };
  const state = { tab: "profiles", data: null, loading: false, error: null, notice: "", query: "", planText: "", validation: null, selectedJobId: "", job: null, candidate: null, candidateError: null, jobError: null, pairing: null, localSetup: null, localSetupError: null, sourceArtifacts: [], sourceCapabilities: null, sourceError: null, sourceFile: null, templateGaps: [] };
  const send = createContentOpsRequester({ api });
  const drafts = new Map();
  const pending = new Set();
  const completedForms = new WeakSet();
  const pendingControls = new WeakMap();
  let loadPromise = null;
  let detailSequence = 0;
  const rows = key => array(state.data?.[key]);
  const formKey = element => `${element.dataset.coForm}:${element.dataset.id || "new"}`;
  const allArtifacts = () => [...rows("artifacts"), ...array(state.job?.artifacts), ...state.sourceArtifacts];

  function captureDrafts() {
    for (const element of root.querySelectorAll("form[data-co-form]")) {
      if (completedForms.has(element)) continue;
      drafts.set(formKey(element), [...element.elements].filter(field => field.name && !["file", "hidden"].includes(field.type)).map(field => ({ name: field.name, value: field.value, checked: field.checked, type: field.type })));
    }
  }

  function restoreDrafts() {
    for (const element of root.querySelectorAll("form[data-co-form]")) {
      for (const field of element.elements) {
        if (!field.name || ["file", "hidden"].includes(field.type)) continue;
        const previous = drafts.get(formKey(element))?.find(row => row.name === field.name && (field.type !== "checkbox" || row.value === field.value));
        if (!previous) continue;
        if (field.type === "checkbox") field.checked = ["destinationId", "motherEditionId", "sourceArtifactId", "adapterIds", "allowedAiActions", "requiresAuthorContribution", "checker"].includes(field.name) ? previous.checked : false;
        else if (field.tagName !== "SELECT" || [...field.options].some(option => option.value === previous.value)) field.value = previous.value;
      }
      if (pending.has(formKey(element))) {
        pendingControls.set(element, [...element.elements].map(field => [field, field.disabled]));
        for (const field of element.elements) field.disabled = true;
      }
    }
  }

  function preparePanel() {
    const stories = rows("stories").filter(row => row.status !== "archived");
    const destinations = rows("destinations").filter(row => row.status !== "archived");
    const budgets = rows("budgetAuthorizations").filter(row => !row.revokedAt && (!row.deadlineAt || new Date(row.deadlineAt).getTime() > Date.now()));
    return `${authorContributionPanel(stories)}<article class="co-panel"><h3>从真实母版建立计划</h3><p class="co-muted">先选准确母版、相关目的地和原生成品；服务生成可审阅的数据计划。缺素材、规则或真实作者贡献会明确留在计划中。</p>${form("plan-template")}<div class="co-form-grid"><label><span>真实选题</span><select name="storyId" required data-co-story><option value="">选择已登记选题</option>${options(stories.map(row => [row.id, `${row.workingTitle || row.title} · ${row.id}`]))}</select></label><label><span>准备预算</span><select name="budgetAuthorizationId"><option value="">尚未配置，仅保存计划 / 阻断工单</option>${options(budgets.map(row => [row.id, `${row.name || row.id} · ${formatBudgetValue(row.maxCostMicros, { currency: row.currency, micros: true })}`]))}</select></label><label class="wide"><span>本次目标与读者要解决的问题</span><textarea name="goal" required minlength="8" maxlength="2000" rows="3" placeholder="例如：用这次真实交付，向技术读者解释为何选择这一实现，以及适用边界。"></textarea></label></div><fieldset class="co-choice"><legend>准确母版修订</legend><div data-co-mothers>${empty("先选择选题", "只列该选题的真实不可变版本；不会用平台稿替代母版。")}</div></fieldset><fieldset class="co-choice"><legend>本次授权使用的真实源文件</legend><div data-co-source-choices></div></fieldset><fieldset class="co-choice"><legend>本次相关目标（1—28 个）</legend><div class="co-stack">${destinations.length ? destinations.map(destination => {
      const profile = rows("profiles").find(row => (row.platformId || row.id) === destination.platformId);
      const nativeForms = array(profile?.supportedNativeForms || profile?.nativeForms);
      return `<div class="co-target-choice"><label class="co-check"><input type="checkbox" name="destinationId" value="${html(destination.id)}" /><span><strong>${html(destination.name || destination.id)}</strong><br />${html(destination.platformId)} · ${html(label(destination.status))} · ${html(destination.accountId || "自有官网")}</span></label><div class="co-form-grid"><label><span>成品语言</span><select name="locale-${html(destination.id)}">${options([["zh-CN", "中文"], ["en-US", "English"]])}</select></label><label><span>原生成品</span><select name="nativeForm-${html(destination.id)}">${options((nativeForms.length ? nativeForms : Object.keys(FORMS)).map(value => [value, FORMS[value] || value]))}</select></label></div><details data-co-native-inputs="${html(destination.id)}" hidden><summary>准确仓库版本与准备范围</summary><div class="co-form-grid"><label class="wide"><span>真实 base commit（40 位 SHA；缺失会保留 needs_input）</span><input name="baseCommit-${html(destination.id)}" maxlength="40" pattern="[a-f0-9]{40}" /></label><label><span>只准备，不写入仓库</span><select name="repositoryOperation-${html(destination.id)}">${options([["prepare_release_notes", "准备发布说明"], ["prepare_diff", "准备静态差异"]])}</select></label><label><span>准确 tag（有真实 tag 才填）</span><input name="repositoryTag-${html(destination.id)}" maxlength="100" /></label></div></details></div>`;
    }).join("") : empty("尚无真实目的地", "先在编辑出版登记具体账号、域名、仓库或社区。目录不会自动建立目的地。")}</div></fieldset>${feedback()}<button class="ghost-button" type="submit"${stories.length && destinations.length ? "" : " disabled"}>生成可审阅的计划数据</button></form></article><article class="co-panel"><h3>导入 / 编辑 AdaptationPlan</h3><p class="co-muted">可以载入本地 UTF-8 JSON 或粘贴岗位输出。字段、引用、规则、预算和 DAG 均由服务端校验；这里不会执行其中的命令、URL 或代码。</p>${form("validate-plan")}<label><span>本地计划 JSON（最大 1,000,000 bytes）</span><input type="file" name="planFile" accept="application/json,.json" data-co-plan-file /></label><label><span>完整计划 JSON</span><textarea name="planJson" data-co-plan-json required rows="18" spellcheck="false" placeholder="载入已有计划，或先从上方真实母版生成。">${html(state.planText)}</textarea></label>${feedback()}<button class="primary-button" type="submit">仅校验并冻结导入快照</button></form></article>${state.templateGaps.length ? `<article class="co-panel"><h3>计划生成时的明确缺口</h3>${bullets(state.templateGaps)}</article>` : ""}${state.validation ? renderValidation(state.validation, state.data) : ""}`;
  }

  function authorContributionPanel(stories) {
    return `<details class="co-panel"><summary>登记真实作者贡献与原稿（作者主导目的地需要）</summary><p class="co-muted">保存真实作者已有的观点、经历、原稿和来源版本。不是把 AI 草稿最后勾选“本人审过”当作作者贡献；平台的创作限制在生成前生效。</p>${form("author-contribution")}<div class="co-form-grid"><label><span>对应选题</span><select name="storyId" required><option value="">选择真实选题</option>${options(stories.map(row => [row.id, `${row.workingTitle || row.title} · ${row.id}`]))}</select></label><label><span>原稿语言</span><select name="locale">${options([["zh-CN", "中文"], ["en-US", "English"]])}</select></label><label class="wide"><span>原稿标题 / 材料名称</span><input name="title" required maxlength="240" /></label><label class="wide"><span>真实作者原文（完整）</span><textarea name="body" required maxlength="50000" rows="12"></textarea></label><label><span>实际作者</span><input name="authoredBy" required maxlength="120" autocomplete="name" /></label><label class="wide"><span>来源、形成时间与本次允许辅助的范围</span><textarea name="sourceNote" required minlength="8" maxlength="2000" rows="3"></textarea></label></div>${check("confirmed", "这是真实作者实际提供的准确原文与贡献记录，我有权将其用于本次限定编辑；不把模型生成或最后人审冒充作者原稿。")} ${feedback()}<button class="ghost-button" type="submit"${stories.length ? "" : " disabled"}>保存不可变作者贡献版本</button></form><details><summary>当前已有作者材料（${rows("authorContributions").length}）</summary>${rows("authorContributions").length ? `<pre class="co-json">${json(rows("authorContributions"))}</pre>` : '<p class="co-muted">尚未登记；需要作者主导的目标会保留输入缺口。</p>'}</details></details>`;
  }

  function sourcesPanel() {
    const stories = rows("stories").filter(row => row.status !== "archived");
    const roles = state.sourceCapabilities?.roles || {};
    const allMimes = [...new Set(Object.values(roles).flat())];
    const upload = `<article class="co-panel"><h3>上传真实来源文件</h3><p class="co-muted">文件只从你选中的浏览器文件读取，并绑定准确选题。服务器按真实字节验证类型、大小与摘要。上传后仍需独立核对来源、许可与隐私；代码、Notebook、模型和压缩包均不执行。</p>${form("source-upload")}<div class="co-form-grid"><label><span>真实选题</span><select name="storyId" required><option value="">选择该源文件所属选题</option>${options(stories.map(row => [row.id, `${row.workingTitle || row.title} · ${row.id}`]))}</select></label><label><span>本次用途</span><select name="role" required data-co-source-role><option value="">选择真实用途</option>${options(Object.keys(roles).map(role => [role, SOURCE_ROLE_LABELS[role] || role]))}</select></label><label class="wide"><span>实际源文件（单文件上限 ${formatBudgetValue(state.sourceCapabilities?.maxArtifactBytes)} bytes）</span><input name="sourceFile" type="file" data-co-source-file${state.sourceFile ? "" : " required"} />${state.sourceFile ? `<small class="co-muted">已选 ${html(state.sourceFile.name)} · ${formatBudgetValue(state.sourceFile.size)} bytes。未重新选择时仍使用这份准确文件。</small>` : ""}</label><label class="wide"><span>实际 MIME 类型（服务器仍检查真实字节）</span><select name="mime" required data-co-source-mime><option value="">先选用途，再核对文件真实类型</option>${options(allMimes.map(mime => [mime, mime]))}</select></label></div>${feedback()}<button class="primary-button" type="submit"${stories.length && allMimes.length ? "" : " disabled"}>校验并上传真实源文件 · 待审核</button></form></article>`;
    const rules = `<details class="co-panel"><summary>保存当次实际审阅的目的地规则</summary><p class="co-muted">规则针对一个具体账号 / 社区 / 频道，不从平台目录推断。请先实际阅读官方规则和目的地要求，再记录本次允许的 AI 操作、作者参与、标识与有效期。创作与外发是两个独立轴，人工最终批准不放宽被禁止的创作方式。</p>${form("rule-create")}<div class="co-form-grid"><label class="wide"><span>准确发布目的地</span><select name="destinationId" required><option value="">选择实际目的地</option>${options(rows("destinations").filter(row => row.status !== "archived").map(row => [row.id, `${row.name} · ${row.platformId}`]))}</select></label><label><span>允许的创作模式</span><select name="creationMode">${options(["human_only", "author_led_editor_assist", "human_original_copyedit", "ai_assisted_draft", "ineligible"].map(value => [value, label(value)]))}</select></label><label><span>交付 / 外发模式</span><select name="deliveryMode">${options(["prepare_only", "manual_only", "separately_authorized", "ineligible"].map(value => [value, label(value)]))}</select></label><label><span>实际审阅时间（北京时间）</span><input type="datetime-local" name="checkedAt" required /></label><label><span>本次快照有效期（北京时间）</span><input type="datetime-local" name="expiresAt" required /></label></div><fieldset class="co-choice"><legend>本次规则明确允许的 AI 操作</legend>${["research", "outline", "copyedit", "translate", "draft", "generate_media"].map(action => `<label class="co-check"><input name="allowedAiActions" type="checkbox" value="${action}" /><span>${html(label(action))}</span></label>`).join("")}</fieldset><label class="co-check"><input name="requiresAuthorContribution" type="checkbox" /><span>规则要求真实作者主导 / 本人原稿。必须在生成前提供准确作者材料。</span></label><label><span>必须满足的条件（每行一项，来自实际规则）</span><textarea name="requiredConditions" rows="4" maxlength="8000" placeholder="保留准确条件，不用笼统的“已人审”代替禁止或作者参与要求。"></textarea></label><label><span>实际阅读的规则来源 JSON</span><textarea name="sources" required rows="6" spellcheck="false" placeholder='[{"url":"实际官方 HTTPS 地址","title":"规则标题","scope":"这份正文具体支持哪些限制，哪些内容未取得"}]'></textarea></label><label><span>本次核对依据与缺口</span><textarea name="note" required minlength="8" maxlength="4000" rows="3"></textarea></label>${check("confirmed", "我已实际阅读并核对上述规则来源、读取范围、目的地与创作／外发两轴；不会把目录或旧样本当作当前授权。")} ${feedback()}<button class="ghost-button" type="submit">保存不可变目的地规则快照</button></form></details>`;
    return `${state.sourceError ? `<p class="co-error" role="alert">真实来源列表读取未完成。${html(contentOpsError(state.sourceError))}</p>` : ""}${upload}${rules}<section class="co-stack"><div class="co-section-title"><h3>本地导入的真实源文件</h3><span>${state.sourceArtifacts.length} 份</span></div>${state.sourceArtifacts.length ? state.sourceArtifacts.map(row => `<section class="co-panel"><p class="co-muted">选题 ${html(row.storyId)} · ${html(SOURCE_ROLE_LABELS[row.role] || row.role)} · ${html(timestamp(row.createdAt))}</p>${renderArtifactPreview(row, { review: true })}</section>`).join("") : empty("还没有真实来源文件", "没有视频、代码、数据、Notebook 或模型时，相关目标会明确缺输入；不会用说明文字冒充实物。")}</section>`;
  }

  function jobsPanel() {
    const jobs = rows("jobs");
    return `<div class="co-section-title"><div><h3>本次目标与成品</h3><p>逐目标保留成功、跳过、缺输入、错误与未知结果。</p></div><span>${jobs.length} 个准备工单</span></div><label class="co-job-selector"><span>选择准备工单</span><select data-co-job-select><option value="">选择一个真实工单</option>${options(jobs.map(row => [row.id || row.jobId, `${row.goal || row.plan?.goal || row.id || row.jobId} · ${label(row.status)}`]), state.selectedJobId)}</select></label>${state.jobError ? `<p class="co-error" role="alert">${html(contentOpsError(state.jobError))}</p>` : ""}${state.job ? renderContentOpsJob(state.job, state.data) : empty(jobs.length ? "请选择工单读取完整记录" : "还没有准备工单", "从准确母版生成或导入计划，先校验，再明确创建。")}${state.candidateError ? `<p class="co-error" role="alert">${html(contentOpsError(state.candidateError))}</p>` : ""}${state.candidate ? renderNativeCandidate(state.candidate, { artifacts: allArtifacts(), reports: [...rows("reports"), ...array(state.job?.reports), ...array(state.candidate.qualityReports || state.candidate.reports)], sources: [...rows("editions"), ...array(state.candidate.sourceEditions)], source: state.candidate.sourceEdition || {} }) + renderHumanQualityReview(state.candidate, allArtifacts(), { sources: [...rows("editions"), ...array(state.candidate.sourceEditions)] }) : ""}`;
  }

  function budgetsPanel() {
    const budgets = rows("budgetAuthorizations");
    return `<article class="co-panel"><h3>只对明确范围授权准备预算</h3><p class="co-muted">金额使用指定币种的百万分之一。价格快照必须来自已核实配置；实际账单未知时保留 null，未知预留不会因新授权消失。授权后需要新计划修订与重新校验。</p>${form("budget-create")}<div class="co-form-grid"><label class="wide"><span>本次授权名称与用途</span><input name="name" required maxlength="240" /></label><label><span>币种</span><select name="currency">${options([["CNY", "CNY"], ["USD", "USD"]])}</select></label><label><span>最高金额（micros，1 单位币种 = 1,000,000）</span><input name="maxCostMicros" required type="number" min="0" step="1" max="9007199254740991" placeholder="填写本次真实上限" /></label>${[["maxCalls", "累计底层请求上限", 1, 280], ["maxInputTokens", "累计输入 token 上限", 1, 1000000], ["maxOutputTokens", "累计输出 token 上限", 1, 160000], ["maxPerCallInputTokens", "单次最坏输入 token", 1, 32000], ["maxPerCallOutputTokens", "单次最坏输出 token", 1, 8000], ["maxInFlight", "同时派发请求上限", 1, 2], ["maxRenderSeconds", "本机渲染上限（秒）", 0, 600], ["maxTempBytes", "临时文件上限（bytes）", 1, 524288000], ["maxNativeProcesses", "本机进程并发上限", 1, 1]].map(([name, title, min, value]) => `<label><span>${title}</span><input name="${name}" required type="number" min="${min}" step="1" max="9007199254740991" value="${value}" /></label>`).join("")}<label><span>准确截止时间（北京时间）</span><input name="deadlineAt" required type="datetime-local" /></label><label class="wide"><span>已核实价格快照 JSON（付费模型必填；纯本机零模型可留空）</span><textarea name="pricingSnapshot" rows="9" spellcheck="false" placeholder="严格字段：provider、model、currency、unit: million_tokens、inputCostMicrosPerMillion、outputCostMicrosPerMillion、requestCostMicros、coveredBillingDimensions、verifiedAt、expiresAt、sourceUrl、reviewed:true。填写当次实际核实值，不填凭据；无有效快照不派发模型。"></textarea></label></div>${check("confirmed", "我授权本次上述明确范围和费用上限，已核对价格来源、单位与有效期；准备授权不包含发布、购买、部署或新增镜头生成。")} ${feedback()}<button class="primary-button" type="submit">保存明确预算授权</button></form></article><div class="co-stack">${budgets.length ? budgets.map(budget => `<article class="co-panel"><header class="co-card-heading"><div><h3>${html(budget.name || budget.id)}</h3><p class="co-muted">${html(budget.id)} · ${html(timestamp(budget.deadlineAt))}</p></div>${chip(budget.status || (new Date(budget.deadlineAt).getTime() <= Date.now() ? "expired" : "active"))}</header>${hash("授权快照", budget.authorizationHash || budget.sha256)}<pre class="co-json">${json(budget)}</pre></article>`).join("") : empty("还没有明确预算授权", "可以先保存无预算计划。未配置金额或有效价格时不启动付费准备。")}</div>`;
  }

  function workersPanel() {
    const adapters = rows("adapterBindings");
    const pairing = state.pairing ? `<section class="co-panel"><h3>一次性本机配对挑战</h3><p class="co-warning">这份挑战只在当前页面内存显示。仅交给获准的本机 owner，在受保护 worker 配对流程中使用；不粘贴到聊天、仓库、日志或命令行参数。关闭后不会在后台再次返回明文。</p>${state.pairing.requiresNewChallenge || !state.pairing.challenge ? '<p class="co-error" role="alert">原挑战明文未返回或响应丢失后无法重新读取；这次不能据此配对。请保留原请求与范围，明确核对后新建一次挑战。不要把缺失挑战、工位令牌或管理员会话互相代替。</p>' : ""}<pre data-co-pairing>${json(state.pairing)}</pre><div class="co-artifact-actions"><button class="ghost-button" type="button" data-co-local-templates>读取准确工单 · 准备无凭据本机模板</button><button class="ghost-button" type="button" data-co-close-pairing>关闭并清除页面明文</button></div>${state.localSetupError ? `<p class="co-error" role="alert">${html(contentOpsError(state.localSetupError))}</p>` : ""}${state.localSetup ? `<details class="co-panel" open><summary>本机 owner 待核对模板 · 尚未授权执行</summary><p class="co-muted">模板从这次配对范围、全部固定任务与同一预算生成，仅包含数据。ownerConfirmed 保持 false；不包含挑战、工位令牌、模型密钥、管理员会话或本机来源路径。下载后先移到本人私有目录，改成实际绝对路径，并把两个文件权限设为 0600。</p><div class="co-artifact-actions"><button type="button" class="ghost-button" data-co-download-template="grant">下载 local-grant.json</button><button type="button" class="ghost-button" data-co-download-template="config">下载 worker.json</button></div><h4>本机授权模板 · 逐项核对后才可授权</h4><pre class="co-json">${json(state.localSetup.grant)}</pre><h4>本机配置模板 · 使用真实私有目录</h4><pre class="co-json">${json(state.localSetup.config)}</pre><ol class="co-ordered"><li>在本机逐项核对 origin、工单、目标、固定适配器版本、独立角色、预算、资源和期限。只有本人实际批准后才把 local-grant.json 的 ownerConfirmed 改为 true。</li><li>在仓库运行 <code>node scripts/content-ops-worker.mjs grant-hash --grant /实际私有绝对路径/local-grant.json</code>，把输出的 localGrantHash 加入同一文件。每次修改授权内容后须重新核对并计算摘要；该命令不会代替本人批准。</li><li>运行 <code>node scripts/content-ops-worker.mjs doctor --config /实际私有绝对路径/worker.json</code>。模型端点、上下文证明、已核实价格和本机媒体工具按实际环境在本机配置；模板不会猜测。需要模型的任务须先通过受保护的本机进程变量提供模型密钥给 doctor，不能写入 JSON；doctor 只诊断，不请求供应商。本次任务所需的适配器未 ready 时停止执行。</li><li>工位令牌、模型密钥和当前挑战仅放入受保护的进程变量。本人再运行 <code>pair --config /实际私有绝对路径/worker.json --challenge-id ${html(state.pairing.challengeId)} --confirm-local-owner</code>（同一 CLI），实际配对后才使用 run。配对与 ownerConfirmed 都不代表产物完成或平台发布。</li></ol></details>` : ""}</section>` : "";
    const create = `<details class="co-panel"><summary>创建限定范围的本机配对挑战</summary>${form("worker-pair")}<div class="co-form-grid"><label><span>独立 worker ID</span><input name="workerId" required pattern="[A-Za-z0-9_-]{1,100}" maxlength="100" /></label><label><span>明确云端 origin</span><input name="origin" required type="url" value="${html(globalThis.location?.origin || "")}" /></label><label><span>本机工作区 ID</span><input name="workspaceId" required maxlength="100" /></label><label><span>准确到期时间（北京时间）</span><input name="expiresAt" required type="datetime-local" /></label><label class="wide"><span>允许的项目 ID（逗号分隔；填写实际范围）</span><input name="projectIds" required maxlength="1000" /></label><label class="wide"><span>允许的工单 ID（逗号分隔；不留空泛化）</span><input name="jobIds" required maxlength="3000" /></label><label class="wide"><span>限定目标键（可选，逗号分隔；未填仍受工单限制）</span><input name="targetKeys" maxlength="4000" /></label>${[["maxTempBytes", "本机临时字节上限", 524288000], ["maxRenderSeconds", "本机渲染上限（秒）", 600], ["maxNativeProcesses", "本机进程并发上限", 1]].map(([name, title, value]) => `<label><span>${title}</span><input name="${name}" type="number" min="1" step="1" max="9007199254740991" value="${value}" required /></label>`).join("")}</div><fieldset class="co-choice"><legend>仅允许下列固定适配器</legend>${adapters.length ? adapters.map(row => `<label class="co-check"><input type="checkbox" name="adapterIds" value="${html(row.adapterId || row.id)}" /><span>${html(row.adapterId || row.id)} · ${html(row.version)}<br />${html(row.description || row.kind || "按本机已审版本确认")}</span></label>`).join("") : '<p class="co-muted">服务未返回固定适配器注册表，不能创建无限范围授权。</p>'}</fieldset><label class="co-check"><input type="checkbox" name="checker" /><span>这是独立 checker 工位，仅在具备与起草／润色分离的检查上下文时勾选；不会获得批准或发布权限。</span></label>${check("confirmed", "我批准上述准确工单、项目、适配器、文件／时间限制与期限；本机 owner 仍须独立确认相同 scopeHash，不导出管理员会话或供应商密钥。")} ${feedback()}<button class="primary-button" type="submit"${adapters.length ? "" : " disabled"}>创建一次性配对挑战</button></form></details>`;
    const revoke = rows("workers").filter(row => !row.revokedAt && row.status !== "revoked").map(row => `<details class="co-panel"><summary>撤销工位 ${html(row.name || row.workerId || row.id)}</summary>${form("worker-revoke", row.workerId || row.id, row.etag)}<label><span>真实撤销原因</span><textarea name="reason" required minlength="8" maxlength="2000" rows="3"></textarea></label>${check("confirmed", "撤销这个工位的后续任务权限；已派发尝试与未知费用继续保留核对。")} ${feedback()}<button class="ghost-button" type="submit"${row.etag ? "" : " disabled"}>撤销这个工位</button></form></details>`).join("");
    return `${pairing}${create}${renderWorkers(rows("workers"))}${revoke}`;
  }

  function render() {
    captureDrafts();
    let panel;
    if (!state.data) panel = state.error ? `<div class="co-error" role="alert">${html(contentOpsError(state.error))}</div><p class="co-muted">未读取到岗位与账本，当前没有可执行操作。请刷新或核对目标服务部署与迁移版本。</p>` : empty("正在读取岗位、来源与准备工单…", "仅查询当前状态，不发起模型、渲染或平台操作。");
    else panel = ({ profiles: () => renderOperatorProfiles(rows("profiles"), { query: state.query, destinations: rows("destinations"), accounts: rows("accounts") }), prepare: preparePanel, sources: sourcesPanel, jobs: jobsPanel, budgets: budgetsPanel, workers: workersPanel }[state.tab])();
    root.innerHTML = `<div class="co-workspace"><div class="co-toolbar"><p>准确来源 → 平台策划 → 真实制作 → 最终独立终检 → 完整人审</p><button class="ghost-button" type="button" data-co-refresh${state.loading ? " disabled" : ""}>${state.loading ? "正在读取…" : "刷新岗位与工单"}</button></div><div class="co-callout"><strong>每个平台，交付一份有依据的原生成品。</strong><p>28 个岗位共用事实与预算，各自保留读者、形式和规则。准备、内容批准、单次发布授权与真实回读分别完成。</p></div>${state.notice ? `<p class="co-notice" role="status">${html(state.notice)}</p>` : ""}${state.error && state.data ? `<p class="co-error" role="alert">刷新未完成；下方保留上次读取的记录。${html(contentOpsError(state.error))}</p>` : ""}<div class="co-tabs" role="tablist" aria-label="内容运营师功能">${Object.entries(TABS).map(([tab, title]) => `<button type="button" role="tab" id="co-tab-${tab}" aria-controls="co-tabpanel" aria-selected="${state.tab === tab}" tabindex="${state.tab === tab ? 0 : -1}" data-co-tab="${tab}">${title}</button>`).join("")}</div><div id="co-tabpanel" role="tabpanel" aria-labelledby="co-tab-${state.tab}">${panel}</div></div>`;
    root.setAttribute("aria-busy", String(state.loading));
    restoreDrafts();
    updateMotherChoices();
    updateSourceMime();
    updateNativeInputs();
  }

  function updateMotherChoices() {
    const element = root.querySelector('[data-co-form="plan-template"]');
    if (!element) return;
    const storyId = element.elements.storyId.value;
    const output = element.querySelector("[data-co-mothers]");
    const selected = new Set([...output.querySelectorAll('input[name="motherEditionId"]:checked')].map(field => field.value));
    const remembered = drafts.get(formKey(element)) || [];
    for (const row of remembered) if (row.name === "motherEditionId" && row.checked) selected.add(row.value);
    const editions = rows("editions").filter(row => row.storyId === storyId);
    output.innerHTML = editions.length ? editions.map(row => `<label class="co-check"><input type="checkbox" name="motherEditionId" value="${html(row.id)}"${selected.has(row.id) ? " checked" : ""} /><span><strong>${html(row.title)}</strong><br />${html(row.id)} · ${html(row.locale)} · ${html(FORMS[row.format] || row.format)} · 修订 ${html(row.editorialRevision || row.revision || 1)}</span></label>`).join("") : empty(storyId ? "这个选题还没有不可变母版" : "先选择选题", "请在编辑出版保存完整正文、真实事实与素材后继续。");
    const sourceOutput = element.querySelector("[data-co-source-choices]");
    if (sourceOutput) {
      const selectedSources = new Set([...sourceOutput.querySelectorAll('input[name="sourceArtifactId"]:checked')].map(field => field.value));
      for (const row of remembered) if (row.name === "sourceArtifactId" && row.checked) selectedSources.add(row.value);
      const usable = state.sourceArtifacts.filter(row => row.storyId === storyId && row.status === "reviewed" && row.rightsReviewHash && row.privacyReviewHash);
      sourceOutput.innerHTML = usable.length ? usable.map(row => `<label class="co-check"><input type="checkbox" name="sourceArtifactId" value="${html(row.id)}"${selectedSources.has(row.id) ? " checked" : ""} /><span><strong>${html(row.name || row.id)}</strong><br />${html(SOURCE_ROLE_LABELS[row.role] || row.role)} · ${formatBudgetValue(row.bytes || row.size)} bytes<br /><code>${html(row.sha256)}</code></span></label>`).join("") : empty(storyId ? "该选题没有已审核的真实源文件" : "先选择选题", "在“真实来源与规则”上传、完整预览并独立核对使用权。文字稿可以按实际规则无附件准备；视频和技术作品缺实物会明确阻断。");
    }
  }

  function updateSourceMime() {
    const element = root.querySelector('[data-co-form="source-upload"]');
    if (!element) return;
    const role = element.elements.role.value;
    const mimes = state.sourceCapabilities?.roles?.[role] || [];
    const selector = element.elements.mime, previous = selector.value;
    const extension = (state.sourceFile?.name || "").split(".").at(-1).toLowerCase();
    const inferred = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", mp4: "video/mp4", vtt: "text/vtt", srt: "application/x-subrip", ass: "text/x-ass", txt: "text/plain", md: "text/markdown", diff: "text/x-diff", patch: "text/x-diff", js: "text/javascript", mjs: "text/javascript", py: "text/x-python", json: "application/json", csv: "text/csv", ipynb: "application/x-ipynb+json", zip: "application/zip", pdf: "application/pdf", safetensors: "application/x-safetensors" })[extension] || state.sourceFile?.type;
    selector.innerHTML = `<option value="">核对真实类型</option>${options(mimes.map(mime => [mime, mime]))}`;
    selector.value = mimes.includes(previous) ? previous : mimes.includes(inferred) ? inferred : "";
    element.elements.sourceFile.accept = mimes.join(",");
  }

  function updateNativeInputs() {
    const element = root.querySelector('[data-co-form="plan-template"]');
    if (!element) return;
    for (const panel of element.querySelectorAll("[data-co-native-inputs]")) {
      const active = element.elements[`nativeForm-${panel.dataset.coNativeInputs}`]?.value === "repository_change";
      panel.hidden = !active;
      for (const field of panel.querySelectorAll("input,select")) field.disabled = !active;
    }
  }

  async function load() {
    if (loadPromise) return loadPromise;
    state.loading = true;
    state.error = null;
    render();
    loadPromise = (async () => {
      try {
        const [bootstrap, sources] = await Promise.allSettled([api("/api/content-ops/bootstrap"), api("/api/content-ops/source-artifacts")]);
        if (sources.status === "fulfilled") {
          state.sourceArtifacts = array(sources.value.items);
          state.sourceCapabilities = sources.value;
          state.sourceError = null;
        } else state.sourceError = sources.reason;
        if (bootstrap.status === "rejected") throw bootstrap.reason;
        const data = bootstrap.value;
        if (!data || !Array.isArray(data.profiles) || !Array.isArray(data.jobs)) throw Object.assign(new Error("内容运营师响应格式与当前界面不兼容，请核对部署版本。"), { code: "CONTENT_OPS_RESPONSE_INVALID", status: 503 });
        state.data = { ...data, ...(data.sources || {}), budgetAuthorizations: data.budgets || data.budgetAuthorizations || [] };
        if (!state.data.accounts && getData()?.accounts) state.data.accounts = getData().accounts;
        if (state.selectedJobId) {
          try { state.job = await enrichJob(await api(`/api/content-ops/jobs/${encodeURIComponent(state.selectedJobId)}`)); state.jobError = null; }
          catch (error) { state.jobError = error; }
        }
        state.loading = false;
        render();
        return true;
      } catch (error) {
        state.error = error;
        state.loading = false;
        render();
        return false;
      }
    })();
    try { return await loadPromise; }
    finally { loadPromise = null; }
  }

  async function enrichJob(job) {
    const artifacts = await Promise.allSettled(array(job.artifacts).map(row => api(`/api/content-ops/artifacts/${encodeURIComponent(row.id)}`)));
    return { ...job, budgetAuthorization: job.budgetAuthorization || rows("budgetAuthorizations").find(row => row.id === job.budgetAuthorizationId) || null,
      artifacts: array(job.artifacts).map((row, index) => artifacts[index].status === "fulfilled" ? artifacts[index].value : { ...row, previewError: contentOpsError(artifacts[index].reason) }) };
  }

  async function loadJob(id) {
    const sequence = ++detailSequence;
    state.selectedJobId = id;
    state.job = null;
    state.candidate = null;
    state.candidateError = null;
    state.jobError = null;
    render();
    if (!id) return;
    try {
      const job = await enrichJob(await api(`/api/content-ops/jobs/${encodeURIComponent(id)}`));
      if (sequence !== detailSequence) return;
      state.job = job;
    } catch (error) { if (sequence === detailSequence) state.jobError = error; }
    if (sequence === detailSequence) render();
  }

  async function loadCandidate(id) {
    const button = root.querySelector(`[data-co-candidate="${CSS.escape(id)}"]`);
    if (button) { button.disabled = true; button.textContent = "正在读取准确成品…"; }
    state.candidateError = null;
    const sequence = detailSequence;
    try {
      const candidate = await api(`/api/content-ops/candidates/${encodeURIComponent(id)}`);
      const pack = candidate.package || candidate.publicationPackage || candidate;
      const references = array(pack.artifactRefs);
      const results = await Promise.allSettled(references.map(ref => api(`/api/content-ops/artifacts/${encodeURIComponent(ref.id || ref.artifactId)}`)));
      if (sequence !== detailSequence) return;
      if (!state.job) throw new Error("当前工单已经切换，请重新读取成品。");
      const artifacts = new Map(allArtifacts().map(row => [row.id, row]));
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        if (result.status === "fulfilled") artifacts.set(result.value.id, result.value);
        else artifacts.set(references[index].id || references[index].artifactId, { ...references[index], id: references[index].id || references[index].artifactId, previewError: contentOpsError(result.reason) });
      }
      state.job.artifacts = [...artifacts.values()];
      state.candidate = candidate;
    } catch (error) { if (sequence === detailSequence) state.candidateError = error; }
    if (sequence === detailSequence) { render(); root.querySelector(".co-candidate")?.scrollIntoView({ behavior: "smooth", block: "start" }); }
  }

  async function perform(element, fields) {
    const action = element.dataset.coForm;
    const id = element.dataset.id;
    const etag = element.dataset.etag;
    if (action === "plan-template") {
      const selected = fields.getAll("destinationId");
      const motherEditionIds = fields.getAll("motherEditionId");
      if (!motherEditionIds.length) throw new Error("请至少选择一份准确不可变母版。");
      if (!selected.length || selected.length > 28) throw new Error("本次需选择 1—28 个相关目标。");
      const sourceArtifactIds = fields.getAll("sourceArtifactId");
      const nativeInputs = selected.filter(destinationId => fields.get(`nativeForm-${destinationId}`) === "repository_change" && fields.get(`baseCommit-${destinationId}`)).map(destinationId => ({ destinationId, baseCommit: fields.get(`baseCommit-${destinationId}`), operation: fields.get(`repositoryOperation-${destinationId}`), tag: fields.get(`repositoryTag-${destinationId}`) || null }));
      const response = await send("/api/content-ops/plan-template", { storyId: fields.get("storyId"), motherEditionIds, targets: selected.map(destinationId => ({ destinationId, locale: fields.get(`locale-${destinationId}`), nativeForm: fields.get(`nativeForm-${destinationId}`) })), goal: fields.get("goal"), budgetAuthorizationId: fields.get("budgetAuthorizationId") || null, sourceArtifactIds, nativeInputs });
      state.planText = JSON.stringify(response.plan || response, null, 2);
      state.templateGaps = array(response.gaps);
      if (array(response.plan?.targets).length !== selected.length) state.templateGaps.push({ code: "TARGET_TEMPLATE_INCOMPLETE", explanation: `已选择 ${selected.length} 个目标，但服务只返回 ${array(response.plan?.targets).length} 个。请补齐所有目标或明确重新选择，不能把遗漏当作成功。` });
      state.validation = null;
      for (const previous of root.querySelectorAll('[data-co-form="validate-plan"]')) completedForms.add(previous);
      drafts.delete("validate-plan:new");
      state.notice = "计划数据已生成。请阅读完整 JSON、真实输入缺口与创作范围，再单独校验。尚未启动准备。";
      return response;
    }
    if (action === "validate-plan") {
      const raw = String(fields.get("planJson") || "");
      state.validation = null;
      const previousCreate = root.querySelector('[data-co-form="create-job"]');
      if (previousCreate) for (const control of previousCreate.elements) control.disabled = true;
      state.planText = raw;
      if (new TextEncoder().encode(raw).length > 1_000_000) throw new Error("计划超过 1,000,000 bytes，不能截断后继续。");
      let parsed;
      try { parsed = JSON.parse(raw); } catch { throw new Error("计划不是有效 JSON。原输入已保留，请修正后重新校验。"); }
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("计划必须是 JSON 对象。");
      state.validation = await send("/api/content-ops/plan-imports/validate", `{"plan":${raw}}`, { raw: true });
      state.notice = "服务器校验快照已保存。请核对每个目标、有效规则与缺口，再决定创建准确工单。";
      return state.validation;
    }
    if (action === "create-job") {
      if (fields.get("confirmed") !== "on" || !state.validation) throw new Error("请实际核对当前校验快照后确认创建。");
      const validated = state.validation;
      const plan = validated.normalizedPlan || validated.plan || {};
      const result = await send("/api/content-ops/jobs", { validatedImportId: validated.validatedImportId || validated.id, planHash: validated.planHash, budgetAuthorizationHash: validated.budgetAuthorizationHash ?? plan.budgetAuthorizationRef?.sha256 ?? null, mode: "prepare" }, { etag, needsEtag: true });
      state.selectedJobId = result.jobId || result.id;
      state.tab = "jobs";
      state.validation = null;
      state.notice = result.status === "blocked_budget" ? "预算待配置工单已保存，未派发付费步骤。补预算需新计划修订并重新校验。" : "准备工单已建立；请核对逐目标步骤、双端工位权限与实际产物。";
      return result;
    }
    if (action === "budget-create") {
      if (fields.get("confirmed") !== "on") throw new Error("请核对真实预算范围后确认授权。");
      const input = {};
      for (const name of ["maxCostMicros", "maxCalls", "maxInputTokens", "maxOutputTokens", "maxPerCallInputTokens", "maxPerCallOutputTokens", "maxInFlight", "maxRenderSeconds", "maxTempBytes", "maxNativeProcesses"]) {
        const value = Number(fields.get(name));
        if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} 必须是非负安全整数。`);
        input[name] = value;
      }
      let pricingSnapshot;
      try { const rawPricing = String(fields.get("pricingSnapshot") || "").trim(); pricingSnapshot = rawPricing ? JSON.parse(rawPricing) : null; } catch { throw new Error("价格快照不是有效 JSON；请核对原始已核实配置。"); }
      const deadline = new Date(`${fields.get("deadlineAt")}:00+08:00`);
      if (!Number.isFinite(deadline.getTime()) || deadline.getTime() <= Date.now()) throw new Error("截止时间须是未来的准确北京时间。");
      const result = await send("/api/content-ops/budget-authorizations", { ...input, name: fields.get("name"), currency: fields.get("currency"), deadlineAt: deadline.toISOString(), pricingSnapshot });
      state.notice = "预算授权已保存。请将准确授权用于新计划修订并重新校验；旧工单与未知预留保留。";
      return result;
    }
    if (action === "source-upload") {
      const story = rows("stories").find(row => row.id === fields.get("storyId"));
      if (!story?.etag) throw new Error("选题缺少准确版本，请先刷新并重新核对。");
      const selected = element.elements.sourceFile?.files?.[0];
      const file = selected?.size ? selected : state.sourceFile;
      if (!file?.size) throw new Error("请选择真实源文件，空文件不能登记。");
      if (file.size > state.sourceCapabilities.maxArtifactBytes) throw new Error("源文件超过当前实际单文件上限；不会截断或静默压缩。");
      const role = String(fields.get("role")), mime = String(fields.get("mime"));
      if (!state.sourceCapabilities.roles?.[role]?.includes(mime)) throw new Error("文件用途与 MIME 不在当前服务支持的真实类型合同中。");
      if (!globalThis.crypto?.subtle) throw new Error("当前页面无法核对真实字节摘要，请使用 HTTPS 管理后台。");
      const bytes = await file.arrayBuffer();
      const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
      const result = await send("/api/content-ops/source-artifacts", file, { bytes: true, etag: story.etag, needsEtag: true, headers: { "Content-Type": mime, "X-Story-Id": story.id, "X-Artifact-Role": role, "X-Artifact-Name": encodeURIComponent(file.name), "X-Content-Size": String(file.size), "X-Content-SHA256": sha256 } });
      state.sourceFile = null;
      state.notice = "真实源文件已提交为私有未审核附件。请读取完整实际内容，分别核对来源、使用权、许可和隐私后再绑定计划。";
      return result;
    }
    if (action === "rule-create") {
      if (fields.get("confirmed") !== "on") throw new Error("请实际核对规则来源与创作／外发边界后确认。");
      const destination = rows("destinations").find(row => row.id === fields.get("destinationId"));
      if (!destination) throw new Error("准确目的地不存在，请刷新后重新核对。");
      let sources;
      try { sources = JSON.parse(String(fields.get("sources") || "")); } catch { throw new Error("规则来源不是有效 JSON 数组，输入已保留。"); }
      const checkedAt = new Date(`${fields.get("checkedAt")}:00+08:00`), expiresAt = new Date(`${fields.get("expiresAt")}:00+08:00`);
      if (!Number.isFinite(checkedAt.getTime()) || !Number.isFinite(expiresAt.getTime()) || checkedAt.getTime() > Date.now() + 60_000 || expiresAt.getTime() <= Date.now()) throw new Error("请填写实际审阅时间与未来的有效期，不使用未来时间冒充已审阅。");
      const result = await send("/api/content-ops/rule-snapshots", { platformId: destination.platformId, destinationId: destination.id, policy: { creationMode: fields.get("creationMode"), deliveryMode: fields.get("deliveryMode"), allowedAiActions: fields.getAll("allowedAiActions"), requiresAuthorContribution: fields.get("requiresAuthorContribution") === "on", requiredConditions: String(fields.get("requiredConditions") || "").split("\n").map(value => value.trim()).filter(Boolean) }, sources, checkedAt: checkedAt.toISOString(), expiresAt: expiresAt.toISOString(), reviewed: true, note: fields.get("note") });
      state.notice = "当次目的地规则快照已保存。请重新生成或校验计划，平台岗位与本次授权仍会求允许动作的交集。";
      return result;
    }
    if (action === "author-contribution") {
      if (fields.get("confirmed") !== "on") throw new Error("请核对真实作者原文与允许使用范围。");
      const story = rows("stories").find(row => row.id === fields.get("storyId"));
      if (!story?.ref || !story.etag) throw new Error("选题缺少准确来源引用，请刷新后重新核对。");
      const result = await send("/api/content-ops/author-contributions", { storyRef: story.ref, title: fields.get("title"), body: fields.get("body"), locale: fields.get("locale"), sourceNote: fields.get("sourceNote"), authoredBy: fields.get("authoredBy") }, { etag: story.etag, needsEtag: true });
      state.notice = "真实作者贡献版本已保存。请重新生成或修订计划，核对其准确引用与允许的辅助范围。";
      return result;
    }
    if (action === "worker-pair") {
      if (fields.get("confirmed") !== "on") throw new Error("请实际核对限定工单、适配器与费用／文件范围。");
      const splitIds = name => String(fields.get(name) || "").split(/[,，\s]+/).map(value => value.trim()).filter(Boolean);
      const adapterIds = fields.getAll("adapterIds");
      if (!adapterIds.length) throw new Error("至少明确选择一个固定适配器；不允许无限范围。");
      const expires = new Date(`${fields.get("expiresAt")}:00+08:00`);
      if (!Number.isFinite(expires.getTime()) || expires.getTime() <= Date.now()) throw new Error("配对到期时间必须是未来的准确北京时间。");
      state.pairing = await send("/api/content-ops/workers/pair", { workerId: fields.get("workerId"), origin: fields.get("origin"), workspaceId: fields.get("workspaceId"), projectIds: splitIds("projectIds"), jobIds: splitIds("jobIds"), targetKeys: splitIds("targetKeys"), adapterIds, expiresAt: expires.toISOString(), maxTempBytes: Number(fields.get("maxTempBytes")), maxRenderSeconds: Number(fields.get("maxRenderSeconds")), maxNativeProcesses: Number(fields.get("maxNativeProcesses")), checker: fields.get("checker") === "on" });
      state.localSetup = null;
      state.localSetupError = null;
      state.notice = "一次性挑战已建立；本机 owner 仍需独立确认相同范围。没有复制管理员会话或本机供应商凭据。";
      return state.pairing;
    }
    if (action === "worker-revoke") {
      if (fields.get("confirmed") !== "on") throw new Error("请确认撤销准确工位的后续权限。");
      const result = await send(`/api/content-ops/workers/${encodeURIComponent(id)}/revoke`, { reason: fields.get("reason") }, { etag, needsEtag: true });
      state.notice = "工位后续权限已撤销。已派发尝试与未知预留保留，不能据此宣称未执行或未收费。";
      return result;
    }
    if (action === "cancel") {
      if (fields.get("confirmed") !== "on") throw new Error("请核对取消的真实边界后确认。");
      const result = await send(`/api/content-ops/jobs/${encodeURIComponent(id)}/cancel`, { reason: fields.get("reason") }, { etag, needsEtag: true });
      state.notice = "取消已记录，后续未派发步骤停止。已派发请求与未知预留继续保留，迟到结果只供审计。";
      return result;
    }
    if (action === "revise") {
      if (fields.get("confirmed") !== "on") throw new Error("请确认这一目标的返修范围。");
      const candidateId = String(fields.get("candidateId"));
      const parent = state.candidate?.id === candidateId ? state.candidate : array(state.job?.candidates).find(row => row.id === candidateId);
      if (!parent?.packageHash) throw new Error("尚未读取父候选的准确包，请先打开完整成品后再返修。");
      const result = await send(`/api/content-ops/jobs/${encodeURIComponent(id)}/targets/${encodeURIComponent(String(fields.get("targetKey")))}/revise`, { candidateId, packageHash: parent.packageHash, instructions: fields.get("instructions") }, { etag, needsEtag: true });
      state.candidate = null;
      state.notice = "新修订任务已建立。原成品保留，修改后需要重新冻结和独立终检。";
      return result;
    }
    if (action === "artifact-review") {
      if (["rightsConfirmed", "privacyConfirmed", "licenseConfirmed"].some(name => fields.get(name) !== "on")) throw new Error("请逐项实际核对文件使用权、全部隐私与许可。");
      const artifact = allArtifacts().find(row => row.id === id);
      if (!artifact?.sha256) throw new Error("未读取到准确文件摘要，不能进行使用审核。");
      const result = await send(`/api/content-ops/artifacts/${encodeURIComponent(id)}/review`, { sha256: artifact.sha256, rightsConfirmed: true, privacyConfirmed: true, licenseConfirmed: true, note: fields.get("note") }, { etag, needsEtag: true });
      state.notice = "准确附件的使用审核已保存。媒体审核、最终包终检与内容批准仍分别进行。";
      return result;
    }
    if (action === "artifact-import-media") {
      const artifact = allArtifacts().find(row => row.id === id);
      const result = await send(`/api/content-ops/artifacts/${encodeURIComponent(id)}/import-media`, buildArtifactMediaImport(artifact, fields), { etag, needsEtag: true });
      state.notice = `准确文件已关联私有待审核媒体 ${result.id}。请在媒体素材中独立核对使用范围；此导入没有批准正文或发布。`;
      if (afterMediaImport) {
        const [navigation] = await Promise.allSettled([afterMediaImport(result)]);
        if (navigation.status === "rejected") state.notice += " 媒体页面暂未读取，请刷新后按这个媒体 ID 核对，勿重复导入。";
      }
      return result;
    }
    if (action === "quality-review") {
      const candidate = state.candidate;
      if (!candidate || candidate.id !== id) throw new Error("准确候选已变化，请重新读取最终完整成品。");
      const input = buildHumanQualityReview(candidate, fields);
      const result = await send(`/api/content-ops/candidates/${encodeURIComponent(id)}/quality-reports`, input, { etag, needsEtag: true });
      state.candidate = await api(`/api/content-ops/candidates/${encodeURIComponent(id)}`);
      state.notice = result.status === "passed" ? "真实独立终检已保存，报告绑定这一准确最终包。仍需完整人工内容审核与另行外发授权。" : "实际独立检查记录已保存；未核实维度或未解决问题保持待输入，不会因提交报告自动通过。";
      return result;
    }
    if (action === "usage-reconcile") {
      const reservation = array(state.job?.reservations).find(row => row.id === id);
      if (!reservation || !state.job?.id) throw new Error("未读取到准确工单和未决用量，请刷新后重新核对。");
      let evidenceSha256 = "";
      const file = element.elements.evidenceFile?.files?.[0];
      if (file?.size) {
        if (!globalThis.crypto?.subtle || file.size > 50 * 1024 * 1024) throw new Error("证据摘要需要 HTTPS 与不超过 50 MiB 的本地实际文件；原文不会上传。");
        evidenceSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))].map(value => value.toString(16).padStart(2, "0")).join("");
        if (fields.get("evidenceSha256") && String(fields.get("evidenceSha256")) !== evidenceSha256) throw new Error("所选证据文件的实际摘要与手填摘要不同，请保留原证据并重新核对。");
      }
      const input = buildUsageReconciliation(reservation, fields, { evidenceSha256 });
      const result = await send(`/api/content-ops/jobs/${encodeURIComponent(state.job.id)}/usage/${encodeURIComponent(id)}/reconcile`, input, { etag, needsEtag: true });
      state.notice = "准确未决请求的实际用量审计已保存。结算只证明用量，不代表原生产结果成功；没有重新执行或自动重派任务。";
      return result;
    }
    if (action === "materialize") {
      if (fields.get("reviewed") !== "on") throw new Error("请实际核对完整成品、全部附件与报告后再转稿。");
      const candidate = state.candidate;
      if (!candidate || candidate.id !== id) throw new Error("准确候选已变化，请重新打开完整成品。");
      const reportHashes = reviewReportHashes(candidate);
      if (!reportHashes.length) throw new Error("候选没有返回准确 ReviewEnvelope 报告绑定，请重新读取成品。");
      const result = await send(`/api/content-ops/candidates/${encodeURIComponent(id)}/materialize`, { packageHash: candidate.packageHash, qualityReportHashes: reportHashes, reviewSnapshotHash: candidate.reviewSnapshotHash }, { etag, needsEtag: true });
      state.notice = `已转为编辑出版待核草稿 ${result.contentId || result.variantId || result.variant?.id || ""}。仍需内容核验、批准与排期，外发另行授权。`;
      state.candidate = null;
      if (afterMaterialize) {
        const [refresh] = await Promise.allSettled([afterMaterialize(result)]);
        if (refresh.status === "rejected") state.notice += " 编辑出版暂未刷新，请用页面刷新读取，勿重复创建。";
      }
      return result;
    }
    throw new Error("无法识别这项准备操作，请刷新服务后重试。");
  }

  async function submit(element) {
    const key = formKey(element);
    if (pending.has(key) || !element.reportValidity()) return;
    const fields = new FormData(element);
    captureDrafts();
    pending.add(key);
    const controls = [...element.elements].map(field => [field, field.disabled]);
    for (const [field] of controls) field.disabled = true;
    element.setAttribute("aria-busy", "true");
    const errorOutput = element.querySelector("[data-co-error]");
    errorOutput.hidden = true;
    element.querySelector("[data-co-status]").textContent = "正在保存这一次准确操作…";
    try {
      await perform(element, fields);
      completedForms.add(element);
      drafts.delete(key);
      pending.delete(key);
      if (["plan-template", "validate-plan"].includes(element.dataset.coForm)) render();
      else await load();
    } catch (error) {
      pending.delete(key);
      const current = [...root.querySelectorAll("form[data-co-form]")].find(row => formKey(row) === key) || element;
      const output = current.querySelector("[data-co-error]");
      output.hidden = false;
      output.textContent = contentOpsError(error);
      output.tabIndex = -1;
      output.focus();
      current.querySelector("[data-co-status]").textContent = "未确认完成。原输入已保留。";
      if (error.status === 412) {
        state.notice = "对象版本已变化。请刷新并重新阅读，审阅与授权声明不会沿用。";
      }
    } finally {
      pending.delete(key);
      element.removeAttribute("aria-busy");
      for (const [field, disabled] of controls) if (field.isConnected) field.disabled = disabled;
      for (const current of root.querySelectorAll("form[data-co-form]")) {
        if (formKey(current) !== key || !pendingControls.has(current)) continue;
        for (const [field, disabled] of pendingControls.get(current)) field.disabled = disabled;
        pendingControls.delete(current);
      }
    }
  }

  async function previewArtifact(button) {
    const article = button.closest(".co-artifact");
    const output = article.querySelector("[data-co-preview-output]");
    button.disabled = true;
    button.textContent = "正在读取真实静态内容…";
    try {
      const result = await api(`/api/content-ops/artifacts/${encodeURIComponent(button.dataset.coArtifactPreview)}/preview`);
      output.innerHTML = `<h5>服务端完整静态预览</h5><pre class="co-file-text">${html(typeof result.text === "string" ? result.text : JSON.stringify(result, null, 2))}</pre>${result.truncated ? '<p class="co-warning">服务标记此预览仍有截断，必须下载原文件补齐核对。</p>' : ""}`;
    } catch (error) { output.innerHTML = `<p class="co-error" role="alert">${html(contentOpsError(error))}</p>`; }
    finally { button.disabled = false; button.textContent = "重新读取完整静态预览"; }
  }

  async function previewCaption(button) {
    const output = button.parentElement.querySelector("[data-co-caption-output]");
    button.disabled = true;
    button.textContent = "正在读取真实字幕…";
    try {
      const response = await fetch(`/api/media/assets/${encodeURIComponent(button.dataset.coCaptionPreview)}/bytes`, { credentials: "same-origin", headers: { Accept: "text/vtt" } });
      if (!response.ok) throw Object.assign(new Error("字幕读取失败，请核对登录状态和实际文件。"), { status: response.status });
      const content = await response.text();
      if (new TextEncoder().encode(content).length > 1_048_576) throw new Error("字幕超过已支持的完整预览上限，未截断展示。请下载准确原文件核对。");
      output.innerHTML = `<pre>${html(content)}</pre>`;
    } catch (error) { output.innerHTML = `<p class="co-error" role="alert">${html(contentOpsError(error))}</p>`; }
    finally { button.disabled = false; button.textContent = "重新读取完整字幕"; }
  }

  async function prepareLocalTemplates(button) {
    if (!state.pairing?.scope) return;
    const pairing = state.pairing;
    button.disabled = true;
    button.textContent = "正在读取全部准确工单…";
    try {
      const jobs = await Promise.all(pairing.scope.jobIds.map(id => api(`/api/content-ops/jobs/${encodeURIComponent(id)}`)));
      if (state.pairing !== pairing) return;
      state.localSetup = buildWorkerLocalTemplates(pairing, { jobs, budgets: rows("budgetAuthorizations") });
      state.localSetupError = null;
    } catch (error) { if (state.pairing === pairing) { state.localSetup = null; state.localSetupError = error; } }
    finally { if (state.pairing === pairing) render(); }
  }

  function downloadLocalTemplate(kind) {
    if (!state.localSetup || !["grant", "config"].includes(kind)) return;
    let url;
    try {
      url = URL.createObjectURL(new Blob([JSON.stringify(state.localSetup[kind], null, 2) + "\n"], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = kind === "grant" ? "local-grant.json" : "worker.json";
      anchor.click();
      state.localSetupError = null;
    } catch (error) { state.localSetupError = error; render(); }
    finally { if (url) setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }

  root.addEventListener("submit", event => {
    const element = event.target.closest("form[data-co-form]");
    if (!element) return;
    event.preventDefault();
    void submit(element);
  });
  root.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.coTab) {
      state.tab = button.dataset.coTab;
      render();
      root.querySelector(`[data-co-tab="${state.tab}"]`)?.focus({ preventScroll: true });
    } else if (button.hasAttribute("data-co-refresh")) void load();
    else if (button.hasAttribute("data-co-close-pairing")) { state.pairing = null; state.localSetup = null; state.localSetupError = null; render(); }
    else if (button.hasAttribute("data-co-local-templates")) void prepareLocalTemplates(button);
    else if (button.dataset.coDownloadTemplate) downloadLocalTemplate(button.dataset.coDownloadTemplate);
    else if (button.dataset.coMediaReview && afterMediaImport) void Promise.resolve().then(() => afterMediaImport({ id: button.dataset.coMediaReview })).catch(error => { state.error = error; render(); });
    else if (button.dataset.coCandidate) void loadCandidate(button.dataset.coCandidate);
    else if (button.dataset.coArtifactPreview) void previewArtifact(button);
    else if (button.dataset.coCaptionPreview) void previewCaption(button);
    else if (button.hasAttribute("data-co-media-retry")) {
      const media = button.closest(".co-artifact").querySelector("[data-co-media]");
      const failure = button.closest(".co-media-failure");
      failure.hidden = true;
      if (media?.tagName === "IMG") { const src = media.src; media.removeAttribute("src"); media.src = src; }
      else media?.load();
    }
  });
  root.addEventListener("keydown", event => {
    if (!event.target.matches("[data-co-tab]") || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const keys = Object.keys(TABS), index = keys.indexOf(state.tab);
    state.tab = event.key === "Home" ? keys[0] : event.key === "End" ? keys.at(-1) : keys[(index + (event.key === "ArrowRight" ? 1 : -1) + keys.length) % keys.length];
    render();
    root.querySelector(`[data-co-tab="${state.tab}"]`)?.focus({ preventScroll: true });
  });
  root.addEventListener("change", event => {
    const field = event.target;
    if (field.hasAttribute("data-co-story")) updateMotherChoices();
    else if (field.hasAttribute("data-co-source-role")) updateSourceMime();
    else if (field.hasAttribute("data-co-source-file")) { state.sourceFile = field.files?.[0] || null; updateSourceMime(); }
    else if (field.name?.startsWith("nativeForm-")) updateNativeInputs();
    else if (field.hasAttribute("data-co-job-select")) void loadJob(field.value);
    else if (field.hasAttribute("data-co-plan-file")) {
      const file = field.files?.[0];
      if (!file) return;
      if (file.size > 1_000_000) { state.notice = "计划超过 1,000,000 bytes；未读取、未截断、未发送。"; render(); return; }
      void file.text().then(value => {
        state.planText = value;
        state.validation = null;
        for (const previous of root.querySelectorAll('[data-co-form="validate-plan"]')) completedForms.add(previous);
        drafts.delete("validate-plan:new");
        render();
      }).catch(error => { state.error = error; render(); });
    }
  });
  root.addEventListener("input", event => {
    const field = event.target;
    if (field.hasAttribute("data-co-plan-json")) {
      state.planText = field.value;
      state.validation = null;
      const creation = root.querySelector('[data-co-form="create-job"]');
      if (creation) {
        for (const control of creation.elements) control.disabled = true;
        creation.querySelector("[data-co-status]").textContent = "计划已经修改，旧校验快照不再用于创建。请重新校验。";
      }
    }
    else if (field.hasAttribute("data-co-search")) {
      const caret = field.selectionStart;
      state.query = field.value;
      render();
      const current = root.querySelector("[data-co-search]");
      current?.focus({ preventScroll: true });
      if (caret !== null) current?.setSelectionRange(caret, caret);
    }
  });
  root.addEventListener("error", event => {
    if (!event.target.matches?.("[data-co-media], [data-co-media] source")) return;
    const article = event.target.closest(".co-artifact");
    const failure = article?.querySelector(".co-media-failure");
    if (failure) failure.hidden = false;
  }, true);
  render();
  return { load, render, getData: () => state.data };
}

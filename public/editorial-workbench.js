import { escapeHtml as html, safePublicUrl, documentBlocksFromText, renderDocumentBlocks } from "./publication-view.js";
import { EDITORIAL_NATIVE_SCHEMA, renderNativePackageReview, nativeReviewConfirmationFields, assertNativeReviewConfirmations, loadNativePackageReview, bindNativePackagePreviews } from "./content-ops.js";

const STATUS = { draft: "草稿", active: "已启用", paused: "已暂停", archived: "已归档", unverified: "待核对", verified: "身份已核对", fact_check: "事实核验中", approved: "此版本已批准", scheduled: "已排期", candidate: "私有候选", live_unverified: "已激活 · 待回读", published: "回读已核验", withdrawn: "已撤稿", staged: "私有待审核", reviewed: "素材已审核", revoked: "已撤销使用" };
const FORMATS = { article: "文章", image_text: "图文", video: "视频" };
const CONTENT_FORM_LABELS = { ...FORMATS, answer: "回答", channel_message: "频道消息", code_example: "代码示例", comment: "评论", community_post: "社区帖子", dataset_card_if_dataset_exists: "数据集说明（有真实数据集时）", dataset_if_exists: "数据集（真实存在时）", demo: "演示", demo_link: "演示链接", discussion: "讨论", document_carousel: "文档图卡", forum_post: "论坛帖子", image_carousel: "多图", link_or_media_if_allowed: "链接或媒体（规则允许时）", media_embed: "媒体展示", model_card_if_model_exists: "模型说明（有真实模型时）", model_if_exists: "模型（真实存在时）", notebook_if_exists: "实验笔记（真实存在时）", online_demo: "在线演示", photo: "照片", photo_post: "图片帖子", professional_post: "专业观点", readme: "项目说明", reel: "竖版短片", release: "版本发布说明", repository: "代码仓库", short_post: "短帖", short_video: "短视频", social_post: "社交帖子", space_demo: "Space 演示", technical_article: "技术文章", technical_blog_optional: "技术博客（可选）", thread: "串文", thread_reply: "讨论回复", video_reel: "视频短片", video_with_transcript: "视频与完整文稿" };
const PLATFORM_KIND_LABELS = { owned_site: "自有官网", social: "社交内容", technical_artifact: "技术作品", community: "主题社区" };
const LOCALES = { "zh-CN": "中文", "en-US": "English" };
const DESTINATION_KINDS = { owned_origin: "官网域名", profile_feed: "个人账号内容流", page: "公共页面", repository: "代码仓库", community: "主题社区", community_channel: "社区频道", artifact_repository: "AI 作品仓库" };
const ROLE_LABELS = { cover: "封面", image: "图集图片", video: "视频", poster: "视频封面", subtitle: "字幕 VTT" };
const TABS = { stories: "选题与版本", releases: "官网出版", media: "媒体素材", accounts: "真实账号", destinations: "发布目的地", catalog: "平台目录" };

function timestamp(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "未记录";
}
function byteSize(size) {
  if (!Number.isFinite(Number(size))) return "大小未记录";
  return Number(size) >= 1_048_576 ? `${(Number(size) / 1_048_576).toFixed(1)} MiB` : `${Math.ceil(Number(size) / 1024)} KiB`;
}
function externalLink(value, label) {
  const url = safePublicUrl(value);
  return url ? `<a class="text-link" href="${html(url)}" target="_blank" rel="noopener noreferrer">${html(label || value)} ↗</a>` : "";
}
function options(values, selected) {
  return Object.entries(values).map(([value, label]) => `<option value="${html(value)}"${value === selected ? " selected" : ""}>${html(label)}</option>`).join("");
}
function feedback() { return '<p class="form-error" data-editorial-error role="alert" hidden></p><p class="form-status" data-editorial-status role="status" aria-live="polite"></p>'; }
function formStart(action, row = {}, fingerprint = "") {
  return `<form class="editorial-form" data-editorial-form="${html(action)}" data-entity-id="${html(row.id || "new")}" data-fingerprint="${html(fingerprint || row.id || action)}" data-etag="${html(row.etag || "")}">`;
}
function reviewCheck(label, name = "reviewed") {
  return `<label class="check-label"><input type="checkbox" name="${name}" required /><span>${html(label)}</span></label>`;
}
function statusLabel(value) { return STATUS[value] || value || "状态未记录"; }
function snapshotHash(row) { return row.snapshotHashV2 || row.snapshotHash || row.publicSnapshot?.snapshotHash || ""; }
function snapshot(row) { return row.publicSnapshot || row.contentSnapshot || row; }
function hashLine(hash) { return `<p class="editorial-hash">精确版本 SHA-256 <code>${html(hash || "当前对象未返回校验值")}</code></p>`; }
function empty(title, copy = "") { return `<div class="editorial-empty"><strong>${html(title)}</strong>${copy ? `<p>${html(copy)}</p>` : ""}</div>`; }
function exactDocument(row, assets) {
  const document = snapshot(row);
  const references = document.assetRefs || row.assetRefs || [];
  const resolved = references.map(ref => ({ ...assets.find(asset => asset.id === ref.assetId), ...ref, assetId: ref.assetId, url: `/api/media/assets/${encodeURIComponent(ref.assetId)}/bytes` }));
  const blocks = Array.isArray(document.blocks) ? document.blocks : documentBlocksFromText(document.body || "");
  return `<details class="editorial-exact"><summary>核对完整标题、正文、结构与素材</summary><div class="editorial-exact-content"><h4>${html(document.title || row.title)}</h4>${document.summary ? `<p class="editorial-summary">${html(document.summary)}</p>` : ""}<h5>完整原文</h5><pre class="editorial-body-source">${html(document.body || "")}</pre><h5>正文阅读结构</h5><div class="editorial-reading-preview">${renderDocumentBlocks(blocks.filter(block => !["image", "video"].includes(block.type)), { assets: resolved, lang: document.locale === "en-US" ? "en" : "zh", idPrefix: `review-${row.id}` })}</div><details class="editorial-structure"><summary>精确结构数据（包含图片与视频的位置）</summary><pre>${html(JSON.stringify(blocks, null, 2))}</pre></details>${references.length ? `<h5>素材顺序与文字</h5><ol class="editorial-reference-list">${references.map(ref => `<li><strong>${html(ROLE_LABELS[ref.role] || ref.role)} · ${html(ref.assetId)}</strong><p>替代文字：${html(ref.alt || "未提供")}<br />图注 / 字幕说明：${html(ref.caption || "未提供")}</p><code>${html(ref.sha256)}</code>${externalLink(`/api/media/assets/${encodeURIComponent(ref.assetId)}/bytes`, "查看此素材字节")}</li>`).join("")}</ol>` : ""}${hashLine(snapshotHash(row))}</div></details>`;
}
function claimFields(claims, selected = []) {
  return `<fieldset class="editorial-choice-list"><legend>事实依据 Claim</legend>${claims.length ? claims.map(claim => `<label class="check-label"><input type="checkbox" name="claimIds" value="${html(claim.id)}"${selected.includes(claim.id) ? " checked" : ""} /><span><strong>${html(claim.id)}</strong> · ${html(claim.text)} <small>${claim.state === "approved" ? claim.publicLevel === "approved_public" ? "已批准公开；仍检查来源与有效期" : "已批准，仅后台" : "待审批"}</small></span></label>`).join("") : '<p class="operation-field-hint">尚无事实条目。存在事实陈述时，先在内容工厂维护并核对依据。</p>'}</fieldset>`;
}
function assetFields(assets, references = []) {
  const usable = assets.filter(asset => asset.status === "reviewed");
  return `<details class="editorial-assets-picker"><summary>选择此版本的素材、顺序与说明（${references.length} 项已绑定）</summary><p class="operation-note">仅列已审核素材。数字顺序决定图集与附件顺序；图片替代文字、图注和字幕语言随此版本单独审批。</p>${usable.length ? usable.map((asset, index) => {
    const ref = references.find(item => item.assetId === asset.id);
    const role = ref?.role || (asset.kind === "video" ? "video" : asset.kind === "caption" ? "subtitle" : "image");
    return `<div class="editorial-asset-choice"><label class="check-label"><input type="checkbox" name="assetId" value="${html(asset.id)}"${ref ? " checked" : ""} /><span><strong>${html(asset.name || asset.id)}</strong><small>${html(asset.mime)} · ${byteSize(asset.size)} · ${html(asset.id)}</small></span></label><div class="editorial-grid four"><label><span>顺序</span><input type="number" name="assetOrder-${html(asset.id)}" min="1" max="1000" value="${ref ? references.indexOf(ref) + 1 : index + 1}" /></label><label><span>用途</span><select name="assetRole-${html(asset.id)}">${options(asset.kind === "video" ? { video: ROLE_LABELS.video } : asset.kind === "caption" ? { subtitle: ROLE_LABELS.subtitle } : { image: ROLE_LABELS.image, cover: ROLE_LABELS.cover, poster: ROLE_LABELS.poster }, role)}</select></label><label><span>替代文字</span><input name="assetAlt-${html(asset.id)}" maxlength="1000" value="${html(ref?.alt || "")}" /></label><label><span>图注 / 字幕说明</span><input name="assetCaption-${html(asset.id)}" maxlength="2000" value="${html(ref?.caption || "")}" /></label>${asset.kind === "caption" ? `<label><span>字幕实际语言</span><select name="assetLocale-${html(asset.id)}">${options(LOCALES, ref?.locale || "zh-CN")}</select></label>` : ""}</div></div>`;
  }).join("") : '<p class="operation-field-hint">还没有已审核素材。请先在“媒体素材”上传并独立核对版权和隐私。</p>'}</details>`;
}
function structuredField(blocks = null) {
  return `<details class="editorial-structured"><summary>精确结构化内容（可选）</summary><label><span>blocks JSON；留空按正文的标题、段落和列表生成</span><textarea name="blocksJson" rows="7" spellcheck="false" placeholder="仅支持 paragraph、heading、list、quote、code、image、video，不接受 HTML。">${blocks ? html(JSON.stringify(blocks, null, 2)) : ""}</textarea></label><p class="operation-field-hint">${blocks ? "当前继承来源版本的精确结构。修改正文时也请核对结构文字，或清空此处按新正文重新生成。" : "填写后这里的结构将用于真实页面。"}审批前请同时核对完整原文与页面预览。</p></details>`;
}

function locatorFields(kind = "profile_feed", locator = {}) {
  return `<div class="editorial-grid wide" data-locator-group="url"${["owned_origin", "community_channel"].includes(kind) ? " hidden" : ""}><label class="wide"><span>真实目的地 URL</span><input name="locatorUrl" type="url" maxlength="2000" value="${html(locator.url || "")}" /></label></div><div class="wide" data-locator-group="owned_origin"${kind === "owned_origin" ? "" : " hidden"}><label><span>官网 HTTPS origin（必须与本站部署配置一致，不带路径）</span><input name="origin" type="url" maxlength="2000" value="${html(locator.origin || "")}" /></label></div><div class="editorial-grid wide" data-locator-group="community_channel"${kind === "community_channel" ? "" : " hidden"}><label><span>Discord 服务器 ID</span><input name="serverId" inputmode="numeric" pattern="[0-9]{5,30}" value="${html(locator.serverId || "")}" /></label><label><span>频道 ID</span><input name="channelId" inputmode="numeric" pattern="[0-9]{5,30}" value="${html(locator.channelId || "")}" /></label><label class="wide"><span>主题 ID（可选）</span><input name="threadId" inputmode="numeric" pattern="[0-9]{5,30}" value="${html(locator.threadId || "")}" /></label></div><div class="wide" data-locator-group="artifact_repository"${kind === "artifact_repository" ? "" : " hidden"}><label><span>真实作品类型</span><input name="artifactKind" maxlength="80" value="${html(locator.artifactKind || "")}" placeholder="例如 Space、model、dataset、notebook；按实际作品填写" /></label></div>`;
}

export function destinationLocatorFromFields(kind, fields) {
  const get = key => typeof fields.get === "function" ? fields.get(key) : fields[key];
  if (kind === "owned_origin") return { origin: get("origin") };
  if (kind === "community_channel") return { serverId: get("serverId"), channelId: get("channelId"), ...(get("threadId") ? { threadId: get("threadId") } : {}) };
  return { url: get("locatorUrl"), ...(kind === "artifact_repository" ? { artifactKind: get("artifactKind") } : {}) };
}

export function destinationKindsForPlatform(platform = {}) {
  if (platform.kind === "owned_site") return ["owned_origin"];
  if (platform.id === "discord") return ["community_channel"];
  if (platform.id === "reddit") return ["community"];
  if (platform.kind === "technical_artifact") return ["repository", "artifact_repository"];
  return ["profile_feed", "page", "community"];
}

export function editionReferenceChoices(editions, { storyId, locale, format }) {
  const matching = editions.filter(item => item.storyId === storyId && item.format === format);
  const byRevision = (a, b) => Number(b.editorialRevision || 1) - Number(a.editorialRevision || 1);
  return {
    sources: matching.filter(item => item.locale !== locale).sort(byRevision),
    previous: matching.filter(item => item.locale === locale).sort(byRevision)[0] || null,
  };
}

export function variantRevisionChoices(variants, edition, destinationId) {
  return variants.filter(item => item.storyId === edition.storyId && item.locale === edition.locale && item.format === edition.format && item.destinationId === destinationId);
}

function destinationLocatorSummary(destination) {
  const locator = destination.locator || {};
  if (destination.kind === "community_channel") return `<p class="operation-note">服务器 ${html(locator.serverId)} · 频道 ${html(locator.channelId)}${locator.threadId ? ` · 主题 ${html(locator.threadId)}` : ""}</p>`;
  return externalLink(typeof locator === "string" ? locator : locator.origin || locator.url, "打开真实位置");
}

export function buildEditorialVariantTransition(variant, fields, { nativeReviewReady = false } = {}) {
  const value = key => typeof fields.get === "function" ? fields.get(key) : fields[key];
  const target = String(value("target") || "");
  const input = { target, note: value("note") || "" };
  if (target === "approved") {
    if (value("reviewed") !== "on") throw new Error("只有实际核对完整版本后才能勾选审阅声明。");
    input.reviewed = true;
    input.snapshotHash = snapshotHash(variant || {});
    if (variant?.snapshotSchema === EDITORIAL_NATIVE_SCHEMA) {
      if (!nativeReviewReady || !variant.reviewSnapshotHash) throw new Error("请先读取并核对准确原生包、真实附件与独立终检，不能只批准正文。");
      assertNativeReviewConfirmations(variant, fields);
      input.reviewSnapshotHash = variant.reviewSnapshotHash;
    }
  }
  return input;
}

export function mountEditorialWorkbench({ api, getData, showError, afterMutation, onCatalogChange } = {}) {
  const root = document.querySelector("#editorial-root");
  if (!root) return { async load() {}, render() {}, getCatalog: () => null };
  const state = { tab: "stories", data: null, assets: [], loading: false, error: null, mediaError: null, notice: "", selectedStoryId: "", showArchived: false, catalogQuery: "", file: null };
  const nativeReviews = new Map();
  const nativeErrors = new Map();
  const nativeLoading = new Set();
  const nativeKey = row => `${row.id}:${snapshotHash(row)}:${row.reviewSnapshotHash || ""}`;
  const drafts = new Map();
  const attempts = new Map();
  const activeForms = new Set();
  const completedForms = new WeakSet();
  const completedKeys = new Set();
  const pendingControls = new WeakMap();
  const catalog = () => Array.isArray(state.data?.catalog) ? state.data.catalog : state.data?.catalog?.platforms || [];
  const rows = key => Array.isArray(state.data?.[key]) ? state.data[key] : [];
  const platformName = id => { const platform = catalog().find(item => item.id === id); return platform?.nameZh || platform?.name || id; };
  const claims = () => rows("claims").length ? rows("claims") : getData()?.claims || [];
  const formKey = form => [form.dataset.editorialForm, form.dataset.entityId, form.dataset.fingerprint].join(":");

  function captureDrafts() {
    for (const form of root.querySelectorAll("form[data-editorial-form]")) {
      if (completedForms.has(form) || completedKeys.has(formKey(form))) continue;
      const values = [...form.elements].filter(field => field.name && field.type !== "file" && field.type !== "hidden").map(field => ({ name: field.name, type: field.type, value: field.value, checked: field.checked }));
      drafts.set(formKey(form), values);
    }
  }
  function restoreDrafts() {
    for (const form of root.querySelectorAll("form[data-editorial-form]")) {
      const previous = drafts.get(formKey(form));
      if (!previous) continue;
      for (const field of form.elements) {
        if (!field.name || field.type === "file" || field.type === "hidden") continue;
        const value = previous.find(item => item.name === field.name && (field.type !== "checkbox" || item.value === field.value));
        if (!value) continue;
        if (field.type === "checkbox") field.checked = ["reviewed", "confirm", "identityConfirmed", "policyReviewed", "rightsConfirmed", "privacyConfirmed", "nativePackageConfirmed"].includes(field.name) || field.name.startsWith("nativeArtifactConfirmed-") ? false : value.checked;
        else if (field.tagName !== "SELECT" || [...field.options].some(option => option.value === value.value)) field.value = value.value;
      }
    }
  }

  function storyPanel() {
    const stories = rows("stories");
    if (!state.selectedStoryId || !stories.some(item => item.id === state.selectedStoryId)) state.selectedStoryId = stories[0]?.id || "";
    const story = stories.find(item => item.id === state.selectedStoryId);
    const editions = rows("editions").filter(item => item.storyId === story?.id);
    const variants = rows("variants").filter(item => item.storyId === story?.id || editions.some(edition => edition.id === item.editionId));
    const create = `<details class="editorial-disclosure"${stories.length ? "" : " open"}><summary>建立一个真实选题</summary>${formStart("story-create")}<label><span>选题工作标题</span><input name="workingTitle" required maxlength="240" placeholder="写清这次要解释的问题" /></label><label><span>主题标识（可选，逗号分隔）</span><input name="topicIds" maxlength="500" placeholder="例如 agent-products, business-operations" /></label>${claimFields(claims())}${feedback()}<button class="primary-button" type="submit">保存选题</button></form></details>`;
    if (!story) return `${create}${empty("还没有选题", "选题只组织工作，不代表正文获准公开。请从一个有真实依据的问题开始。")}`;
    return `${create}<div class="editorial-story-selector"><label><span>当前选题</span><select id="editorial-story-select">${stories.map(item => `<option value="${html(item.id)}"${item.id === story.id ? " selected" : ""}>${html(item.workingTitle)} · ${html(item.id)}</option>`).join("")}</select></label><span>${editions.length} 个语言 / 格式版本 · ${variants.length} 个渠道草稿</span></div>
      <article class="editorial-section"><div class="panel-heading"><h3>${html(story.workingTitle)}</h3><span>${html(story.id)} · ${html(statusLabel(story.status))}</span></div><p class="operation-note">先保存完整语言版本，再按真实目的地建立独立渠道草稿。新修订不会覆盖旧版，也不会继承旧版审批。</p>
      ${formStart("story-update", story)}<div class="editorial-grid"><label><span>选题工作标题</span><input name="workingTitle" required maxlength="240" value="${html(story.workingTitle)}" /></label><label><span>选题状态</span><select name="status">${options({ draft: "准备中", active: "进行中", archived: "归档并保留版本" }, story.status)}</select></label><label class="wide"><span>归档原因（归档时必填）</span><textarea name="reason" maxlength="2000" rows="2"></textarea></label></div><p class="operation-field-hint">选题改名不修改既有正文。归档会停止新增版本，既有公开稿需在官网出版单独撤回。</p>${feedback()}<button class="ghost-button" type="submit">保存选题资料</button></form><details class="editorial-disclosure"><summary>新增中文 / 英文版本或修订</summary>${formStart("edition-create", story)}<div class="editorial-grid"><label><span>语言</span><select name="locale">${options(LOCALES, "zh-CN")}</select></label><label><span>形式</span><select name="format">${options(FORMATS, "article")}</select></label><label class="wide"><span>完整标题</span><input name="title" required maxlength="240" /></label><label class="wide"><span>导语 / 摘要</span><textarea name="summary" rows="3" maxlength="2000"></textarea></label><label class="wide"><span>完整正文 / 视频文稿</span><textarea name="body" required rows="14" maxlength="50000" placeholder="写入完整正文。可用 ## / ### 标题、列表和代码围栏组织阅读；原文会精确保留。"></textarea></label><label><span>译文来源（可选）</span><select name="sourceEditionId"><option value="">独立撰写，不关联译文来源</option></select></label><label><span>替代的旧版本（修订时选择）</span><select name="supersedesEditionId"><option value="">新版本系列</option></select></label></div>${claimFields(claims(), story.claimIds || [])}${assetFields(state.assets)}${structuredField()}${feedback()}<button class="primary-button" type="submit"${story.status === "archived" ? " disabled" : ""}>保存不可变版本</button></form></details></article>
      <div class="editorial-stack">${editions.length ? [...editions].reverse().map(edition => editionCard(edition)).join("") : empty("当前选题还没有语言版本", "保存第一份完整正文后，才能准备渠道草稿。")}</div>
      <div class="editorial-subheading"><h3>独立渠道版本与审批</h3><span>正文、素材、语言和目的地分别绑定</span></div><div class="editorial-stack">${variants.length ? [...variants].reverse().map(variant => variantCard(variant)).join("") : empty("还没有渠道版本", "在上方语言版本中选择“为一个真实目的地准备草稿”。")}</div>`;
  }

  function editionCard(edition) {
    if (edition.snapshotSchema === "pengmanager.editorial-edition/v3") return `<article class="editorial-card"><header class="editorial-card-heading"><div><p class="eyebrow">${html(LOCALES[edition.locale])} · ${html(FORMATS[edition.format])} · 中立派生修订</p><h3>${html(edition.title)}</h3><p>${html(edition.id)}</p></div><span class="status-chip">不可变中立稿</span></header>${exactDocument(edition, state.assets)}<details class="editorial-disclosure"><summary>准确跨形式 / 跨语言谱系</summary><pre class="co-json">${html(JSON.stringify(edition.formatLineage, null, 2))}</pre></details><p class="operation-note">此中立稿来自受控转换。新的平台成品继续从内容运营师建立候选、独立终检与完整人审，保留全部原生字段与附件绑定。</p><a class="text-link" href="#content-ops">进入内容运营师 →</a></article>`;
    const destinations = rows("destinations").filter(item => item.status !== "archived");
    return `<article class="editorial-card"><header class="editorial-card-heading"><div><p class="eyebrow">${html(LOCALES[edition.locale])} · ${html(FORMATS[edition.format])} · 修订 ${html(edition.editorialRevision || edition.revision || 1)}</p><h3>${html(edition.title)}</h3><p>${html(edition.id)}${edition.sourceEditionId ? ` · 译文来源 ${html(edition.sourceEditionId)}` : ""}${edition.supersedesEditionId ? ` · 替代 ${html(edition.supersedesEditionId)}` : ""}</p></div><span class="status-chip">不可变正文</span></header>${edition.translationStatus === "needs_review" ? '<p class="operation-note" role="note">译文来源已有较新修订。本版本保持原审阅内容；请核对最新来源后建立新修订，旧审批不会自动迁移。</p>' : ""}${exactDocument(edition, state.assets)}<details class="editorial-disclosure"><summary>为一个真实目的地准备草稿</summary>${formStart("variant-create", edition)}<label><span>发布目的地</span><select name="destinationId" required><option value="">选择实际目的地</option>${destinations.map(destination => `<option value="${html(destination.id)}">${html(destination.name || platformName(destination.platformId))} · ${html(statusLabel(destination.status))} · ${destination.identityReview?.status === "verified" ? "身份已核对" : "身份待核对"}</option>`).join("")}</select></label><p class="operation-field-hint">创建草稿不会启用账号或触发外发。待核对目的地必须完成身份与规则审核，才能批准此渠道版本。</p><label><span>该渠道完整标题</span><input name="title" required maxlength="240" value="${html(edition.title)}" /></label><label><span>导语</span><textarea name="summary" maxlength="2000" rows="3">${html(edition.summary || "")}</textarea></label><label><span>该渠道完整正文</span><textarea name="body" required maxlength="50000" rows="11">${html(edition.body)}</textarea></label><label><span>这次替代的渠道稿（可选）</span><select name="supersedesContentId"><option value="">独立新草稿，不替代旧稿</option></select></label><label><span>渠道调整说明</span><textarea name="adaptationNote" maxlength="2000" rows="2" placeholder="记录为什么为该读者与发布场景调整表达。"></textarea></label>${assetFields(state.assets, edition.assetRefs || [])}${structuredField(edition.blocks)}${feedback()}<button class="primary-button" type="submit"${destinations.length ? "" : " disabled"}>保存独立渠道草稿</button>${!destinations.length ? '<p class="operation-field-hint">请先在“发布目的地”登记一个实际位置。</p>' : ""}</form></details></article>`;
  }

  function variantCard(variant) {
    const destination = rows("destinations").find(item => item.id === variant.destinationId);
    const native = variant.snapshotSchema === EDITORIAL_NATIVE_SCHEMA;
    const review = nativeReviews.get(nativeKey(variant));
    const next = { draft: ["fact_check", "提交事实核验"], fact_check: ["approved", "批准这个精确渠道版本"], approved: ["scheduled", "确认排期"], blocked: ["draft", "返回草稿"] }[variant.status];
    const transition = next ? `${formStart("variant-transition", variant, snapshotHash(variant))}<input type="hidden" name="target" value="${next[0]}" /><label><span>${next[0] === "approved" ? "本次审阅说明" : "处理说明"}</span><textarea name="note" maxlength="2000" rows="2"${next[0] === "approved" ? " required" : ""}></textarea></label>${next[0] === "approved" ? `${native ? nativeReviewConfirmationFields(variant) : ""}${reviewCheck("我具有本次审阅权限，已核对上方完整标题、正文、页面结构、语言、素材顺序与目的地；批准的仅是这个校验值对应的版本。")}` : ""}${feedback()}<button class="primary-button" type="submit"${native && next[0] === "approved" && !review?.ready ? " disabled" : ""}>${next[1]}</button>${native && next[0] === "approved" && !review?.ready ? '<p class="operation-field-hint">先读取下方准确原生候选、全部附件与终检。缺失或未核实维度不能批准。</p>' : ""}</form>` : "";
    const owned = destination?.kind === "owned_origin" || destination?.platformId === "official-site";
    const release = variant.status === "scheduled" && owned ? `<details class="editorial-disclosure"><summary>建立官网私有发布候选</summary>${formStart("release-create", variant)}<label><span>固定地址 slug（小写英文、数字和连字符）</span><input name="slug" required maxlength="100" pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="a-concrete-product-question" /></label><p class="operation-note">这里只建立私有候选。还需要核对公开预览、独立批准、激活和真实回读，才会形成官网发布回执。更新同一地址时请填写原 slug。</p>${feedback()}<button class="primary-button" type="submit">建立私有候选</button></form></details>` : variant.status === "scheduled" && !owned ? '<p class="operation-note">外部平台仍需在“运营动作”逐账号授权、实际执行与回读；渠道排期不会自动发帖。</p><a class="text-link" href="#operations">进入运营动作 →</a>' : "";
    const document = native ? `<button class="ghost-button" type="button" data-editorial-native="${html(variant.id)}"${nativeLoading.has(variant.id) ? " disabled" : ""}>${nativeLoading.has(variant.id) ? "正在读取准确成品与真实附件…" : "读取完整原生包、真实附件与独立终检"}</button>${nativeErrors.has(variant.id) ? `<p class="form-error" role="alert">${html(nativeErrors.get(variant.id))}</p>` : ""}${renderNativePackageReview(variant, review)}` : exactDocument(variant, state.assets);
    return `<article class="editorial-card" data-editorial-variant="${html(variant.id)}"><header class="editorial-card-heading"><div><p class="eyebrow">${html(LOCALES[variant.locale])} · ${html(FORMATS[variant.format])} · ${html(destination?.name || variant.destinationId)}</p><h3>${html(variant.title)}</h3><p>${html(variant.id)} · ${html(variant.editionId)}</p></div><span class="status-chip ${html(variant.status)}">${html(statusLabel(variant.status))}</span></header>${document}${transition}${release}</article>`;
  }

  function releasePanel() {
    const releases = rows("releases");
    return `<div class="editorial-callout"><strong>预览 → 独立公开批准 → 激活 → 真实回读</strong><p>内容批准与官网公开批准是两次独立决定。激活后先标记“待回读”；服务器真正读取公开页面与媒体并匹配精确版本后，才登记发布完成。备份与隔离恢复由实际部署流程验证，不由勾选框替代。</p></div><div class="editorial-stack">${releases.length ? [...releases].reverse().map(releaseCard).join("") : empty("还没有官网发布候选", "先保存语言版本、创建官网渠道草稿，分别完成核验、批准与排期，再建立私有候选。")}</div>`;
  }

  function releaseCard(release) {
    const document = snapshot(release);
    const activeRoute = rows("routes").find(item => item.activeReleaseId === release.id);
    const sameRoute = rows("routes").find(item => item.canonicalPath === release.canonicalPath || item.locale === release.locale && item.format === release.format && item.slug === release.slug);
    const previousId = sameRoute?.activeReleaseId || null;
    const previewUrl = `/admin/preview/${encodeURIComponent(release.id)}`;
    const approve = ["candidate", "draft", "pending_approval"].includes(release.status) ? `${formStart("release-approve", release, snapshotHash(release))}<label><span>此次公开批准的范围与说明</span><textarea name="authorizationNote" required minlength="8" maxlength="2000" rows="3" placeholder="请先打开真实私有预览，核对本页将公开的全部内容与媒体。"></textarea></label>${reviewCheck("我具有本次公开审阅权限，已查看此候选的完整公开预览，核对标题、正文、语言、素材及固定地址；只批准当前校验值对应的版本公开。")}${feedback()}<button class="primary-button" type="submit">批准这个精确官网版本公开</button></form>` : "";
    const publish = release.status === "approved" ? `${formStart("release-publish", release, snapshotHash(release))}<input type="hidden" name="expectedPreviousReleaseId" value="${html(previousId || "")}" /><p class="operation-note">${previousId ? `此地址当前指向 ${html(previousId)}，将以本候选替换，旧版回执仍保留。` : "此固定地址尚无活跃版本，将首次激活。"}若其他人已更新此地址，服务会拒绝覆盖并要求重新核对。</p>${reviewCheck("现在将上方已公开批准的精确版本激活到官网地址。我已核对该地址及本次替换范围。", "confirm")}${feedback()}<button class="primary-button" type="submit">激活到官网 · 随后需回读</button></form>` : "";
    const verify = release.status === "live_unverified" ? `${formStart("release-verify", release, snapshotHash(release))}<p class="operation-note">公开页已经激活，尚未核验完成。此按钮让服务器实际读取官网页面和每个媒体文件，比对批准版本；不接受手工填写哈希或“已回读”声明。</p>${reviewCheck("执行此活跃版本的真实官网回读检查。", "confirm")}${feedback()}<button class="primary-button" type="submit">实际回读页面与媒体</button></form>` : "";
    const withdraw = ["live_unverified", "published"].includes(release.status) && activeRoute ? `<details class="editorial-disclosure editorial-danger"><summary>撤回当前公开版本</summary>${formStart("release-withdraw", release)}<label><span>实际撤稿原因</span><textarea name="reason" required maxlength="2000" rows="3"></textarea></label>${reviewCheck("停止此地址当前版本的公开可见性，保留原正文、审批与回执历史。", "confirm")}${feedback()}<button class="ghost-button" type="submit">撤回公开版本</button></form></details>` : "";
    const receipt = release.receipt ? `<div class="editorial-receipt"><strong>真实回读回执</strong><p>${externalLink(release.receipt.canonicalUrl || release.receipt.url || release.canonicalUrl, "打开核验地址")}</p><p>${html(timestamp(release.receipt.verifiedAt || release.receipt.recordedAt))} · ${html(release.receipt.method || release.receipt.verificationMethod || "server_readback")}</p>${hashLine(release.receipt.snapshotHash || snapshotHash(release))}</div>` : "";
    return `<article class="editorial-card"><header class="editorial-card-heading"><div><p class="eyebrow">${html(LOCALES[release.locale || document.locale])} · ${html(FORMATS[release.format || document.format])}${activeRoute ? " · 当前路由版本" : release.status === "published" ? " · 历史版本" : ""}</p><h3>${html(document.title || release.title || release.id)}</h3><p>${html(release.id)} · ${html(release.canonicalPath || "固定地址待返回")}</p></div><span class="status-chip ${html(release.status)}">${html(statusLabel(release.status))}</span></header><div class="editorial-inline-links">${externalLink(previewUrl, "打开真实私有预览")}${["live_unverified", "published"].includes(release.status) ? externalLink(release.canonicalUrl || release.canonicalPath, "打开官网当前页面") : ""}</div>${exactDocument(release, state.assets)}${receipt}${release.withdrawal ? `<p class="operation-note">撤稿：${html(release.withdrawal.reason || "已撤回")} · ${html(timestamp(release.withdrawal.at || release.withdrawal.withdrawnAt))}</p>` : ""}${approve}${publish}${verify}${withdraw}</article>`;
  }

  function mediaPanel() {
    const failure = state.mediaError ? `<p class="form-error" role="alert">媒体列表暂时无法读取。${html(state.mediaError.message || "请刷新重试。")}</p>` : "";
    const upload = `${formStart("asset-upload")}<div class="panel-heading"><h3>上传真实定稿素材</h3><span>先私有暂存，审核与发布分开</span></div><label><span>图片 PNG / JPEG / WebP、视频 MP4 或字幕 VTT</span><input name="file" type="file" accept="image/png,image/jpeg,image/webp,video/mp4,text/vtt,.vtt"${state.file ? "" : " required"} /></label>${state.file ? `<p class="operation-field-hint">已选：${html(state.file.name)} · ${byteSize(state.file.size)}。未重新选择时继续使用这份文件。</p>` : ""}<p class="operation-note">只上传你有权使用且不含隐私的最终文件。系统按实际字节校验类型、大小与配额；上传成功不代表已批准公开。重型视频制作仍在本机进行。</p>${feedback()}<button class="primary-button" type="submit">校验并上传私有素材</button></form>`;
    return `<article class="editorial-section">${upload}</article>${failure}<div class="editorial-stack">${state.assets.length ? [...state.assets].reverse().map(assetCard).join("") : empty("还没有媒体素材", "生产库保持真实空状态；不会把设计稿中的示例图片或视频当成已发布作品。")}</div>`;
  }

  function assetCard(asset) {
    const privateUrl = `/api/media/assets/${encodeURIComponent(asset.id)}/bytes`;
    const preview = asset.kind === "image" ? `<img class="editorial-asset-preview" src="${privateUrl}" loading="lazy" alt="私有素材预览" />` : asset.kind === "video" ? `<video class="editorial-asset-preview" src="${privateUrl}" controls playsinline preload="metadata"></video>` : externalLink(privateUrl, "打开原始字幕文件");
    const approve = asset.status === "staged" ? `${formStart("asset-approve", asset, asset.sha256)}<label><span>素材来源、许可与隐私核对说明</span><textarea name="rightsNote" required minlength="8" maxlength="2000" rows="3" placeholder="记录真实来源、使用许可与是否包含他人信息。不上传许可证中的私密账号或凭据。"></textarea></label>${reviewCheck("我已核对这份精确字节素材的来源和使用权，允许本项目按已审阅范围使用。", "rightsConfirmed")}${reviewCheck("我已检查这份素材不包含未获准公开的个人、客户或其他私密信息。", "privacyConfirmed")}${feedback()}<button class="primary-button" type="submit">批准这份素材的使用范围</button></form>` : "";
    const revoke = asset.status === "reviewed" ? `<details class="editorial-disclosure editorial-danger"><summary>撤销此素材的公开使用</summary>${formStart("asset-revoke", asset, asset.sha256)}<label><span>撤销原因</span><textarea name="reason" required maxlength="2000" rows="2"></textarea></label>${reviewCheck("停止此素材的公开交付；引用它的发布版本可能随之不再具备公开条件，历史仍保留。", "confirm")}${feedback()}<button class="ghost-button" type="submit">撤销使用</button></form></details>` : "";
    return `<article class="editorial-card" data-editorial-asset="${html(asset.id)}"><header class="editorial-card-heading"><div><p class="eyebrow">${html(asset.kind)} · ${html(asset.mime)} · ${byteSize(asset.size)}</p><h3>${html(asset.name || asset.id)}</h3><p>${html(asset.id)} · ${html(timestamp(asset.createdAt))}${asset.width && asset.height ? ` · ${html(asset.width)} × ${html(asset.height)}` : ""}</p></div><span class="status-chip ${asset.status === "reviewed" ? "approved" : ""}">${html(statusLabel(asset.status))}</span></header><details class="editorial-disclosure"><summary>查看私有原文件</summary>${preview}<p class="operation-field-hint">此预览使用管理员权限；审核通过本身不会生成匿名可读素材地址，仍须有符合条件的活跃官网版本引用它。</p></details>${hashLine(asset.sha256)}${asset.review ? `<p class="operation-note">最近审核：${html(asset.review.actor || asset.review.reviewedBy || "管理员会话")} · ${html(timestamp(asset.review.at || asset.review.reviewedAt))}<br />${html(asset.review.rightsNote || "")}</p>` : ""}${approve}${revoke}</article>`;
  }

  function accountsPanel() {
    const list = rows("accounts").filter(account => state.showArchived || account.status !== "archived");
    const platforms = catalog().filter(platform => platform.kind !== "owned_site");
    return `<div class="editorial-callout"><strong>平台目录、真实账号、发布目的地是三件事</strong><p>这里登记实际账号身份与生命周期，不存平台密码或 Cookie，也不把目录项标成已连接。归档只收起当前运营入口，历史正文、动作和回执仍然保留。</p></div><details class="editorial-disclosure"><summary>登记一个真实账号</summary>${formStart("account-create")}<div class="editorial-grid"><label><span>平台</span><select name="platformId" required><option value="">选择实际平台</option>${platforms.map(platform => `<option value="${html(platform.id)}">${html(platform.nameZh || platform.name || platform.id)}</option>`).join("")}</select></label><label><span>账号实际 handle</span><input name="handle" required maxlength="160" /></label><label class="wide"><span>实际公开个人主页</span><input name="profileUrl" type="url" required maxlength="2000" /></label><label><span>主要语言</span><select name="language">${options(LOCALES, "zh-CN")}</select></label><label><span>展示名（可选）</span><input name="displayName" maxlength="240" /></label></div><p class="operation-note">保存后为未启用、身份待核对状态；请实际打开主页核验身份和规则，再决定启用。</p>${feedback()}<button class="primary-button" type="submit">登记真实资料 · 待核对</button></form></details><div class="editorial-toolbar"><label class="check-label"><input type="checkbox" id="editorial-show-archived"${state.showArchived ? " checked" : ""} /><span>显示已归档账号与历史</span></label><span>${list.length} 个当前显示</span></div><div class="editorial-stack">${list.length ? list.map(accountCard).join("") : empty("当前没有显示的真实账号", "可登记新账号，或打开已归档历史。")}</div>`;
  }

  function reviewFields(row) {
    return `<div class="editorial-review-boundary"><p class="operation-field-hint">当前身份：${row.identityReview?.status === "verified" ? "已核对" : "待核对"}；规则：${row.policyStatus === "reviewed" ? `已审阅 · ${html(timestamp(row.policyCheckedAt))}` : "待审阅"}。本次未勾选时不会伪造新的核对记录；修改账号身份后需要重新核对。</p><label class="check-label"><input type="checkbox" name="identityConfirmed" /><span>本次已实际核对上方账号 / 目的地身份，确认它属于获准使用的真实目标。</span></label><label class="check-label"><input type="checkbox" name="policyReviewed" /><span>本次已实际审阅该位置适用的平台 / 社区规则。</span></label><label><span>本次核对说明（进行身份或规则核对时必填）</span><textarea name="reviewNote" maxlength="2000" rows="2"></textarea></label><label><span>规则实际审阅时间（北京时间）</span><input type="datetime-local" name="policyCheckedAt" /></label></div>`;
  }

  function accountCard(account) {
    return `<article class="editorial-card" data-editorial-account="${html(account.id)}"><header class="editorial-card-heading"><div><p class="eyebrow">${html(platformName(account.platformId) || account.platform)} · ${html(account.id)}</p><h3>${html(account.handle)}</h3><p>${account.identityReview?.status === "verified" ? "身份已核对" : "身份待核对"} · ${account.policyStatus === "reviewed" ? "规则已审阅" : "规则待审阅"} · 启用不等于平台已登录</p></div><span class="status-chip">${html(statusLabel(account.status))}</span></header>${externalLink(account.profileUrl, "打开实际账号主页")}<details class="editorial-disclosure"><summary>更新资料 / 核对 / 暂停或归档</summary>${formStart("account-update", account)}<div class="editorial-grid"><label><span>实际 handle</span><input name="handle" required maxlength="160" value="${html(account.handle)}" /></label><label><span>账号状态</span><select name="status">${options({ draft: "未启用", active: "启用（需已核对身份与规则）", paused: "暂停", archived: "归档并保留历史" }, account.status)}</select></label><label class="wide"><span>公开主页（可留空或清除；身份核对前需填写）</span><input name="profileUrl" type="url" maxlength="2000" value="${html(account.profileUrl || "")}" /></label><label><span>主要语言</span><select name="language">${options(LOCALES, account.language)}</select></label><label><span>展示名</span><input name="displayName" required maxlength="240" value="${html(account.displayName || account.handle)}" /></label></div>${reviewFields(account)}<label><span>暂停 / 归档原因（对应状态必填）</span><textarea name="reason" maxlength="2000" rows="2"></textarea></label><p class="operation-note">执行结果未明的动作会阻止归档。请先在运营动作核对原结果，不重发、不删除历史来过闸门。</p>${feedback()}<button class="primary-button" type="submit">保存账号资料与生命周期</button></form></details><div class="editorial-history"><button class="ghost-button" type="button" data-account-history="${html(account.id)}">读取真实变更历史</button><div data-account-history-output="${html(account.id)}" aria-live="polite"></div></div></article>`;
  }

  function destinationsPanel() {
    const destinations = rows("destinations");
    const create = `${formStart("destination-create")}<div class="editorial-grid">
      <label><span>平台</span><select name="platformId" required><option value="">选择平台</option>${catalog().map(platform => `<option value="${html(platform.id)}">${html(platform.nameZh || platform.name || platform.id)}</option>`).join("")}</select></label>
      <label><span>对应真实账号（官网不关联账号）</span><select name="accountId"><option value="">先选择实际平台</option></select></label>
      <label><span>位置类型</span><select name="kind">${options(DESTINATION_KINDS, "profile_feed")}</select></label>
      <label><span>内部名称</span><input name="name" required maxlength="240" /></label>
      ${locatorFields()}
      <label><span>可见范围</span><select name="visibility">${options({ unverified: "尚未核对", public: "公开", restricted: "受限", private: "私有" }, "unverified")}</select></label>
      </div><p class="operation-note">按真实位置填写。Discord 需要服务器与频道 ID；技术作品需明确仓库或作品类型。目录存在不等于账号已连接。</p>${feedback()}<button class="primary-button" type="submit">保存目的地 · 待核对</button></form>`;
    return `<div class="editorial-callout"><strong>把发布位置具体到域名、仓库、社区或频道</strong><p>一个平台或账号名称不足以说明这次在哪里发布。新目的地先保持待核对；官网来源、社群可见性与社区规则分别核验。</p></div>
      <details class="editorial-disclosure"><summary>登记真实发布目的地</summary>${create}</details>
      <div class="editorial-stack">${destinations.length ? destinations.map(destination => `<article class="editorial-card"><header class="editorial-card-heading"><div><p class="eyebrow">${html(platformName(destination.platformId))} · ${html(DESTINATION_KINDS[destination.kind] || destination.kind)}</p><h3>${html(destination.name)}</h3><p>${html(destination.id)} · ${html(destination.visibility)} · ${destination.identityReview?.status === "verified" ? "身份已核对" : "身份待核对"}</p></div><span class="status-chip">${html(statusLabel(destination.status))}</span></header>
        ${destinationLocatorSummary(destination)}<details class="editorial-disclosure"><summary>更新位置、核对身份与启用状态</summary>${formStart("destination-update", destination)}<div class="editorial-grid">
        <label class="wide"><span>内部名称</span><input name="name" required maxlength="240" value="${html(destination.name)}" /></label>
        ${locatorFields(destination.kind, destination.locator)}
        <label><span>状态</span><select name="status">${options({ draft: "未启用", active: "启用", paused: "暂停", archived: "归档" }, destination.status)}</select></label>
        <label><span>可见性</span><select name="visibility">${options({ unverified: "待核对", public: "公开", restricted: "受限", private: "私有" }, destination.visibility)}</select></label></div>
        <p class="operation-field-hint">修改真实位置或可见性会使原身份与规则核对失效；启用前请核对修改后的精确位置。</p>${reviewFields(destination)}<label><span>暂停 / 归档原因</span><textarea name="reason" rows="2" maxlength="2000"></textarea></label>${feedback()}<button class="primary-button" type="submit">保存目的地资料与核对结果</button></form></details></article>`).join("") : empty("尚无实际目的地", "目录不会自动创建目的地。请在核对真实位置后登记。")}</div>`;
  }

  function catalogPanel() {
    const query = state.catalogQuery.trim().toLowerCase();
    const platforms = catalog().filter(platform => !query || JSON.stringify(platform).toLowerCase().includes(query));
    return `<div class="editorial-callout"><strong>目录是可研究的渠道，不是已连接账号</strong><p>官网是长期阅读入口。社交内容、技术作品、主题社区各按真实用途准备；不存在一键全网群发。平台能力存在、本站实现、账号配置和真实执行是不同证据。</p></div><label class="editorial-catalog-search"><span>搜索平台、内容形式或用途</span><input type="search" id="editorial-catalog-search" value="${html(state.catalogQuery)}" maxlength="160" /></label><p class="operation-field-hint">${platforms.length} 个目录项匹配；真实账号与目的地单独登记。</p><div class="editorial-catalog-grid">${platforms.length ? platforms.map(platform => {
      const sources = platform.policySources || platform.capabilityEvidence || [];
      return `<article class="editorial-catalog-card"><p class="eyebrow">${html(PLATFORM_KIND_LABELS[platform.kind] || platform.category || "候选渠道")}</p><h3>${html(platform.nameZh || platform.name || platform.id)}</h3><p>${html(platform.nameEn || platform.id)}</p>${platform.description || platform.purpose || platform.role ? `<p>${html(platform.description || platform.purpose || platform.role)}</p>` : ""}<p class="editorial-catalog-formats">${(platform.preferredContentForms || platform.supportedEditorialFormats || platform.formats || []).map(format => html(CONTENT_FORM_LABELS[format] || format)).join(" · ")}</p>${platform.notes ? `<p>${html(Array.isArray(platform.notes) ? platform.notes.join("；") : platform.notes)}</p>` : ""}<p class="operation-field-hint">已登记 ${Number(platform.configuredAccountCount || 0)} 个真实账号 · 已启用 ${Number(platform.activeAccountCount || 0)} 个 · 身份已核对 ${Number(platform.identityVerifiedCount || 0)} 个 · ${Number(platform.destinationCount || 0)} 个目的地</p><span class="editorial-unconnected">目录与配置数量不表示平台已登录或已完成发布</span>${sources.length ? `<details><summary>规则与能力依据</summary><ul>${sources.map(source => `<li>${externalLink(typeof source === "string" ? source : source.url, source.title || source.label || "官方依据")}</li>`).join("")}</ul></details>` : ""}</article>`;
    }).join("") : empty("没有匹配目录项", "调整搜索词即可；不会因此创建虚构账号。")}</div>`;
  }

  function render() {
    captureDrafts();
    const tabs = `<div class="editorial-tabs" role="tablist" aria-label="编辑出版功能">${Object.entries(TABS).map(([tab, label]) => `<button type="button" role="tab" id="editorial-tab-${tab}" data-editorial-tab="${tab}" aria-selected="${state.tab === tab}" aria-controls="editorial-panel" tabindex="${state.tab === tab ? "0" : "-1"}">${label}</button>`).join("")}</div>`;
    let panel;
    if (!state.data) panel = state.error ? `<div class="form-error" role="alert">编辑服务暂时不可用。${html(state.error.message || "请刷新重试；目标服务可能尚未部署此版本。")}</div>` : '<div class="editorial-empty" role="status"><strong>正在读取编辑出版工作区…</strong><p>读取真实目录、账号、版本与发布回执。</p></div>';
    else panel = ({ stories: storyPanel, releases: releasePanel, media: mediaPanel, accounts: accountsPanel, destinations: destinationsPanel, catalog: catalogPanel }[state.tab])();
    root.innerHTML = `<div class="editorial-workspace"><div class="editorial-workspace-heading"><p>完整正文与媒体分别核对 · 中英版本独立审批 · 官网与外部分发分别回读</p><button class="ghost-button" type="button" data-editorial-refresh${state.loading ? " disabled" : ""}>${state.loading ? "正在刷新…" : "刷新编辑数据"}</button></div>${state.notice ? `<p class="editorial-notice" role="status">${html(state.notice)}</p>` : ""}${state.error && state.data ? `<p class="form-error" role="alert">刷新未完成，当前显示上次读取的资料。${html(state.error.message || "请稍后重试。")}</p>` : ""}${tabs}<div id="editorial-panel" role="tabpanel" aria-labelledby="editorial-tab-${state.tab}">${panel}</div></div>`;
    root.setAttribute("aria-busy", String(state.loading));
    restoreDrafts();
    synchronizeForms();
    completedKeys.clear();
    for (const form of root.querySelectorAll("form[data-editorial-form]")) {
      if (!activeForms.has(formKey(form))) continue;
      form.setAttribute("aria-busy", "true");
      const controls = [...form.querySelectorAll("input, select, textarea, button")].map(field => [field, field.disabled]);
      pendingControls.set(form, controls);
      for (const [field] of controls) field.disabled = true;
      const status = form.querySelector("[data-editorial-status]");
      if (status) status.textContent = "正在保存原操作，请等待结果后继续。";
    }
    // Dependent selectors need their parent selection before restoring an unsent value.
    restoreDrafts();
    synchronizeForms();
  }

  function synchronizeForms() {
    for (const form of root.querySelectorAll('[data-editorial-form="account-update"], [data-editorial-form="destination-update"], [data-editorial-form="story-update"]')) updateReviewRequirements(form);
    for (const form of root.querySelectorAll('[data-editorial-form="destination-create"], [data-editorial-form="destination-update"]')) updateDestinationForm(form);
    for (const form of root.querySelectorAll('[data-editorial-form="edition-create"]')) updateEditionReferences(form);
    for (const form of root.querySelectorAll('[data-editorial-form="variant-create"]')) updateVariantRevisions(form);
  }

  let loadPromise = null;
  async function load() {
    if (loadPromise) return loadPromise;
    state.loading = true;
    state.error = null;
    if (!state.data) render();
    const refreshButton = root.querySelector("[data-editorial-refresh]");
    if (refreshButton) { refreshButton.disabled = true; refreshButton.textContent = "正在刷新…"; }
    loadPromise = (async () => {
      const results = await Promise.allSettled([api("/api/editorial/bootstrap"), api("/api/media/assets")]);
      if (results[0].status === "fulfilled") {
        const payload = results[0].value;
        if (!payload || !Array.isArray(payload.stories) || !Array.isArray(payload.editions)) state.error = new Error("编辑数据格式不可用，请核对目标服务版本。");
        else state.data = payload;
      } else state.error = results[0].reason;
      if (results[1].status === "fulfilled") {
        const payload = results[1].value;
        state.assets = Array.isArray(payload) ? payload : Array.isArray(payload.items) ? payload.items : [];
        state.mediaError = null;
      } else state.mediaError = results[1].reason;
      state.loading = false;
      render();
      if (onCatalogChange) onCatalogChange(state.error ? null : state.data?.catalog || null);
      return !state.error;
    })();
    try { return await loadPromise; }
    finally { loadPromise = null; state.loading = false; }
  }

  function newKey() {
    if (!globalThis.crypto?.randomUUID) throw new Error("当前页面无法生成安全请求标识，请使用 HTTPS 管理后台重试。");
    return `web-${globalThis.crypto.randomUUID()}`;
  }

  async function mutate(path, body, { method = "POST", etag, needsEtag = false, bytes = false, headers = {} } = {}) {
    if (needsEtag && !etag) throw new Error("当前资料缺少版本校验值，请先刷新编辑数据，重新核对后再操作。");
    const signature = bytes ? `${body.size}:${headers["X-Content-SHA256"]}:${headers["Content-Type"]}:${headers["X-Media-Name"]}` : JSON.stringify(body);
    const attemptId = `${method}:${path}:${signature}`;
    const attempt = attempts.get(attemptId) || { key: newKey(), etag };
    attempts.set(attemptId, attempt);
    try {
      const result = await api(path, { method, headers: { ...headers, "Idempotency-Key": attempt.key, ...(attempt.etag ? { "If-Match": attempt.etag } : {}) }, body: bytes ? body : JSON.stringify(body) });
      attempts.delete(attemptId);
      return result;
    } catch (error) {
      if (error.status >= 400 && error.status < 500) attempts.delete(attemptId);
      throw error;
    }
  }

  function parseBlocks(fields, body, references) {
    const input = String(fields.get("blocksJson") || "").trim();
    let blocks;
    if (input) {
      try { blocks = JSON.parse(input); }
      catch { throw new Error("结构化内容不是有效 JSON；输入已保留，请修正后再保存。"); }
      if (!Array.isArray(blocks)) throw new Error("结构化内容必须为 blocks 数组。");
    } else {
      blocks = documentBlocksFromText(body);
      const referenced = new Set(blocks.filter(block => block.type === "image").map(block => block.assetId));
      for (const reference of references.filter(ref => ref.role === "image")) {
        if (!referenced.has(reference.assetId)) blocks.push({ type: "image", assetId: reference.assetId, alt: reference.alt, ...(reference.caption ? { caption: reference.caption } : {}) });
      }
    }
    return blocks;
  }

  function readAssets(fields, locale) {
    return fields.getAll("assetId").map((id, index) => {
      const asset = state.assets.find(item => item.id === id);
      if (!asset || asset.status !== "reviewed") throw new Error("所选素材已变更或尚未审核。请刷新并重新选择精确素材。");
      const role = String(fields.get(`assetRole-${id}`) || "image");
      const alt = String(fields.get(`assetAlt-${id}`) || "");
      const caption = String(fields.get(`assetCaption-${id}`) || "");
      if (asset.kind === "image" && !alt.trim()) throw new Error(`图片“${asset.name || asset.id}”需要替代文字，便于读者理解和独立审阅。`);
      const position = Number(fields.get(`assetOrder-${id}`));
      const assetLocale = asset.kind === "caption" ? String(fields.get(`assetLocale-${id}`) || locale || "zh-CN") : locale;
      return { position: Number.isInteger(position) && position >= 1 ? position : index + 1, reference: { assetId: id, sha256: asset.sha256, role, alt, caption, ...(assetLocale ? { locale: assetLocale } : {}) } };
    }).sort((a, b) => a.position - b.position).map(item => item.reference);
  }

  function updateReviewRequirements(form) {
    const identity = form.elements.identityConfirmed?.checked;
    const policy = form.elements.policyReviewed?.checked;
    if (form.elements.reviewNote) form.elements.reviewNote.required = Boolean(identity || policy);
    if (form.elements.policyCheckedAt) form.elements.policyCheckedAt.required = Boolean(policy);
    if (form.elements.reason) form.elements.reason.required = ["paused", "archived"].includes(form.elements.status?.value);
  }

  function replaceReferenceOptions(select, entries, placeholder) {
    const selected = select.value;
    select.innerHTML = `<option value="">${html(placeholder)}</option>${entries.map(item => `<option value="${html(item.id)}">${html(LOCALES[item.locale] || "")} · ${html(FORMATS[item.format] || "")} · ${item.editorialRevision ? `修订 ${html(item.editorialRevision)} · ` : ""}${html(item.title)} · ${html(item.id)}</option>`).join("")}`;
    select.value = entries.some(item => item.id === selected) ? selected : "";
  }

  function updateEditionReferences(form) {
    const choices = editionReferenceChoices(rows("editions"), { storyId: form.dataset.entityId, locale: form.elements.locale.value, format: form.elements.format.value });
    replaceReferenceOptions(form.elements.sourceEditionId, choices.sources, "独立撰写，不关联译文来源");
    replaceReferenceOptions(form.elements.supersedesEditionId, choices.previous ? [choices.previous] : [], choices.previous ? "请明确选择当前最新修订" : "新语言 / 形式系列，无旧版可替代");
    form.elements.supersedesEditionId.required = Boolean(choices.previous);
    form.elements.supersedesEditionId.disabled = !choices.previous;
  }

  function updateVariantRevisions(form) {
    const edition = rows("editions").find(item => item.id === form.dataset.entityId);
    if (!edition) return;
    replaceReferenceOptions(form.elements.supersedesContentId, variantRevisionChoices(rows("variants"), edition, form.elements.destinationId.value), "独立新草稿，不替代旧稿");
  }

  function updateDestinationForm(form) {
    const create = form.dataset.editorialForm === "destination-create";
    const destination = create ? null : rows("destinations").find(item => item.id === form.dataset.entityId);
    if (!create && !destination) return;
    let kind = destination?.kind;
    if (create) {
      const platform = catalog().find(item => item.id === form.elements.platformId.value);
      const kinds = platform ? destinationKindsForPlatform(platform) : ["profile_feed"];
      for (const option of form.elements.kind.options) { option.disabled = !kinds.includes(option.value); option.hidden = option.disabled; }
      if (!kinds.includes(form.elements.kind.value)) form.elements.kind.value = kinds[0];
      kind = form.elements.kind.value;
      const accountSelect = form.elements.accountId;
      const selected = accountSelect.value;
      const accounts = rows("accounts").filter(account => account.status !== "archived" && account.platformId === platform?.id);
      accountSelect.innerHTML = `<option value="">${platform?.kind === "owned_site" ? "自有官网不关联社媒账号" : accounts.length ? "选择此平台的真实账号" : "当前平台没有可用真实账号，请先登记"}</option>${accounts.map(account => `<option value="${html(account.id)}">${html(account.handle)} · ${html(statusLabel(account.status))} · ${html(account.id)}</option>`).join("")}`;
      accountSelect.disabled = !platform || platform.kind === "owned_site";
      accountSelect.required = Boolean(platform && platform.kind !== "owned_site");
      accountSelect.value = accounts.some(item => item.id === selected) && !accountSelect.disabled ? selected : "";
    }
    for (const group of form.querySelectorAll("[data-locator-group]")) {
      const shown = group.dataset.locatorGroup === "url" ? !["owned_origin", "community_channel"].includes(kind) : group.dataset.locatorGroup === kind;
      group.hidden = !shown;
      for (const field of group.querySelectorAll("input")) {
        field.disabled = !shown;
        field.required = shown && field.name !== "threadId";
      }
    }
  }

  function reviewInput(form, fields) {
    const input = {};
    if (fields.get("identityConfirmed") === "on") input.identityConfirmed = true;
    if (fields.get("policyReviewed") === "on") {
      if (!fields.get("policyCheckedAt")) throw new Error("请填写实际规则审阅时间，不用当前时间冒充审阅记录。");
      const date = new Date(`${fields.get("policyCheckedAt")}:00+08:00`);
      if (!Number.isFinite(date.getTime())) throw new Error("规则审阅时间无效。");
      input.policyStatus = "reviewed";
      input.policyCheckedAt = date.toISOString();
    }
    if (input.identityConfirmed || input.policyStatus === "reviewed") {
      const note = String(fields.get("reviewNote") || "");
      if (!note.trim()) throw new Error("请说明本次实际身份 / 规则核对的依据。");
      input.reviewNote = note;
    }
    const reason = String(fields.get("reason") || "");
    if (reason.trim()) input.reason = reason;
    return input;
  }

  async function perform(form, fields) {
    const action = form.dataset.editorialForm;
    const id = form.dataset.entityId;
    const etag = form.dataset.etag;
    const parent = { etag, needsEtag: true };
    if (action === "story-create") {
      const result = await mutate("/api/stories", { workingTitle: fields.get("workingTitle"), claimIds: fields.getAll("claimIds"), topicIds: String(fields.get("topicIds") || "").split(/[,，]/).map(item => item.trim()).filter(Boolean) });
      state.selectedStoryId = result.id;
      return result;
    }
    if (action === "story-update") return mutate(`/api/stories/${encodeURIComponent(id)}`, { workingTitle: fields.get("workingTitle"), status: fields.get("status"), ...(fields.get("reason") ? { reason: fields.get("reason") } : {}) }, { ...parent, method: "PATCH" });
    if (action === "edition-create") {
      const locale = String(fields.get("locale"));
      const references = readAssets(fields, locale);
      const body = String(fields.get("body") || "");
      const result = await mutate(`/api/stories/${encodeURIComponent(id)}/editions`, { locale, format: fields.get("format"), title: fields.get("title"), summary: fields.get("summary") || "", body, blocks: parseBlocks(fields, body, references), claimIds: fields.getAll("claimIds"), assetRefs: references, ...(fields.get("sourceEditionId") ? { sourceEditionId: fields.get("sourceEditionId") } : {}), ...(fields.get("supersedesEditionId") ? { supersedesEditionId: fields.get("supersedesEditionId") } : {}) }, parent);
      return result;
    }
    if (action === "variant-create") {
      const edition = rows("editions").find(item => item.id === id);
      const references = readAssets(fields, edition?.locale);
      const body = String(fields.get("body") || "");
      return mutate(`/api/editions/${encodeURIComponent(id)}/variants`, { destinationId: fields.get("destinationId"), title: fields.get("title"), summary: fields.get("summary") || "", body, blocks: parseBlocks(fields, body, references), assetRefs: references, adaptationNote: fields.get("adaptationNote") || "", ...(fields.get("supersedesContentId") ? { supersedesContentId: fields.get("supersedesContentId") } : {}) }, parent);
    }
    if (action === "variant-transition") {
      const variant = rows("variants").find(item => item.id === id);
      return mutate(`/api/content/${encodeURIComponent(id)}/transition`, buildEditorialVariantTransition(variant, fields, { nativeReviewReady: nativeReviews.get(nativeKey(variant || {}))?.ready === true }), parent);
    }
    if (action === "release-create") return mutate("/api/website/releases", { contentId: id, slug: fields.get("slug") }, parent);
    if (action === "release-approve") {
      if (fields.get("reviewed") !== "on") throw new Error("请在实际核对公开预览后确认审阅声明。");
      const release = rows("releases").find(item => item.id === id);
      return mutate(`/api/website/releases/${encodeURIComponent(id)}/approve`, { reviewed: true, snapshotHash: snapshotHash(release || {}), authorizationNote: fields.get("authorizationNote") }, parent);
    }
    if (action === "release-publish") {
      if (fields.get("confirm") !== "on") throw new Error("请先核对并确认本次激活范围。");
      return mutate(`/api/website/releases/${encodeURIComponent(id)}/publish`, { confirm: true, expectedPreviousReleaseId: fields.get("expectedPreviousReleaseId") || null }, parent);
    }
    if (action === "release-verify") {
      if (fields.get("confirm") !== "on") throw new Error("请确认执行实际回读检查。");
      return mutate(`/api/website/releases/${encodeURIComponent(id)}/verify`, { confirm: true }, parent);
    }
    if (action === "release-withdraw") return mutate(`/api/website/releases/${encodeURIComponent(id)}/withdraw`, { reason: fields.get("reason") }, parent);
    if (action === "account-create") return mutate("/api/accounts", { platformId: fields.get("platformId"), handle: fields.get("handle"), profileUrl: fields.get("profileUrl"), language: fields.get("language"), ...(fields.get("displayName") ? { displayName: fields.get("displayName") } : {}) });
    if (action === "account-update") return mutate(`/api/accounts/${encodeURIComponent(id)}`, { handle: fields.get("handle"), profileUrl: fields.get("profileUrl"), language: fields.get("language"), displayName: fields.get("displayName") || "", status: fields.get("status"), ...reviewInput(form, fields) }, { ...parent, method: "PATCH" });
    if (action === "destination-create") return mutate("/api/destinations", { platformId: fields.get("platformId"), ...(fields.get("accountId") ? { accountId: fields.get("accountId") } : {}), kind: fields.get("kind"), name: fields.get("name"), locator: destinationLocatorFromFields(fields.get("kind"), fields), visibility: fields.get("visibility") });
    if (action === "destination-update") {
      const destination = rows("destinations").find(item => item.id === id);
      if (!destination) throw new Error("目的地已变化，请刷新后重新核对。");
      return mutate(`/api/destinations/${encodeURIComponent(id)}`, { name: fields.get("name"), locator: destinationLocatorFromFields(destination.kind, fields), status: fields.get("status"), visibility: fields.get("visibility"), ...reviewInput(form, fields) }, { ...parent, method: "PATCH" });
    }
    if (action === "asset-upload") {
      const selected = form.elements.file?.files?.[0];
      const file = selected?.size ? selected : state.file;
      if (!file?.size) throw new Error("请选择一份实际媒体文件，空文件不能上传。");
      if (!globalThis.crypto?.subtle) throw new Error("当前页面无法校验文件字节，请使用 HTTPS 管理后台。");
      const mime = file.type || (/\.vtt$/i.test(file.name) ? "text/vtt" : "application/octet-stream");
      if (!["image/png", "image/jpeg", "image/webp", "video/mp4", "text/vtt"].includes(mime)) throw new Error("仅支持 PNG、JPEG、WebP、MP4 或 VTT 定稿文件。");
      const bytes = await file.arrayBuffer();
      const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
      const result = await mutate("/api/media/assets", file, { bytes: true, headers: { "Content-Type": mime, "X-Media-Name": encodeURIComponent(file.name), "X-Content-SHA256": sha256 } });
      state.file = null;
      return result;
    }
    if (action === "asset-approve") {
      const asset = state.assets.find(item => item.id === id);
      if (fields.get("rightsConfirmed") !== "on" || fields.get("privacyConfirmed") !== "on") throw new Error("请分别实际核对素材使用权和隐私范围。");
      return mutate(`/api/media/assets/${encodeURIComponent(id)}/approve`, { sha256: asset?.sha256, rightsConfirmed: true, privacyConfirmed: true, rightsNote: fields.get("rightsNote") }, parent);
    }
    if (action === "asset-revoke") return mutate(`/api/media/assets/${encodeURIComponent(id)}/revoke`, { reason: fields.get("reason") }, parent);
    throw new Error("无法识别此操作，请刷新编辑数据后重试。");
  }

  async function submit(form) {
    const key = formKey(form);
    if (activeForms.has(key) || !form.reportValidity()) return;
    activeForms.add(key);
    const fields = new FormData(form);
    const controls = [...form.querySelectorAll("input, select, textarea, button")].map(element => [element, element.disabled]);
    const errorPanel = form.querySelector("[data-editorial-error]");
    const status = form.querySelector("[data-editorial-status]");
    errorPanel.hidden = true;
    errorPanel.textContent = "";
    form.setAttribute("aria-busy", "true");
    for (const [element] of controls) element.disabled = true;
    status.textContent = form.dataset.editorialForm === "asset-upload" ? "正在校验并上传文件，尚未批准公开…" : "正在保存这一次操作…";
    let saved = false;
    let failureMessage = "";
    try {
      const result = await perform(form, fields);
      saved = true;
      activeForms.delete(key);
      drafts.delete(key);
      completedForms.add(form);
      completedKeys.add(key);
      if (form.dataset.editorialForm === "release-create") state.tab = "releases";
      state.notice = result.status === "live_unverified" ? "版本已激活，仍需实际回读页面与媒体。" : result.status === "published" ? "服务器真实回读已通过，发布回执已保存。" : result.status === "withdrawn" ? "当前版本已撤回，正文、审批与历史回执保留。" : "已保存。请继续核对当前状态；草稿或审批成功不代表已经发布。";
      await load();
      if (afterMutation) {
        const [refresh] = await Promise.allSettled([afterMutation()]);
        if (refresh.status === "rejected") {
          state.notice = "本次操作已保存，其他工作区尚未刷新。可用顶部刷新数据重新读取；不要因此重复发布。";
          render();
          if (showError) showError(refresh.reason);
        }
      }
    } catch (error) {
      const findings = error.details?.findings?.map(item => item.message || item.code).filter(Boolean).join("；");
      failureMessage = `${error.message || "操作未完成。"}${findings ? ` ${findings}` : ""}${!error.code && !error.status ? " 结果可能尚未确认；请先刷新当前记录。相同内容重试会沿用原请求标识，避免重复创建。" : ""}`;
      const current = [...root.querySelectorAll("form[data-editorial-form]")].find(item => formKey(item) === key);
      const currentError = current?.querySelector("[data-editorial-error]") || errorPanel;
      currentError.textContent = failureMessage;
      currentError.hidden = false;
      currentError.tabIndex = -1;
      if (currentError.isConnected) currentError.focus();
      else if (showError) showError(new Error(failureMessage));
      const currentStatus = current?.querySelector("[data-editorial-status]") || status;
      currentStatus.textContent = "未确认完成。输入已保留，请根据提示处理。";
      if (error.status === 412 || error.code === "PRECONDITION_FAILED") {
        state.notice = "资料版本已变化。刷新后请重新阅读当前精确版本；审阅声明不会自动沿用。";
        captureDrafts();
        activeForms.delete(key);
        await load();
      }
    } finally {
      activeForms.delete(key);
      form.removeAttribute("aria-busy");
      for (const [element, disabled] of controls) if (element.isConnected) element.disabled = disabled;
      for (const current of root.querySelectorAll("form[data-editorial-form]")) {
        if (formKey(current) !== key || !pendingControls.has(current)) continue;
        current.removeAttribute("aria-busy");
        for (const [element, disabled] of pendingControls.get(current)) element.disabled = disabled;
        pendingControls.delete(current);
        const currentStatus = current.querySelector("[data-editorial-status]");
        if (currentStatus) currentStatus.textContent = failureMessage ? "未确认完成。输入已保留，请根据提示处理。" : saved ? "已保存。" : "";
      }
      if (saved && status.isConnected) status.textContent = "已保存。";
    }
  }

  async function loadHistory(button) {
    const id = button.dataset.accountHistory;
    const output = root.querySelector(`[data-account-history-output="${CSS.escape(id)}"]`);
    button.disabled = true;
    button.textContent = "正在读取历史…";
    try {
      const payload = await api(`/api/accounts/${encodeURIComponent(id)}/history`);
      const history = Array.isArray(payload.items) ? payload.items : [];
      output.innerHTML = history.length ? `<ol class="editorial-history-list">${history.map(item => `<li><strong>${html(item.origin === "migration_baseline" ? "迁移时的真实基线（不是更早的历史）" : item.type || "账号变更")}</strong><p>${html(timestamp(item.changedAt || item.at))} · ${html(item.changedBy || item.actor || "未记录")}${item.reason ? `<br />${html(item.reason)}` : ""}</p><details><summary>本次允许展示的记录</summary><pre>${html(JSON.stringify(item, null, 2))}</pre></details></li>`).join("")}</ol>` : '<p class="operation-note">暂无可读取的后续变更记录；不会据此编造更早的修改历史。</p>';
    } catch (error) { output.innerHTML = `<p class="form-error" role="alert">${html(error.message || "读取失败，请重试。")}</p>`; }
    finally { button.disabled = false; button.textContent = "重新读取真实变更历史"; }
  }

  async function loadNativeReview(id) {
    if (nativeLoading.has(id)) return;
    const variant = rows("variants").find(row => row.id === id);
    if (!variant || variant.snapshotSchema !== EDITORIAL_NATIVE_SCHEMA) return;
    nativeLoading.add(id); nativeErrors.delete(id); render();
    try {
      const review = await loadNativePackageReview(api, variant, { editions: rows("editions") });
      nativeReviews.set(nativeKey(variant), review);
    } catch (error) { nativeErrors.set(id, error.message || "准确原生包与附件暂时无法读取，请保留缺口后重试。"); }
    finally { nativeLoading.delete(id); render(); }
  }

  bindNativePackagePreviews(root, { api });

  root.addEventListener("submit", event => {
    const form = event.target.closest("form[data-editorial-form]");
    if (!form) return;
    event.preventDefault();
    void submit(form);
  });
  root.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.editorialTab) {
      state.tab = button.dataset.editorialTab;
      render();
      root.querySelector(`[data-editorial-tab="${state.tab}"]`)?.focus({ preventScroll: true });
    } else if (button.hasAttribute("data-editorial-refresh")) void load();
    else if (button.dataset.accountHistory) void loadHistory(button);
    else if (button.dataset.editorialNative) void loadNativeReview(button.dataset.editorialNative);
  });
  root.addEventListener("keydown", event => {
    const tab = event.target.closest("[role=tab][data-editorial-tab]");
    if (!tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs = Object.keys(TABS);
    const current = tabs.indexOf(state.tab);
    state.tab = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs.at(-1) : tabs[(current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
    render();
    root.querySelector(`[data-editorial-tab="${state.tab}"]`)?.focus({ preventScroll: true });
  });
  root.addEventListener("change", event => {
    if (event.target.id === "editorial-story-select") { state.selectedStoryId = event.target.value; render(); }
    else if (event.target.id === "editorial-show-archived") { state.showArchived = event.target.checked; render(); }
    else if (event.target.type === "file" && event.target.name === "file") { state.file = event.target.files?.[0] || null; }
    const form = event.target.closest("form");
    if (form && ["account-update", "destination-update", "story-update"].includes(form.dataset.editorialForm)) updateReviewRequirements(form);
    if (form && ["destination-create", "destination-update"].includes(form.dataset.editorialForm) && ["platformId", "kind"].includes(event.target.name)) updateDestinationForm(form);
    if (form?.dataset.editorialForm === "edition-create" && ["locale", "format"].includes(event.target.name)) updateEditionReferences(form);
    if (form?.dataset.editorialForm === "variant-create" && event.target.name === "destinationId") updateVariantRevisions(form);
  });
  root.addEventListener("input", event => {
    if (event.target.id !== "editorial-catalog-search") return;
    const position = event.target.selectionStart;
    state.catalogQuery = event.target.value;
    render();
    const input = root.querySelector("#editorial-catalog-search");
    input?.focus({ preventScroll: true });
    if (input && position !== null) input.setSelectionRange(position, position);
  });
  render();
  return { load, render, getData: () => state.data, getCatalog: () => state.error ? null : state.data?.catalog || null, selectContent(id) {
    const variant = rows("variants").find(row => row.id === id);
    if (!variant) return false;
    state.selectedStoryId = variant.storyId; state.tab = "stories"; render();
    window.location.hash = "editorial";
    requestAnimationFrame(() => root.querySelector(`[data-editorial-variant="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
    return true;
  }, selectMedia(id) {
    if (!state.assets.some(asset => asset.id === id)) return false;
    state.tab = "media"; render();
    window.location.hash = "editorial";
    requestAnimationFrame(() => root.querySelector(`[data-editorial-asset="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
    return true;
  } };
}

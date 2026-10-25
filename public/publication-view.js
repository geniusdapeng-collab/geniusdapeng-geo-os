export const PUBLIC_LOCALES = Object.freeze({ zh: "zh-CN", en: "en-US" });
export const FORMAT_SEGMENTS = Object.freeze({ article: "articles", image_text: "visuals", video: "videos" });
const SEGMENT_FORMATS = Object.freeze(Object.fromEntries(Object.entries(FORMAT_SEGMENTS).map(([format, path]) => [path, format])));

const WORDS = Object.freeze({
  zh: {
    journal: "个人媒体 / PERSONAL JOURNAL", byline: "李大鹏｜用AI搞经营的产品经理",
    name: "李大鹏", intro: "用 AI 搞经营，\n把实践写下来。",
    bio: "全栈 AI 产品专家，把模型能力做成专业领域 Agent 数字员工与自主经营系统。",
    nav: ["文章", "图文", "视频", "作品", "关于"], all: "全部", article: "文章", image_text: "图文", video: "视频",
    latest: "最近的思考", selected: "最新刊出", read: "继续阅读", watch: "观看与阅读文稿", visuals: "打开图文",
    archive: "内容库", back: "返回内容库", more: "继续加载", loading: "正在读取已公开内容…", loadingMore: "正在加载…",
    emptyTitle: "第一批内容，正在认真准备。", empty: "完整文章、图解与视频将在审阅并公开后出现在这里。你现在可以先了解我的工作与产品视角。",
    emptyFormat: "这个栏目暂时还没有公开内容。", emptyAction: "查看其他内容", errorTitle: "内容暂时无法读取。",
    error: "请稍后重试。你也可以继续浏览其他栏目。", retry: "重新读取", notFoundTitle: "暂时找不到这篇内容。",
    notFound: "这个地址尚未公开，或链接已变更。", withdrawnTitle: "这篇内容目前不可用。", withdrawn: "内容已撤回或正在重新审阅。公开后会在内容库更新。",
    source: "来源与参考", related: "其他内容", published: "刊出", updated: "更新", language: "中文", author: "李大鹏 · PengManager",
    transcript: "文稿", chapters: "章节", toc: "本文目录", noTranscript: "暂时没有可公开的文稿。",
    videoLoading: "正在准备视频。下方文稿可直接阅读。", videoBuffering: "正在缓冲视频…", videoError: "视频暂时无法播放，你仍可阅读下方文稿。",
    videoUnavailable: "视频目前不可用，文稿保留在下方。", retryVideo: "重试播放", seekReady: "已定位到这一节，点击播放器继续。",
    enlarge: "放大图片", imageUnavailable: "图片暂时无法加载，图注与说明仍可阅读。", retryImage: "重试图片", close: "关闭", previous: "上一张", next: "下一张", imageCount: "图片",
    noEnglish: "暂无英文版。", noChinese: "暂无中文版。", translationNote: "你仍在阅读这篇内容的原文，没有切换到其他主题。",
    keepReading: "继续阅读原文", browseOther: "浏览另一语言的内容库", languageLabel: "阅读语言", original: "原文版本",
    aboutTitle: "关于李大鹏", aboutCopy: "这里是完整文章、图解与视频说明的长期入口。通过具体问题、产品取舍与可核对的工作，记录怎样把 AI 用到经营中。",
    workTitle: "作品与公开证据", workCopy: "实际项目、代码与可追溯的公开资料。以可打开的来源说明工作，不以能力标签替代结果。",
    workEmpty: "作品资料正在整理。经过审阅、具有真实公开来源的资料会在这里更新。", github: "查看 GitHub 上的工作",
    publicFacts: "公开资料", profileUnavailable: "作者公开资料暂时无法刷新；内容阅读不受影响。", footer: "解释清楚，拿出证据，持续更新。", admin: "管理入口", skip: "跳到正文",
    editionDate: "每种语言分别审阅与更新；请以本页的刊出、更新时间为准。", originalHost: "打开原视频", noMatches: "没有符合当前筛选的内容。", clear: "清除筛选",
    olderTranslation: "这份译文依据较早的来源修订。另一语言已有公开更新，当前译文仍保留原来的审阅内容与日期。", viewSource: "查看已公开的来源版本",
  },
  en: {
    journal: "PENGMANAGER / PERSONAL JOURNAL", byline: "Dapeng Li · PengManager",
    name: "PengManager", intro: "Building with AI.\nWriting from practice.",
    bio: "Turning model capabilities into domain-specific AI employees and autonomous business systems.",
    nav: ["Articles", "Visuals", "Videos", "Work", "About"], all: "All", article: "Article", image_text: "Visual note", video: "Video",
    latest: "From the notebook", selected: "LATEST EDITION", read: "Read the article", watch: "Watch & read", visuals: "Open the visual note",
    archive: "Journal", back: "Back to the journal", more: "Load more", loading: "Loading published work…", loadingMore: "Loading…",
    emptyTitle: "The first pieces are taking shape.", empty: "Full articles, visual explanations and videos will appear here after review and publication. In the meantime, explore my work and product perspective.",
    emptyFormat: "There are no published pieces in this section yet.", emptyAction: "Explore the journal", errorTitle: "The journal is temporarily unavailable.",
    error: "Please try again shortly, or explore another section.", retry: "Try again", notFoundTitle: "This piece is not available here.",
    notFound: "The page has not been published, or its address has changed.", withdrawnTitle: "This piece is currently unavailable.", withdrawn: "It has been withdrawn or is under review. Published updates will appear in the journal.",
    source: "Sources & references", related: "More from the journal", published: "Published", updated: "Updated", language: "English", author: "Dapeng Li · PengManager",
    transcript: "Transcript", chapters: "Chapters", toc: "On this page", noTranscript: "No public transcript is available yet.",
    videoLoading: "Preparing the video. The transcript is readable below.", videoBuffering: "Buffering video…", videoError: "The video is temporarily unavailable. You can still read the transcript below.",
    videoUnavailable: "The video is currently unavailable. The transcript remains below.", retryVideo: "Retry video", seekReady: "Chapter selected. Press play to continue.",
    enlarge: "Enlarge image", imageUnavailable: "The image could not be loaded. Its caption remains readable.", retryImage: "Retry image", close: "Close", previous: "Previous image", next: "Next image", imageCount: "Image",
    noEnglish: "No English edition yet.", noChinese: "No Chinese edition yet.", translationNote: "You are still reading the original of this piece; no other topic has been substituted.",
    keepReading: "Keep reading the original", browseOther: "Browse the other language’s journal", languageLabel: "Reading language", original: "Original edition",
    aboutTitle: "About Dapeng Li", aboutCopy: "This journal is the lasting home for full explanations, diagrams and video notes: concrete problems, product decisions and verifiable work on using AI in business operations.",
    workTitle: "Work & public evidence", workCopy: "Projects, code and traceable public sources. Read the work behind an idea, beyond a list of capabilities.",
    workEmpty: "The work index is being prepared. Reviewed material with usable public sources will appear here.", github: "Explore the work on GitHub",
    publicFacts: "Public information", profileUnavailable: "The author profile could not be refreshed; published pieces remain readable.", footer: "Clear explanations. Verifiable work. Ongoing practice.", admin: "Workspace", skip: "Skip to content",
    editionDate: "Each language is reviewed and updated independently. The publication and update dates belong to this edition.", originalHost: "Open the original video", noMatches: "No pieces match the selected filters.", clear: "Clear filters",
    olderTranslation: "This translation is based on an earlier source revision. A newer source edition is public; this translation retains its reviewed text and dates.", viewSource: "Read the published source edition",
  },
});

export function getPublicWords(lang = "zh") { return WORDS[lang === "en" ? "en" : "zh"]; }

export function publicPageMetadata(route, data = {}, { preview = false } = {}) {
  const words = getPublicWords(route.lang);
  const title = data.detail?.title || (route.kind === "about" ? words.aboutTitle : route.kind === "work" ? words.workTitle :
    route.kind === "archive" ? words[route.format] : route.lang === "en" ? "PengManager · Writing from practice" : "PengManager · 李大鹏的个人媒体");
  return {
    title: `${preview ? route.lang === "en" ? "Preview · " : "预览 · " : ""}${title}`,
    description: data.detail?.summary || words.bio,
  };
}

export function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

export function safePublicUrl(value, { relative = true } = {}) {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u0020\u007f]/.test(value)) return null;
  if (relative && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")) return value;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function parsePublicRoute(pathname = "/") {
  let path;
  try { path = decodeURIComponent(String(pathname).split("?")[0]); }
  catch { return { lang: "zh", locale: "zh-CN", kind: "not_found" }; }
  const parts = path.replace(/\/+$/, "").split("/").filter(Boolean);
  const lang = parts[0] === "en" ? "en" : "zh";
  const base = { lang, locale: PUBLIC_LOCALES[lang] };
  if (!parts.length) return { ...base, kind: "home" };
  if (!["zh", "en"].includes(parts[0]) || parts.length > 3) return { ...base, kind: "not_found" };
  if (parts.length === 1) return { ...base, kind: "home" };
  if (["work", "about"].includes(parts[1]) && parts.length === 2) return { ...base, kind: parts[1] };
  const format = SEGMENT_FORMATS[parts[1]];
  if (!format) return { ...base, kind: "not_found" };
  if (parts.length === 2) return { ...base, kind: "archive", format };
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(parts[2])
    ? { ...base, kind: "detail", format, slug: parts[2] }
    : { ...base, kind: "not_found" };
}

export function languagePath(lang, route = {}) {
  const base = `/${lang === "en" ? "en" : "zh"}`;
  if (route.kind === "work" || route.kind === "about") return `${base}/${route.kind}`;
  if (route.format && FORMAT_SEGMENTS[route.format]) return `${base}/${FORMAT_SEGMENTS[route.format]}`;
  return base;
}

function profileEntity(profile) { return profile?.entity ?? profile ?? {}; }

function profileText(profile, lang) {
  const entity = profileEntity(profile);
  const w = getPublicWords(lang);
  return {
    displayName: lang === "en" ? entity.displayNameEn || entity.englishDisplayName || w.byline : entity.displayNameZh || entity.displayName || w.byline,
    bio: lang === "en" ? entity.bioEn || entity.englishBio || `${w.byline}\n\n${w.bio}` : entity.bioZh || entity.bio || `${w.byline}\n\n${w.bio}`,
    headline: lang === "en" ? entity.englishHeadline || w.bio : entity.headline || w.bio,
  };
}

export function renderSiteHeader(route, detail = null) {
  const w = getPublicWords(route.lang);
  const paths = ["articles", "visuals", "videos", "work", "about"];
  const selected = route.format ? FORMAT_SEGMENTS[route.format] : route.kind;
  const current = route.lang;
  return `<a class="site-brand" href="/${current}" aria-label="PengManager ${current === "en" ? "home" : "首页"}">PengManager<small>${escapeHtml(w.byline)}</small></a>
    <nav class="site-nav" aria-label="${current === "en" ? "Main navigation" : "主导航"}">${paths.map((path, index) => `<a href="/${current}/${path}"${selected === path ? ' aria-current="page"' : ""}>${w.nav[index]}</a>`).join("")}</nav>
    <div class="site-language" aria-label="${w.languageLabel}">${["zh", "en"].map((lang) => {
      const label = lang === "zh" ? "中文" : "EN";
      if (lang === current) return `<span aria-current="true" lang="${lang}">${label}</span>`;
      if (route.kind === "detail" && detail) {
        const target = safePublicUrl(detail.alternates?.[PUBLIC_LOCALES[lang]]);
        if (target) return `<a href="${escapeHtml(target)}" lang="${lang}" hreflang="${PUBLIC_LOCALES[lang]}">${label}</a>`;
        return `<button type="button" data-language-unavailable="${lang}" aria-haspopup="dialog" title="${escapeHtml(lang === "en" ? w.noEnglish : w.noChinese)}">${label}<span class="sr-only"> · ${escapeHtml(lang === "en" ? w.noEnglish : w.noChinese)}</span></button>`;
      }
      return `<a href="${languagePath(lang, route)}" lang="${lang}">${label}</a>`;
    }).join("")}</div>`;
}

export function renderSiteFooter(route) {
  const w = getPublicWords(route.lang);
  return `<p>© PengManager / 李大鹏</p><p>${escapeHtml(w.footer)}</p><a href="/admin">${w.admin} <span aria-hidden="true">↗</span></a>`;
}

function dateLabel(value, lang) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat(lang === "en" ? "en-GB" : "zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "short", day: "numeric" }).format(date);
}

function metadata(detail, lang) {
  const w = getPublicWords(lang);
  const published = dateLabel(detail.publishedAt, lang);
  const updated = dateLabel(detail.updatedAt, lang);
  return `<div class="piece-meta"><span>${w.author}</span><span>${w.language}</span>${published ? `<time datetime="${escapeHtml(detail.publishedAt)}">${w.published} · ${escapeHtml(published)}</time>` : ""}${updated && updated !== published ? `<time datetime="${escapeHtml(detail.updatedAt)}">${w.updated} · ${escapeHtml(updated)}</time>` : ""}</div>`;
}

export function publicAssets(detail = {}) {
  const rows = Array.isArray(detail.assets) ? detail.assets : [];
  return rows.map((asset) => {
    const id = String(asset.assetId || asset.id || "");
    return { ...asset, id, assetId: id, url: safePublicUrl(asset.url || asset.src || asset.publicUrl || (id && asset.sha256 ? `/public-media/${encodeURIComponent(id)}/${encodeURIComponent(asset.sha256)}` : "")) };
  }).filter(asset => asset.url);
}

function cardPath(item, lang) {
  return safePublicUrl(item.canonicalPath || item.canonicalUrl)
    || (item.slug && FORMAT_SEGMENTS[item.format] ? `/${lang}/${FORMAT_SEGMENTS[item.format]}/${encodeURIComponent(item.slug)}` : null);
}

export function renderPublicCards(items = [], lang = "zh", { skip = null } = {}) {
  const w = getPublicWords(lang);
  return items.filter(item => !skip || (item.releaseId || item.id) !== skip).map((item) => {
    const path = cardPath(item, lang);
    if (!path) return "";
    const cover = publicAssets(item).find(asset => ["cover", "poster"].includes(asset.role));
    const date = dateLabel(item.publishedAt, lang);
    return `<article class="journal-row"><span class="piece-kind">${escapeHtml(w[item.format] || w.article)}${date ? `<time datetime="${escapeHtml(item.publishedAt)}">${escapeHtml(date)}</time>` : ""}</span><div><h3><a href="${escapeHtml(path)}">${escapeHtml(item.title)}</a></h3>${item.summary ? `<p>${escapeHtml(item.summary)}</p>` : ""}</div>${cover ? `<a class="row-thumbnail" href="${escapeHtml(path)}" tabindex="-1" aria-hidden="true"><img src="${escapeHtml(cover.url)}" alt="" loading="lazy" /></a>` : '<span class="row-arrow" aria-hidden="true">↗</span>'}</article>`;
  }).join("");
}

function archiveFilters(route) {
  const w = getPublicWords(route.lang);
  return `<nav class="content-filters" aria-label="${route.lang === "en" ? "Content format" : "内容形式"}"><a href="/${route.lang}"${!route.format ? ' aria-current="page"' : ""}>${w.all}</a>${Object.entries(FORMAT_SEGMENTS).map(([format, path]) => `<a href="/${route.lang}/${path}"${route.format === format ? ' aria-current="page"' : ""}>${w[format]}</a>`).join("")}</nav>`;
}

function moreButton(listing, lang) {
  const w = getPublicWords(lang);
  return listing?.nextCursor ? `<div class="load-more"><button class="site-button" type="button" data-load-more>${w.more}<span aria-hidden="true">↓</span></button><p data-more-status role="status" aria-live="polite"></p></div>` : "";
}

function aboutLink(lang, label) { return `<a class="site-text-link" href="/${lang}/about">${escapeHtml(label)} <span aria-hidden="true">→</span></a>`; }

function renderEmpty(route, { full = false } = {}) {
  const w = getPublicWords(route.lang);
  return `<section class="journal-empty"><p class="piece-kind">${escapeHtml(w.journal)}</p><h2>${escapeHtml(full ? w.emptyTitle : w.emptyFormat)}</h2>${full ? `<p>${escapeHtml(w.empty)}</p>${aboutLink(route.lang, w.aboutTitle)}` : `<a class="site-text-link" href="/${route.lang}">${w.emptyAction} <span aria-hidden="true">→</span></a>`}</section>`;
}

function renderHome(route, { profile = {}, listing = {} } = {}) {
  const w = getPublicWords(route.lang);
  const identity = profileText(profile, route.lang);
  const items = Array.isArray(listing.items) ? listing.items : [];
  const lead = items[0];
  const cover = lead ? publicAssets(lead).find(asset => ["cover", "poster", "image"].includes(asset.role)) : null;
  return `<div data-public-archive="home"><section class="journal-intro"><div><p class="site-eyebrow">${escapeHtml(w.journal)}</p><h1>${w.intro.split("\n").map(escapeHtml).join("<br />")}</h1></div><p>${escapeHtml(identity.headline)}</p></section>
    ${lead ? `<section class="journal-lead${cover ? " has-cover" : ""}"><div class="lead-copy"><p class="site-eyebrow">${w.selected} / ${escapeHtml(w[lead.format] || w.article)}</p><h2><a href="${escapeHtml(cardPath(lead, route.lang))}">${escapeHtml(lead.title)}</a></h2>${lead.summary ? `<p>${escapeHtml(lead.summary)}</p>` : ""}<a class="site-text-link" href="${escapeHtml(cardPath(lead, route.lang))}">${lead.format === "video" ? w.watch : lead.format === "image_text" ? w.visuals : w.read}<span aria-hidden="true">→</span></a></div>${cover ? `<a class="lead-image" href="${escapeHtml(cardPath(lead, route.lang))}" tabindex="-1" aria-hidden="true"><img src="${escapeHtml(cover.url)}" alt="" /></a>` : `<div class="lead-index" aria-hidden="true"><span>PENGMANAGER</span><strong>${escapeHtml(w[lead.format] || w.article)}</strong><small>${escapeHtml(dateLabel(lead.publishedAt, route.lang))}</small></div>`}</section>` : renderEmpty(route, { full: true })}
    <section class="journal-library"><div class="library-heading"><h2>${w.latest}</h2>${archiveFilters(route)}</div><div id="journal-results" class="journal-results">${renderPublicCards(items, route.lang)}</div>${moreButton(listing, route.lang)}</section>
    <aside class="author-strip"><p class="piece-kind">${escapeHtml(identity.displayName)}</p><p>${escapeHtml(identity.headline)}</p>${aboutLink(route.lang, w.aboutTitle)}</aside></div>`;
}

function renderArchive(route, { listing = {} } = {}) {
  const w = getPublicWords(route.lang);
  const titles = { article: w.nav[0], image_text: w.nav[1], video: w.nav[2] };
  const copy = route.lang === "en" ? {
    article: "The reasoning, trade-offs and practice behind AI products and business operations.", image_text: "Diagrams and visual notes, explained one frame at a time.", video: "Watch the work, then inspect its chapters, transcript and sources.",
  } : { article: "记录 AI 产品与经营中的具体问题、取舍和实践。", image_text: "用图解说明问题，按顺序读懂每一步。", video: "观看具体工作，也能直接阅读章节、文稿与来源。" };
  const items = Array.isArray(listing.items) ? listing.items : [];
  return `<section data-public-archive="${escapeHtml(route.format)}"><header class="archive-heading"><p class="site-eyebrow">${escapeHtml(w.journal)}</p><h1>${escapeHtml(titles[route.format])}</h1><p>${escapeHtml(copy[route.format])}</p></header><div class="library-heading">${archiveFilters(route)}${Number.isSafeInteger(listing.total) && listing.total > 0 ? `<span class="archive-count">${listing.total} ${route.lang === "en" ? "published" : "篇已公开"}</span>` : ""}</div><div id="journal-results" class="journal-results">${items.length ? renderPublicCards(items, route.lang) : renderEmpty(route)}</div>${moreButton(listing, route.lang)}</section>`;
}

function renderSourceLinks(sources, lang) {
  const w = getPublicWords(lang);
  const links = (Array.isArray(sources) ? sources : []).map((source) => {
    const url = safePublicUrl(source.url || source.source?.url, { relative: false });
    if (!url) return "";
    return `<li><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.label || source.title || source.text || source.source?.label || url)} <span aria-hidden="true">↗</span></a></li>`;
  }).filter(Boolean);
  return links.length ? `<section class="piece-sources"><h2>${w.source}</h2><ol>${links.join("")}</ol></section>` : "";
}

export function renderDocumentBlocks(blocks = [], { assets = [], lang = "zh", idPrefix = "section" } = {}) {
  const w = getPublicWords(lang);
  const safeAssets = assets.map(asset => ({ ...asset, url: safePublicUrl(asset.url) })).filter(asset => asset.url);
  const byId = new Map(safeAssets.map(asset => [asset.assetId || asset.id, asset]));
  return blocks.map((block, index) => {
    const text = escapeHtml(block.text || "");
    switch (block.type) {
      case "heading": return `<h${block.level === 3 ? 3 : 2} id="${escapeHtml(idPrefix)}-${index}">${text}</h${block.level === 3 ? 3 : 2}>`;
      case "paragraph": return `<p>${text.replaceAll("\n", "<br />")}</p>`;
      case "quote": return `<blockquote><p>${text.replaceAll("\n", "<br />")}</p></blockquote>`;
      case "code": return `<pre><code>${text}</code></pre>`;
      case "list": return `<${block.ordered ? "ol" : "ul"}>${(Array.isArray(block.items) ? block.items : []).map(item => `<li>${escapeHtml(item)}</li>`).join("")}</${block.ordered ? "ol" : "ul"}>`;
      case "image": {
        const asset = byId.get(block.assetId);
        return asset ? imageFigure({ ...asset, alt: block.alt || asset.alt, caption: block.caption || asset.caption }, index, w) : "";
      }
      case "video": {
        const asset = byId.get(block.assetId);
        return asset ? renderVideoPlayer(asset, byId.get(block.posterAssetId), safeAssets, lang) : "";
      }
      default: return text ? `<p>${text}</p>` : "";
    }
  }).join("");
}

function bodyBlocks(detail) {
  return Array.isArray(detail.blocks) && detail.blocks.length ? detail.blocks : String(detail.body || "").split(/\n\s*\n/).filter(Boolean).map(text => ({ type: "paragraph", text }));
}

function imageFigure(asset, index, w, { numbered = false } = {}) {
  const caption = String(asset.caption || "");
  const alt = String(asset.alt || caption || "");
  return `<figure class="piece-figure" data-piece-image="${escapeHtml(asset.assetId || asset.id)}"><button class="figure-zoom" type="button" data-enlarge-image data-image-src="${escapeHtml(asset.url)}" data-image-alt="${escapeHtml(alt)}" data-image-caption="${escapeHtml(caption)}" aria-label="${escapeHtml(`${w.enlarge}${caption ? ` · ${caption}` : ""}`)}"><img src="${escapeHtml(asset.url)}" alt="${escapeHtml(alt)}" loading="lazy" /><span class="zoom-label" aria-hidden="true">${w.enlarge} ↗</span></button><p class="image-fallback" role="status" hidden>${w.imageUnavailable} <button type="button" data-retry-image>${w.retryImage}</button></p>${caption || numbered ? `<figcaption>${numbered ? `<span class="figure-number">${String(index + 1).padStart(2, "0")}</span>` : ""}${escapeHtml(caption || alt)}</figcaption>` : ""}</figure>`;
}

function renderVideoPlayer(video, poster, assets, lang) {
  const w = getPublicWords(lang);
  const subtitles = assets.filter(asset => asset.role === "subtitle" && asset.url);
  return `<div class="watch-player"><video controls playsinline preload="metadata"${poster?.url ? ` poster="${escapeHtml(poster.url)}"` : ""} data-public-video><source src="${escapeHtml(video.url)}"${video.mime ? ` type="${escapeHtml(video.mime)}"` : ""} />${subtitles.map((asset, index) => `<track kind="captions" src="${escapeHtml(asset.url)}" srclang="${escapeHtml(asset.locale || (lang === "en" ? "en" : "zh"))}" label="${escapeHtml(asset.caption || (lang === "en" ? "English captions" : "中文字幕"))}"${index === 0 ? " default" : ""} />`).join("")}</video><p class="video-status" data-video-status role="status">${w.videoLoading}</p><div class="video-failure" data-video-failure hidden><p>${w.videoError}</p><button class="site-button" type="button" data-retry-video>${w.retryVideo}</button></div></div>`;
}

function tableOfContents(blocks, lang) {
  const headings = blocks.map((block, index) => ({ ...block, index })).filter(block => block.type === "heading");
  if (headings.length < 2) return "";
  return `<nav class="piece-toc" aria-label="${getPublicWords(lang).toc}"><h2>${getPublicWords(lang).toc}</h2><ol>${headings.map(block => `<li><a href="#section-${block.index}">${escapeHtml(block.text)}</a></li>`).join("")}</ol></nav>`;
}

export function chapterMarkers(blocks = []) {
  return blocks.filter(block => block.type === "heading").flatMap((block) => {
    const match = String(block.text || "").match(/^(?:\[)?(\d{1,2}:\d{2}(?::\d{2})?)(?:\])?\s+(.+)$/);
    if (!match) return [];
    const parts = match[1].split(":").map(Number);
    if (parts.slice(1).some(part => part > 59)) return [];
    const seconds = parts.reduce((sum, part) => sum * 60 + part, 0);
    return [{ label: match[2], time: match[1], seconds }];
  });
}

function renderDetail(route, detail) {
  const w = getPublicWords(route.lang);
  const assets = publicAssets(detail);
  const blocks = bodyBlocks(detail);
  const imageBlocks = new Set(blocks.filter(block => block.type === "image").map(block => block.assetId));
  const gallery = assets.filter(asset => asset.role === "image");
  const video = assets.find(asset => asset.role === "video" || asset.kind === "video");
  const poster = assets.find(asset => asset.role === "poster") || assets.find(asset => asset.role === "cover");
  const chapters = chapterMarkers(blocks);
  let content;
  if (route.format === "video") {
    content = `${video ? renderVideoPlayer(video, poster, assets, route.lang) : `<p class="reading-notice" role="status">${w.videoUnavailable}</p>`}${video && chapters.length ? `<nav class="video-chapters" aria-label="${w.chapters}"><h2>${w.chapters}</h2>${chapters.map(chapter => `<button type="button" data-seek="${chapter.seconds}"><span>${escapeHtml(chapter.time)}</span>${escapeHtml(chapter.label)}</button>`).join("")}</nav>` : ""}<section class="piece-body transcript" aria-labelledby="transcript-title"><h2 id="transcript-title">${w.transcript}</h2>${renderDocumentBlocks(blocks.filter(block => block.type !== "video"), { assets, lang: route.lang }) || `<p>${w.noTranscript}</p>`}</section>`;
  } else {
    content = `${tableOfContents(blocks, route.lang)}<div class="piece-body">${renderDocumentBlocks(blocks, { assets, lang: route.lang })}</div>${route.format === "image_text" && gallery.some(asset => !imageBlocks.has(asset.assetId)) ? `<div class="piece-gallery">${gallery.filter(asset => !imageBlocks.has(asset.assetId)).map((asset, index) => imageFigure(asset, index, w, { numbered: true })).join("")}</div>` : ""}`;
  }
  const sourceUrl = safePublicUrl(detail.sourceCanonicalUrl);
  const translation = detail.translationStatus === "needs_review" ? `<aside class="reading-notice" role="note">${w.olderTranslation}${sourceUrl ? `<br /><a class="site-text-link" href="${escapeHtml(sourceUrl)}">${w.viewSource} →</a>` : ""}</aside>` : "";
  return `<article class="reading-page${route.format === "video" ? " watch-page" : ""}" data-public-release="${escapeHtml(detail.releaseId || detail.id)}" data-snapshot-hash="${escapeHtml(detail.snapshotHash || "")}"><a class="piece-back" href="${languagePath(route.lang, route)}">← ${w.back}</a><header class="piece-heading"><p class="site-eyebrow">${escapeHtml(w[route.format])} / ${w.language}</p><h1>${escapeHtml(detail.title)}</h1>${detail.summary ? `<p class="piece-standfirst">${escapeHtml(detail.summary)}</p>` : ""}${metadata(detail, route.lang)}</header>${translation}${content}${renderSourceLinks(detail.sources, route.lang)}<footer class="piece-footer"><p>${w.editionDate}</p><a class="site-text-link" href="/${route.lang}">${w.related} <span aria-hidden="true">→</span></a></footer></article>`;
}

function renderAbout(route, profile = {}) {
  const w = getPublicWords(route.lang);
  const identity = profileText(profile, route.lang);
  return `<section class="about-page"><p class="site-eyebrow">${escapeHtml(w.journal)}</p><h1>${w.aboutTitle}</h1><p class="about-identity">${escapeHtml(identity.displayName)}</p><p class="about-statement">${escapeHtml(identity.headline)}</p><div class="piece-body"><p>${escapeHtml(w.aboutCopy)}</p></div><a class="site-text-link" href="https://github.com/geniusdapeng-collab" target="_blank" rel="noopener noreferrer">${w.github} <span aria-hidden="true">↗</span></a><div class="about-signature" aria-hidden="true">PengManager<span>李大鹏</span></div></section>`;
}

function renderWork(route, profile = {}) {
  const w = getPublicWords(route.lang);
  const claims = Array.isArray(profile.claims) ? profile.claims : [];
  return `<section class="work-page"><header class="archive-heading"><p class="site-eyebrow">${route.lang === "en" ? "WORK / EVIDENCE" : "作品 / 公开证据"}</p><h1>${w.workTitle}</h1><p>${w.workCopy}</p></header><div class="work-evidence">${claims.length ? claims.map(claim => `<article><p>${escapeHtml(claim.text)}</p>${renderSourceLinks([claim.source || {}], route.lang)}</article>`).join("") : `<p class="reading-notice">${w.workEmpty}</p>`}</div><a class="site-text-link" href="https://github.com/geniusdapeng-collab" target="_blank" rel="noopener noreferrer">${w.github} <span aria-hidden="true">↗</span></a></section>`;
}

function renderState(route, { loading, error } = {}) {
  const w = getPublicWords(route.lang);
  if (loading) return `<section class="journal-state" role="status" aria-live="polite"><span class="site-loader" aria-hidden="true"></span><p>${w.loading}</p></section>`;
  const code = Number(error?.status || (route.kind === "not_found" ? 404 : 0));
  const title = code === 410 ? w.withdrawnTitle : code === 404 ? w.notFoundTitle : w.errorTitle;
  const copy = code === 410 ? w.withdrawn : code === 404 ? w.notFound : w.error;
  return `<section class="journal-state"${code ? ' data-public-unavailable="true"' : ' role="alert"'}><p class="site-eyebrow">${code || "PENGMANAGER"}</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(copy)}</p><div class="state-actions">${code ? "" : `<button type="button" class="site-button" data-retry-page>${w.retry}</button>`}<a class="site-text-link" href="/${route.lang}">${w.emptyAction} <span aria-hidden="true">→</span></a></div></section>`;
}

export function renderPublicPage(route, data = {}) {
  if (data.loading || data.error || route.kind === "not_found") return renderState(route, data);
  if (route.kind === "detail") return data.detail ? renderDetail(route, data.detail) : renderState(route, { error: { status: 404 } });
  if (route.kind === "archive") return renderArchive(route, data);
  if (route.kind === "about") return renderAbout(route, data.profile);
  if (route.kind === "work") return renderWork(route, data.profile);
  return renderHome(route, data);
}

export function documentBlocksFromText(body = "") {
  const lines = String(body).replaceAll("\r\n", "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  let list = null;
  let code = null;
  const flushParagraph = () => { if (paragraph.length) blocks.push({ type: "paragraph", text: paragraph.join("\n") }); paragraph = []; };
  const flushList = () => { if (list) blocks.push(list); list = null; };
  for (const line of lines) {
    if (/^```/.test(line)) {
      flushParagraph(); flushList();
      if (code) { blocks.push({ type: "code", text: code.lines.join("\n"), ...(code.language ? { language: code.language } : {}) }); code = null; }
      else code = { language: line.slice(3).trim().slice(0, 40), lines: [] };
      continue;
    }
    if (code) { code.lines.push(line); continue; }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const item = line.match(/^\s*(?:([-*])|(\d+)\.)\s+(.+)$/);
    if (heading) { flushParagraph(); flushList(); blocks.push({ type: "heading", level: heading[1].length === 3 ? 3 : 2, text: heading[2] }); }
    else if (item) { flushParagraph(); const ordered = Boolean(item[2]); if (list && list.ordered !== ordered) flushList(); if (!list) list = { type: "list", ordered, items: [] }; list.items.push(item[3]); }
    else if (/^>\s?/.test(line)) { flushParagraph(); flushList(); blocks.push({ type: "quote", text: line.replace(/^>\s?/, "") }); }
    else if (!line.trim()) { flushParagraph(); flushList(); }
    else { flushList(); paragraph.push(line); }
  }
  flushParagraph(); flushList();
  if (code) blocks.push({ type: "code", text: code.lines.join("\n"), ...(code.language ? { language: code.language } : {}) });
  return blocks;
}

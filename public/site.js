import {
  PUBLIC_LOCALES, FORMAT_SEGMENTS, parsePublicRoute, renderPublicPage,
  renderSiteHeader, renderSiteFooter, getPublicWords, languagePath, safePublicUrl, publicPageMetadata,
} from "./publication-view.js";

const main = document.querySelector("#site-main");
const header = document.querySelector("#site-header");
const footer = document.querySelector("#site-footer");
let pageController = new AbortController();
let route = parsePublicRoute(window.location.pathname);
let page = { profile: {}, listing: { items: [] }, detail: null };
let disposed = false;
let loadingMore = false;
let preview = false;
let gallery = [];
let galleryIndex = 0;
let galleryOrigin = null;
let languageOrigin = null;

async function requestPublic(path) {
  const response = await fetch(path, { credentials: "omit", signal: pageController.signal, headers: { Accept: "application/json" } });
  let payload;
  try { payload = await response.json(); }
  catch {
    const error = new Error("Public response is unavailable.");
    error.status = response.status;
    throw error;
  }
  if (!response.ok) {
    const error = new Error("Published content is unavailable.");
    error.status = response.status;
    error.code = payload?.error?.code;
    throw error;
  }
  return payload;
}

function contentPath(cursor) {
  const query = new URLSearchParams({ locale: route.locale, limit: "12" });
  if (route.format) query.set("format", route.format);
  if (cursor) query.set("cursor", cursor);
  return `/public-api/content?${query}`;
}

function render() {
  const w = getPublicWords(route.lang);
  document.documentElement.lang = route.locale;
  header.innerHTML = renderSiteHeader(route, page.detail);
  footer.innerHTML = renderSiteFooter(route);
  main.innerHTML = renderPublicPage(route, page);
  if (preview) {
    const notice = document.createElement("p");
    notice.className = "reading-notice";
    notice.setAttribute("role", "status");
    notice.textContent = route.lang === "en" ? "PRIVATE PREVIEW · This edition is not published. Review the exact text and media before granting public approval." : "私有预览 · 此页面不代表已经公开。请核对当前精确正文与素材，再独立批准官网发布。";
    main.prepend(notice);
  }
  if (page.profileError && !page.error) {
    const warning = document.createElement("p");
    warning.className = "profile-warning";
    warning.textContent = w.profileUnavailable;
    main.append(warning);
  }
  const metadata = publicPageMetadata(route, page, { preview });
  document.title = metadata.title;
  const description = document.querySelector('meta[name="description"]');
  if (description) description.content = metadata.description;
  bindMedia();
  scrollToFragment();
}

function scrollToFragment() {
  if (!window.location.hash) return;
  let id;
  try { id = decodeURIComponent(window.location.hash.slice(1)); }
  catch { return; }
  const target = document.getElementById(id);
  if (target && main.contains(target)) requestAnimationFrame(() => target.scrollIntoView({ block: "start" }));
}

function bindMedia() {
  for (const figure of main.querySelectorAll(".piece-figure")) {
    const image = figure.querySelector("img");
    const button = figure.querySelector("[data-enlarge-image]");
    const fallback = figure.querySelector(".image-fallback");
    if (!image || !fallback) continue;
    const failed = () => {
      image.hidden = true;
      if (button) button.hidden = true;
      fallback.hidden = false;
    };
    image.addEventListener("error", failed);
    image.addEventListener("load", () => {
      image.hidden = false;
      if (button) button.hidden = false;
      fallback.hidden = true;
    });
    if (image.complete && image.naturalWidth === 0) failed();
  }
  const w = getPublicWords(route.lang);
  for (const video of main.querySelectorAll("[data-public-video]")) {
    const player = video.closest(".watch-player");
    const status = player.querySelector("[data-video-status]");
    const failure = player.querySelector("[data-video-failure]");
    const showReady = () => { status.hidden = true; failure.hidden = true; };
    video.addEventListener("loadedmetadata", showReady);
    video.addEventListener("canplay", showReady);
    video.addEventListener("playing", showReady);
    video.addEventListener("ended", () => { if (!video.error) showReady(); });
    video.addEventListener("pause", () => { if (!video.error && status.textContent === w.videoBuffering) status.hidden = true; });
    video.addEventListener("seeked", () => { if (!video.error && (!video.paused || video.ended || status.textContent === w.videoBuffering)) status.hidden = true; });
    video.addEventListener("waiting", () => { if (!video.error && !video.paused && !video.ended) { status.textContent = w.videoBuffering; status.hidden = false; } });
    video.addEventListener("error", () => { status.hidden = true; failure.hidden = false; });
    const source = video.querySelector("source");
    source?.addEventListener("error", () => { status.hidden = true; failure.hidden = false; });
    for (const track of video.querySelectorAll("track")) track.addEventListener("error", () => {
      status.textContent = route.lang === "en" ? "Captions could not be loaded. The transcript is available below." : "字幕暂时无法载入，下方文稿仍可阅读。";
      status.hidden = false;
    });
    if (video.error) { status.hidden = true; failure.hidden = false; }
    else if (video.readyState >= 1) showReady();
  }
}

async function loadPage() {
  if (preview || disposed) return;
  page.error = null;
  if (!main.querySelector("[data-public-release], [data-public-archive], .about-page, .work-page")) {
    main.innerHTML = renderPublicPage(route, { loading: true });
  }
  const contentRequest = route.kind === "detail"
    ? requestPublic(`/public-api/content/${encodeURIComponent(route.locale)}/${encodeURIComponent(route.format)}/${encodeURIComponent(route.slug)}`)
    : ["home", "archive"].includes(route.kind) ? requestPublic(contentPath()) : Promise.resolve(null);
  const results = await Promise.allSettled([requestPublic("/public-api/profile"), contentRequest]);
  if (disposed) return;
  page.profileError = results[0].status === "rejected";
  if (results[0].status === "fulfilled") page.profile = results[0].value;
  if (results[1].status === "fulfilled") {
    if (route.kind === "detail") page.detail = results[1].value;
    else if (["home", "archive"].includes(route.kind)) {
      const listing = results[1].value;
      if (listing && Array.isArray(listing.items)) page.listing = listing;
      else page.error = { status: 502 };
    }
  } else page.error = { status: results[1].reason?.status || 0 };
  if (page.profileError && ["about", "work"].includes(route.kind)) page.error = { status: 0 };
  render();
}

async function loadMore(button) {
  const cursor = page.listing?.nextCursor;
  if (!cursor || loadingMore || disposed) return;
  loadingMore = true;
  const w = getPublicWords(route.lang);
  button.disabled = true;
  button.textContent = w.loadingMore;
  const status = main.querySelector("[data-more-status]");
  if (status) status.textContent = "";
  const previousCount = page.listing.items.length;
  try {
    const payload = await requestPublic(contentPath(cursor));
    if (!Array.isArray(payload.items)) throw new Error("Public response is unavailable.");
    const seen = new Set(page.listing.items.map(item => item.releaseId || item.id));
    page.listing = { ...payload, items: [...page.listing.items, ...payload.items.filter(item => !seen.has(item.releaseId || item.id))] };
    if (disposed) return;
    render();
    const added = main.querySelectorAll(".journal-results .journal-row")[previousCount];
    const focus = added?.querySelector("h3 a") || main.querySelector("[data-load-more]");
    focus?.focus({ preventScroll: true });
    const nextStatus = main.querySelector("[data-more-status]");
    if (nextStatus) nextStatus.textContent = route.lang === "en" ? "More published pieces loaded." : "已加载更多公开内容。";
  } catch (error) {
    if (!disposed && error.name !== "AbortError") {
      if (status) status.textContent = w.error;
      button.disabled = false;
      button.textContent = w.more;
    }
  } finally { loadingMore = false; }
}

const lightbox = document.querySelector("#image-lightbox");
const lightboxImage = document.querySelector("#lightbox-image");
const lightboxCaption = document.querySelector("#lightbox-caption");
const lightboxError = document.querySelector("#lightbox-error");

function showGalleryImage() {
  const item = gallery[galleryIndex];
  if (!item) return;
  const w = getPublicWords(route.lang);
  lightboxImage.hidden = false;
  lightboxError.hidden = true;
  lightboxImage.src = item.src;
  lightboxImage.alt = item.alt;
  lightboxCaption.textContent = `${galleryIndex + 1} / ${gallery.length}${item.caption ? ` · ${item.caption}` : ""}`;
  document.querySelector("#lightbox-title").textContent = `${w.imageCount} ${galleryIndex + 1} / ${gallery.length}`;
  lightbox.querySelector("[data-lightbox-previous]").disabled = galleryIndex <= 0;
  lightbox.querySelector("[data-lightbox-next]").disabled = galleryIndex >= gallery.length - 1;
  lightbox.querySelector("[data-lightbox-close]").setAttribute("aria-label", w.close);
}

function openGallery(button) {
  gallery = [...main.querySelectorAll("[data-enlarge-image]")].filter(item => !item.hidden).map(item => ({
    element: item, src: safePublicUrl(item.dataset.imageSrc), alt: item.dataset.imageAlt || "", caption: item.dataset.imageCaption || "",
  })).filter(item => item.src);
  galleryIndex = gallery.findIndex(item => item.element === button);
  if (galleryIndex < 0) return;
  galleryOrigin = button;
  showGalleryImage();
  if (!lightbox.open) lightbox.showModal();
  lightbox.querySelector("[data-lightbox-close]").focus();
}

lightboxImage.addEventListener("error", () => { lightboxImage.hidden = true; lightboxError.hidden = false; });
lightboxImage.addEventListener("load", () => { lightboxImage.hidden = false; lightboxError.hidden = true; });
lightbox.querySelector("[data-lightbox-close]").addEventListener("click", () => lightbox.close());
lightbox.querySelector("[data-lightbox-previous]").addEventListener("click", () => { if (galleryIndex > 0) { galleryIndex -= 1; showGalleryImage(); } });
lightbox.querySelector("[data-lightbox-next]").addEventListener("click", () => { if (galleryIndex < gallery.length - 1) { galleryIndex += 1; showGalleryImage(); } });
lightbox.addEventListener("keydown", event => {
  if (event.key === "ArrowLeft" && galleryIndex > 0) { event.preventDefault(); galleryIndex -= 1; showGalleryImage(); }
  if (event.key === "ArrowRight" && galleryIndex < gallery.length - 1) { event.preventDefault(); galleryIndex += 1; showGalleryImage(); }
});
lightbox.addEventListener("click", event => { if (event.target === lightbox) lightbox.close(); });
lightbox.addEventListener("close", () => { galleryOrigin?.focus({ preventScroll: true }); });

const languageDialog = document.querySelector("#language-dialog");
function showLanguageUnavailable(button) {
  const w = getPublicWords(route.lang);
  const target = button.dataset.languageUnavailable;
  languageOrigin = button;
  document.querySelector("#language-dialog-title").textContent = target === "en" ? w.noEnglish : w.noChinese;
  document.querySelector("#language-dialog-copy").textContent = w.translationNote;
  document.querySelector("#language-keep-reading").textContent = w.keepReading;
  const browse = document.querySelector("#language-browse");
  browse.textContent = `${w.browseOther} →`;
  browse.href = languagePath(target, route);
  languageDialog.showModal();
}
document.querySelector("#language-keep-reading").addEventListener("click", () => languageDialog.close());
languageDialog.addEventListener("close", () => languageOrigin?.focus({ preventScroll: true }));
languageDialog.addEventListener("click", event => { if (event.target === languageDialog) languageDialog.close(); });

main.addEventListener("click", async event => {
  const target = event.target.closest("button");
  if (!target) return;
  if (target.hasAttribute("data-load-more")) { await loadMore(target); return; }
  if (target.hasAttribute("data-retry-page")) { target.disabled = true; await loadPage(); return; }
  if (target.hasAttribute("data-enlarge-image")) { openGallery(target); return; }
  if (target.hasAttribute("data-retry-image")) {
    const figure = target.closest(".piece-figure");
    const image = figure.querySelector("img");
    target.disabled = true;
    const restore = () => { target.disabled = false; };
    image.addEventListener("load", restore, { once: true });
    image.addEventListener("error", restore, { once: true });
    image.src = image.getAttribute("src");
    return;
  }
  if (target.hasAttribute("data-retry-video")) {
    const player = target.closest(".watch-player");
    const video = player.querySelector("video");
    player.querySelector("[data-video-failure]").hidden = true;
    const status = player.querySelector("[data-video-status]");
    status.hidden = false;
    status.textContent = getPublicWords(route.lang).videoLoading;
    video.load();
    return;
  }
  if (target.hasAttribute("data-seek")) {
    const video = main.querySelector("[data-public-video]");
    if (!video) return;
    const value = Number(target.dataset.seek);
    if (!Number.isFinite(value) || value < 0) return;
    const seek = () => {
      try {
        video.currentTime = Number.isFinite(video.duration) ? Math.min(value, video.duration) : value;
        const status = video.closest(".watch-player").querySelector("[data-video-status]");
        status.textContent = getPublicWords(route.lang).seekReady;
        status.hidden = !video.paused;
        video.focus({ preventScroll: true });
      } catch {
        const failure = video.closest(".watch-player").querySelector("[data-video-failure]");
        failure.hidden = false;
      }
    };
    if (video.readyState >= 1) seek();
    else { video.addEventListener("loadedmetadata", seek, { once: true }); video.load(); }
  }
});
header.addEventListener("click", event => {
  const button = event.target.closest("[data-language-unavailable]");
  if (button) showLanguageUnavailable(button);
});

let seed = null;
const seedElement = document.querySelector("#site-data");
if (seedElement) {
  try { seed = JSON.parse(seedElement.textContent); }
  catch { seed = null; }
}
if (seed && typeof seed === "object" && !Array.isArray(seed)) {
  if (seed.preview === true && seed.route && PUBLIC_LOCALES[seed.route.lang] && FORMAT_SEGMENTS[seed.route.format]) {
    route = { ...seed.route, locale: PUBLIC_LOCALES[seed.route.lang], kind: "detail" };
    preview = true;
  }
  page = { profile: seed.profile || {}, listing: seed.listing || { items: [] }, detail: seed.detail || null, ...(seed.error ? { error: seed.error } : {}) };
  render();
} else {
  header.innerHTML = renderSiteHeader(route);
  footer.innerHTML = renderSiteFooter(route);
}
if (!preview) void loadPage();
window.addEventListener("pagehide", () => { disposed = true; pageController.abort(); });
window.addEventListener("pageshow", event => {
  if (!event.persisted) return;
  disposed = false;
  pageController = new AbortController();
  if (!preview) void loadPage();
});

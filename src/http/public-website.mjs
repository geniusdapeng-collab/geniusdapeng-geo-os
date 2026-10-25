import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ApiError } from "../domain/errors.mjs";
import {
  escapeHtml, parsePublicRoute, renderPublicPage, renderSiteHeader, renderSiteFooter,
  publicPageMetadata, languagePath,
} from "../../public/publication-view.js";

export function serializeSiteData(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function replaceRegion(html, name, content) {
  const expression = new RegExp(`<!--${name}-->[\\s\\S]*?<!--/${name}-->`);
  if (!expression.test(html)) throw new Error(`PUBLIC_TEMPLATE_REGION_MISSING:${name}`);
  return html.replace(expression, () => `<!--${name}-->${content}<!--/${name}-->`);
}

export function renderWebsiteDocument(template, route, data, { origin, preview = false } = {}) {
  const detail = data.detail;
  const { title, description } = publicPageMetadata(route, data, { preview });
  const canonicalPath = detail?.canonicalPath || languagePath(route.lang, route);
  const canonical = new URL(canonicalPath, origin).href;
  const alternates = detail ? detail.alternates || {} : {
    "zh-CN": new URL(languagePath("zh", route), origin).href,
    "en-US": new URL(languagePath("en", route), origin).href,
  };
  let head = `<link rel="canonical" href="${escapeHtml(canonical)}" />`;
  for (const [locale, url] of Object.entries(alternates)) {
    if (!["zh-CN", "en-US"].includes(locale)) continue;
    const target = new URL(url, origin);
    if (target.origin !== new URL(origin).origin) continue;
    head += `<link rel="alternate" hreflang="${locale}" href="${escapeHtml(target.href)}" />`;
  }
  head += `<meta property="og:type" content="${detail ? "article" : "website"}" /><meta property="og:title" content="${escapeHtml(title)}" /><meta property="og:description" content="${escapeHtml(description)}" /><meta property="og:url" content="${escapeHtml(canonical)}" />`;
  if (preview || data.error || route.kind === "not_found") head += '<meta name="robots" content="noindex, nofollow" />';
  let html = template.replace(/<html lang="[^"]*">/, `<html lang="${route.locale}">`)
    .replace(/<title>[\s\S]*?<\/title>/, () => `<title>${escapeHtml(title)}</title>`)
    .replace(/<meta name="description" content="[^"]*"\s*\/>/, () => `<meta name="description" content="${escapeHtml(description)}" />`)
    .replace("<!--site-head-->", () => head);
  html = replaceRegion(html, "site-header", renderSiteHeader(route, detail));
  html = replaceRegion(html, "site-content", `${preview ? `<p class="reading-notice" role="status">${route.lang === "en" ? "Private preview · Not a publication" : "私有预览 · 尚不代表已公开发布"}</p>` : ""}${renderPublicPage(route, data)}`);
  html = replaceRegion(html, "site-footer", renderSiteFooter(route));
  return html.replace('<script type="module" src="/site.js"></script>', () =>
    `<script id="site-data" type="application/json">${serializeSiteData({ route, ...data, ...(preview ? { preview: true } : {}) })}</script>\n<script type="module" src="/site.js"></script>`);
}

export function createPublicWebsite({ publicDir, editorial, service, securityHeaders }) {
  let templatePromise;
  const template = () => templatePromise ??= readFile(join(publicDir, "site.html"), "utf8").catch(error => { templatePromise = null; throw error; });
  return async function routeWebsite({ request, response, url, previewId = null }) {
    if (!editorial) return false;
    if (!previewId && url.pathname !== "/" && !/^\/(?:zh|en)(?:\/|$)/.test(url.pathname)) return false;
    if (!["GET", "HEAD"].includes(request.method)) throw new ApiError(405, "METHOD_NOT_ALLOWED", "页面仅支持 GET 和 HEAD。");
    if ([...url.searchParams].length) throw new ApiError(400, "PUBLIC_PAGE_QUERY_INVALID", "页面不接受查询参数。");
    let route = parsePublicRoute(url.pathname);
    const data = { profile: service.publicPreview(), listing: { items: [], total: 0, nextCursor: null } };
    let status = route.kind === "not_found" ? 404 : 200;
    if (previewId) {
      data.detail = editorial.previewRelease(previewId);
      route = parsePublicRoute(data.detail.canonicalPath);
      status = 200;
    } else if (route.kind === "detail") {
      try { data.detail = editorial.publicDetail({ locale: route.locale, format: route.format, slug: route.slug }); }
      catch (error) {
        if (!(error instanceof ApiError) || ![404, 410].includes(error.status)) throw error;
        status = error.status; data.error = { status, code: error.code };
      }
    } else if (["home", "archive"].includes(route.kind)) {
      data.listing = editorial.publicList({ locale: route.locale, format: route.format, limit: 20 });
    }
    const body = renderWebsiteDocument(await template(), route, data, { origin: editorial.publicOrigin, preview: Boolean(previewId) });
    response.writeHead(status, { ...securityHeaders(), "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(body), "Content-Language": route.locale,
      "Cache-Control": "no-store", ...(previewId ? { "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" } : {}) });
    response.end(request.method === "HEAD" ? undefined : body);
    return true;
  };
}

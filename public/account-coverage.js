const html = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");

// Account records and catalog platforms have different denominators. Archived
// identities remain registered history; they are never new setup placeholders.
export function summarizeAccountCoverage(accounts = [], catalog = null) {
  const catalogRows = Array.isArray(catalog) ? catalog : catalog?.platforms;
  const catalogAvailable = Array.isArray(catalogRows);
  const platforms = catalogAvailable ? [...new Map(catalogRows.map(row => [row.id, row])).values()] : [];
  const byId = new Map(platforms.map(row => [row.id, row]));
  const platformFor = account => {
    if (account.platformId) return byId.get(account.platformId);
    const legacy = byId.get(account.id);
    return legacy && [legacy.name, legacy.nameZh, legacy.nameEn].includes(account.platform) ? legacy : undefined;
  };
  const externalAccounts = accounts.filter(account => platformFor(account)?.kind !== "owned_site");
  const currentAccounts = externalAccounts.filter(account => account.status !== "archived");
  const archivedAccounts = externalAccounts.filter(account => account.status === "archived");
  const currentIds = new Set(currentAccounts.map(account => platformFor(account)?.id).filter(Boolean));
  const archivedIds = new Set(archivedAccounts.map(account => platformFor(account)?.id).filter(Boolean));
  const externalPlatforms = platforms.filter(platform => platform.kind !== "owned_site");
  const registeredPlatforms = externalPlatforms.filter(platform => currentIds.has(platform.id));
  const archivedPlatforms = externalPlatforms.filter(platform => !currentIds.has(platform.id) && archivedIds.has(platform.id));
  const unconfiguredPlatforms = externalPlatforms.filter(platform => !currentIds.has(platform.id) && !archivedIds.has(platform.id));
  const ownedSites = platforms.filter(platform => platform.kind === "owned_site");
  return {
    catalogAvailable, currentAccounts, archivedAccounts, registeredPlatforms, archivedPlatforms,
    unconfiguredPlatforms, ownedSites,
    unknownCurrentAccounts: currentAccounts.filter(account => !platformFor(account)),
    unknownArchivedAccounts: archivedAccounts.filter(account => !platformFor(account)),
    currentAWaveCount: currentAccounts.filter(account => account.wave === "A").length,
    catalogCount: catalogAvailable ? platforms.length : null,
    externalPlatformCount: catalogAvailable ? externalPlatforms.length : null,
    currentScopeCount: catalogAvailable ? registeredPlatforms.length + unconfiguredPlatforms.length + ownedSites.length : null,
  };
}

function platformName(platform) { return platform.nameZh || platform.name || platform.nameEn || platform.id; }

export function renderPlatformCoverage(coverage) {
  const { currentAccounts, archivedAccounts, registeredPlatforms, archivedPlatforms, unconfiguredPlatforms, ownedSites } = coverage;
  const scope = coverage.catalogAvailable
    ? `当前规划 ${coverage.currentScopeCount} 项（含待配置） · 完整目录 ${coverage.catalogCount} 项`
    : "平台目录尚未读取成功，规划范围暂不计算";
  const cards = [
    ["当前已登记", currentAccounts.length, coverage.catalogAvailable ? `${registeredPlatforms.length} 个目录平台` : "账号记录，不代表已登录"],
    ["已归档账号", archivedAccounts.length, "保留历史与回执"],
    ["未配置平台", coverage.catalogAvailable ? unconfiguredPlatforms.length : "—", "尚未登记真实账号"],
    ["自有官网", coverage.catalogAvailable ? ownedSites.length : "—", "目录阵地，单独于社媒账号"],
  ];
  const archived = archivedPlatforms.length
    ? `<p class="coverage-note">仅归档平台：${archivedPlatforms.map(platform => html(platformName(platform))).join("、")}。历史保留，不计入当前规划。</p>` : "";
  const unmatched = coverage.catalogAvailable && (coverage.unknownCurrentAccounts.length || coverage.unknownArchivedAccounts.length)
    ? `<p class="coverage-note">另有 ${coverage.unknownCurrentAccounts.length} 个当前账号、${coverage.unknownArchivedAccounts.length} 个归档账号未匹配目录；账号数照实保留，未计入目录平台覆盖。</p>` : "";
  const missing = unconfiguredPlatforms.length
    ? `<p class="coverage-note">待登记：${unconfiguredPlatforms.map(platform => html(platformName(platform))).join("、")}。</p>` : "";
  return `<article class="panel platform-coverage" aria-label="平台覆盖与账号口径"><div class="panel-heading"><h3>平台覆盖</h3><span>${html(scope)}</span></div><div class="coverage-grid">${cards.map(([label, count, note]) => `<div><span>${html(label)}</span><strong>${html(count)}</strong><small>${html(note)}</small></div>`).join("")}</div>${missing}${archived}${unmatched}<p class="coverage-note">账号数按真实记录计算，平台数按目录去重；登记、启用与平台已登录分别核对。</p></article>`;
}

export function renderUnconfiguredPlatforms(coverage) {
  const platforms = coverage.unconfiguredPlatforms;
  if (!coverage.catalogAvailable) return '<section class="panel unconfigured-platforms"><h3>未配置平台</h3><p class="coverage-note" role="status">平台目录尚未读取成功，暂不判断哪些平台缺少账号。可用顶部“刷新数据”重试。</p></section>';
  return `<section class="panel unconfigured-platforms" aria-label="尚未配置的平台目录"><div class="panel-heading"><h3>未配置平台 · ${platforms.length}</h3><a class="text-link" href="#editorial">去编辑出版登记真实账号 →</a></div><p class="coverage-note">以下仅为平台目录占位，尚未登记真实账号。账号 handle、主页和身份须实际核对后填写。</p>${platforms.length ? `<div class="unconfigured-grid">${platforms.map(platform => `<article class="unconfigured-card" data-unconfigured-platform="${html(platform.id)}"><span class="policy">待登记</span><h4>${html(platformName(platform))}</h4><p>${html(platform.role || "按实际目标确定用途后，再登记真实账号。")}</p></article>`).join("")}</div>` : '<p class="coverage-note">当前目录没有缺少账号记录的外部平台；仅归档平台仍在历史中，不自动恢复。</p>'}</section>`;
}

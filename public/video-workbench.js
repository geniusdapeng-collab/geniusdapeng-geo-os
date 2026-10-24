const escapeHtml = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
const stateLabels = { "not-installed": "尚未安装", stopped: "已停止", "setting-up": "安装中", starting: "启动中", ready: "工作台就绪", stopping: "停止中", error: "需要处理" };
const dependencyLabels = { unchecked: "待诊断", ready: "依赖就绪", missing: "缺少依赖", blocked: "受限" };
const validationLabels = { unverified: "未验证产出", passed: "验证通过", failed: "验证失败" };
const categoryLabels = { available: "入口可用", "dependency-missing": "缺少依赖", starting: "启动中", unverified: "待验证" };
const kinds = { roles: "数字员工", skills: "技能", tools: "工具", capabilities: "能力", installers: "安装与依赖" };
const PAGE_SIZE = 20;

export function filterCatalog(rows, query, dependency) {
  const needle = String(query).trim().toLocaleLowerCase();
  return rows.filter(row => (dependency === "all" || row.status?.dependencyState === dependency)
    && (!needle || JSON.stringify(row).toLocaleLowerCase().includes(needle)));
}

function catalogRowHtml(row) {
  const states = row.status ?? {};
  const bindings = Object.values(row.bindings ?? {}).flat();
  return `
    <details class="video-catalog-row">
      <summary>
        <div><strong>${escapeHtml(row.name || row.id)}</strong><small>${escapeHtml(row.id)} · ${escapeHtml(row.bundle || row.bundles?.join(" / "))}</small></div>
        <span class="video-row-status">${escapeHtml(dependencyLabels[states.dependencyState] || "待诊断")} · ${escapeHtml(validationLabels[states.validated] || "未验证产出")}</span>
      </summary>
      <div class="video-catalog-detail">
        <p>${escapeHtml(row.description || "暂无说明")}</p>
        <div class="meta-row">
          <span class="meta">${states.declared ? "已声明" : "未声明"}</span>
          <span class="meta">${states.codePresent ? "有代码证据" : "待核实实现"}</span>
          <span class="meta">证据 ${escapeHtml(row.evidence)}</span>
        </div>
        <p>${escapeHtml(states.reason)}</p>
        ${row.runtimePresetKey ? `<h4>运行岗位</h4><p><code>${escapeHtml(row.runtimePresetKey)}</code>${row.runtimeIdentity?.alias ? " · 同名岗位分别保留各自职责、技能和工具" : ""}</p>` : ""}
        ${row.fenceBindings?.length ? `<h4>审批与操作边界</h4><p>${row.readonly ? "只读" : "按原生围栏执行"} · ${escapeHtml(row.fenceBindings.join("、"))}</p>` : ""}
        ${row.dependencies?.length ? `<h4>依赖</h4><ul>${row.dependencies.map(item => `<li>${escapeHtml(item.id)}：${escapeHtml(item.reason)}${item.installId ? `（安装项 ${escapeHtml(item.installId)}）` : ""}</li>`).join("")}</ul>` : ""}
        ${bindings.length ? `<h4>相关绑定</h4><p>${escapeHtml(bindings.join(" · "))}</p>` : ""}
        ${row.entrypoints?.length ? `<h4>原生入口</h4><ul>${row.entrypoints.map(item => `<li><code>${escapeHtml(item.kind)} · ${escapeHtml(item.path)} ${escapeHtml(item.method)}</code></li>`).join("")}</ul>` : ""}
        ${row.sourcePaths?.length ? `<h4>源码依据</h4><p class="video-source-paths">${row.sourcePaths.map(item => `<code>${escapeHtml(item)}</code>`).join(" ")}</p>` : ""}
        ${row.command ? `<h4>本地安装命令</h4><code>${escapeHtml(row.command)}</code>` : ""}
        ${row.licenseBoundary ? `<p>${escapeHtml(row.licenseBoundary)}</p>` : ""}
        <p>测试：${escapeHtml(validationLabels[row.tests?.executed] || "未验证产出")}${row.tests?.report ? ` · ${escapeHtml(row.tests.report)}` : ""}</p>
      </div>
    </details>
  `;
}

function categoryHtml(item, ready) {
  const label = item.status === "available" && !ready ? "工作台未就绪" : categoryLabels[item.status] || "待验证";
  return `
    <article class="video-category-card">
      <span class="eyebrow">${escapeHtml(label)}</span><h3>${escapeHtml(item.label)}</h3>
      <p>${item.missing?.length ? `需要：${escapeHtml(item.missing.join("、"))}` : "进入原生工作台查看具体项目、工位与生产回执。"}</p>
    </article>
  `;
}

function stationHtml(item) {
  const label = item.ready ? "依赖与进程就绪" : item.installed ? "已安装，尚未就绪" : "需要安装";
  let licenseText = "";
  if (typeof item.license === "string") licenseText = `许可：${item.license}`;
  else if (item.license) {
    const scope = { noncommercial: "非商业使用", authorized: "声明商业授权范围", unverified: "范围待核实" }[item.license.scope] || "范围待核实";
    const permission = item.license.commercialReady === true
      ? "商业使用许可核验已通过，具体任务仍按审批和预算执行"
      : item.license.commercialGrantPresent === true
        ? "已提供授权材料，商业使用尚未通过许可核验"
        : "尚无商业授权材料，商业使用未就绪";
    licenseText = `当前许可：${scope}。${permission}。`;
  }
  return `
    <article class="video-station-card">
      <span class="adapter-state ${item.ready ? "" : "offline"}">${label}</span>
      <h4>${escapeHtml(item.label || item.id)}</h4>
      <p>${item.missing?.length ? escapeHtml(item.missing.join("；")) : item.running ? "本机受管进程运行中" : "等待任务或本地环境诊断"}</p>
      <small>${item.productionVerified ? "已有独立产出验证，具体任务仍以回执为准" : "尚未验证实际生成或媒体质量"}</small>
      ${licenseText ? `<p>${escapeHtml(licenseText)}</p>` : ""}
    </article>
  `;
}

export function initializeVideoWorkbench() {
  const element = id => document.getElementById(id);
  let status = null;
  let capabilities = null;
  let page = 0;
  let controller = null;
  let timer = null;
  let disposed = false;

  function renderCatalog() {
    const kind = element("video-catalog-kind").value;
    const rows = capabilities?.catalog?.[kind] ?? [];
    const filtered = filterCatalog(rows, element("video-catalog-search").value, element("video-catalog-dependency").value);
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    page = Math.max(0, Math.min(page, pages - 1));
    element("video-catalog-count").textContent = `${kinds[kind]}：${filtered.length} 项匹配 / 完整目录 ${rows.length} 项`;
    element("video-catalog-page").textContent = `${page + 1} / ${pages}`;
    element("video-catalog-prev").disabled = page === 0;
    element("video-catalog-next").disabled = page >= pages - 1;
    element("video-catalog-list").innerHTML = filtered.length
      ? filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(catalogRowHtml).join("")
      : `<div class="empty-panel">${capabilities ? "没有匹配项，试试其他名称或依赖状态。" : "完整目录尚不可用，请运行本地诊断。"}</div>`;
  }

  function renderRuntime() {
    const runtimeState = status?.state ?? "error";
    element("video-runtime-badge").textContent = stateLabels[runtimeState] || "状态未知";
    element("video-runtime-badge").className = `status-chip ${status?.ready ? "published" : "draft"}`;
    const link = element("video-open-workbench");
    link.hidden = !status?.ready || !status?.workbenchUrl;
    if (link.hidden) link.removeAttribute("href");
    else link.href = status.workbenchUrl;
    const copy = {
      "not-installed": "视频环境尚未安装。完成本地安装后，系统会自行管理数据库和生产服务。",
      stopped: "视频服务已停止。启动鹏经理系统后会自动启动独立视频工作台。",
      "setting-up": "正在准备本地依赖，现有 GEO 与内容工作流仍可使用。",
      starting: "正在启动独立数据库和视频服务，请稍候。",
      stopping: "正在安全停止视频服务。",
      ready: "独立视频数据库与服务已就绪。供应商、工位与各项任务仍以具体诊断和真实回执为准。",
      error: status?.errorSafe || "视频服务未就绪，请运行本地诊断。",
    };
    element("video-runtime-copy").textContent = copy[runtimeState] || copy.error;
    element("video-category-grid").innerHTML = (capabilities?.categories ?? []).map(item => categoryHtml(item, status?.ready)).join("")
      || '<div class="empty-panel">分类状态将在完整目录可用后显示。</div>';
    const inventory = capabilities?.inventory;
    element("video-inventory").innerHTML = inventory ? [["数字员工", inventory.roleCount], ["技能", inventory.skillCount], ["工具", inventory.toolCount], ["受控源码文件", inventory.fileCount]].map(([label, value]) => `<article class="stat-card"><span>${label}</span><strong>${escapeHtml(value)}</strong><small>本地完整清单 · 不代表已运行</small></article>`).join("") : "";
    element("video-station-grid").innerHTML = capabilities?.tools?.length ? capabilities.tools.map(stationHtml).join("")
      : '<div class="empty-panel">尚无本机工位诊断结果。完整代码目录保留在下方；请完成本地安装和诊断。</div>';
    const pin = capabilities?.sourceMain || status?.sourceMain;
    element("video-catalog-evidence").textContent = pin ? `内置来源 ${pin.slice(0, 12)} · 目录证据与实际产出分开记录` : "目录不代表实际生成成功";
    renderCatalog();
  }

  async function request(path, signal) {
    const response = await fetch(path, { signal, headers: { Accept: "application/json" } });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.message || "视频状态读取失败");
    return payload;
  }

  async function refresh() {
    if (disposed) return;
    clearTimeout(timer);
    controller?.abort();
    const current = new AbortController();
    controller = current;
    element("video-refresh").disabled = true;
    element("video-refresh").textContent = "读取中…";
    const results = await Promise.allSettled([
      request("/api/video-runtime/status", current.signal), request("/api/video-runtime/capabilities", current.signal),
    ]);
    if (disposed || current.signal.aborted || controller !== current) return;
    status = results[0].status === "fulfilled" ? results[0].value : null;
    capabilities = results[1].status === "fulfilled" ? results[1].value : null;
    const errors = results.filter(item => item.status === "rejected").map(item => item.reason.message);
    element("video-error").hidden = errors.length === 0;
    element("video-error").textContent = [...new Set(errors)].join("；");
    renderRuntime();
    element("video-refresh").disabled = false;
    element("video-refresh").textContent = "刷新视频状态";
    timer = setTimeout(refresh, status?.ready ? 30000 : 5000);
  }

  element("video-refresh").addEventListener("click", refresh);
  element("video-catalog-form").addEventListener("submit", event => event.preventDefault());
  for (const id of ["video-catalog-kind", "video-catalog-search", "video-catalog-dependency"]) element(id).addEventListener(id === "video-catalog-search" ? "input" : "change", () => { page = 0; renderCatalog(); });
  element("video-catalog-prev").addEventListener("click", () => { page -= 1; renderCatalog(); });
  element("video-catalog-next").addEventListener("click", () => { page += 1; renderCatalog(); });
  window.addEventListener("pagehide", () => { disposed = true; clearTimeout(timer); controller?.abort(); }, { once: true });
  refresh();
  return { refresh };
}

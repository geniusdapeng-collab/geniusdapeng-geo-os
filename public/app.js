import { initializeVideoWorkbench } from "./video-workbench.js";
import { mountOperations } from "/operations.js";
import { mountFinalBackup } from "./final-backup-browser.js";
import { mountEditorialWorkbench } from "./editorial-workbench.js";

const state = {
  data: null,
  engineSummary: null,
  engineSamples: [],
  mediaJobs: [],
  view: "overview",
};

const statusLabels = {
  draft: "草稿",
  fact_check: "事实核验",
  approved: "已批准",
  scheduled: "已排期",
  published: "已发布",
  blocked: "已阻断",
  archived: "已归档",
};

const claimLabels = {
  draft: "待整理",
  verified: "待批准",
  approved: "已批准",
  retired: "已退役",
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  if (response.status === 401) {
    window.location.replace("/login");
    throw new Error("登录已过期，请重新登录管理后台。");
  }
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error?.message || "请求失败");
    error.status = response.status;
    error.code = payload.error?.code;
    error.details = payload.error?.details;
    throw error;
  }
  return payload;
}

function showError(error) {
  const banner = document.querySelector("#global-error");
  banner.textContent = error?.message || String(error);
  banner.hidden = false;
}

function clearError() {
  const banner = document.querySelector("#global-error");
  banner.hidden = true;
  banner.textContent = "";
}

function setLoading(loading) {
  document.querySelector("#loading").hidden = !loading;
  document.querySelector("#app").hidden = loading;
}

function renderStats() {
  const { metrics } = state.data;
  const pendingClaims = state.data.claims.filter((item) => item.state !== "approved").length;
  const pendingContent = state.data.content.filter((item) =>
    ["draft", "fact_check"].includes(item.status),
  ).length;
  const cards = [
    {
      label: "平台账号",
      value: state.data.accounts.length,
      note: `${state.data.accounts.filter((item) => item.wave === "A").length} 个 A 波入口`,
    },
    {
      label: "待批准事实",
      value: pendingClaims,
      note: `${state.data.claims.length} 条 Claim`,
    },
    {
      label: "待推进内容",
      value: pendingContent,
      note: `${state.data.contentBank.length} 条选题储备`,
    },
    {
      label: "合格 GEO 样本",
      value: metrics.qualifiedSamples,
      note: metrics.qualifiedSamples ? "real + imported" : "尚未产生效果结论",
    },
  ];
  document.querySelector("#stat-grid").innerHTML = cards
    .map(
      (card) => `
        <article class="stat-card">
          <span>${escapeHtml(card.label)}</span>
          <strong>${escapeHtml(card.value)}</strong>
          <small>${escapeHtml(card.note)}</small>
        </article>
      `,
    )
    .join("");
}

function renderStatusList(selector, counts, labels) {
  const max = Math.max(1, ...Object.values(counts));
  document.querySelector(selector).innerHTML = Object.entries(labels)
    .filter(([key]) => Object.hasOwn(counts, key))
    .map(([key, label]) => {
      const count = counts[key] || 0;
      const width = Math.max(4, (count / max) * 100);
      return `
        <div class="status-row">
          <span>${escapeHtml(label)}</span>
          <span class="status-track"><span class="status-fill" style="width:${width}%"></span></span>
          <strong>${count}</strong>
        </div>
      `;
    })
    .join("");
}

function primaryProfile() {
  const entity = state.data.entity ?? {};
  const nameZh = entity.nameZh || entity.publicName || "李大鹏";
  const nameEn = entity.nameEn || entity.englishName || "PengManager";
  const displayNameZh = entity.displayNameZh || entity.displayName || `${nameZh}｜用AI搞经营的产品经理`;
  const displayNameEn = entity.displayNameEn || entity.englishDisplayName || `Dapeng Li · ${nameEn}`;
  return {
    nameZh,
    nameEn,
    displayNameZh,
    displayNameEn,
    bioZh: entity.bioZh || entity.bio || `${displayNameZh}\n\n全栈 AI 产品专家，把模型能力做成专业领域 Agent 数字员工与自主经营系统。`,
    bioEn: entity.bioEn || entity.englishBio || `${displayNameEn}\n\nTurning model capabilities into domain-specific AI employees and autonomous business systems.`,
  };
}

function renderIdentity() {
  const system = state.data.system ?? {};
  const nameZh = system.nameZh || "鹏经理系统";
  const nameEn = system.nameEn || "PengManager System";
  const profile = primaryProfile();
  for (const selector of ["#brand-name", "#system-name"]) {
    document.querySelector(selector).textContent = nameZh;
  }
  for (const selector of ["#brand-name-en", "#system-name-en"]) {
    document.querySelector(selector).textContent = nameEn;
  }
  document.title = `${nameZh} · ${nameEn}`;
  document.querySelector('meta[name="application-name"]').content = nameZh;
  document.querySelector("#account-byline").textContent = profile.displayNameZh;
  const fields = {
    "#identity-name-zh": profile.nameZh,
    "#identity-name-en": profile.nameEn,
    "#identity-display-zh": profile.displayNameZh,
    "#identity-display-en": profile.displayNameEn,
    "#identity-bio-zh": profile.bioZh,
    "#identity-bio-en": profile.bioEn,
  };
  for (const [selector, value] of Object.entries(fields)) {
    document.querySelector(selector).textContent = value;
  }
}

function renderOverview() {
  renderIdentity();
  renderStats();
  document.querySelector("#revision-label").textContent =
    `账本版本 r${state.data.revision} · 事件头 ${state.data.eventHead?.slice(0, 10) ?? "GENESIS"}`;
  renderStatusList("#content-status", state.data.summary.statusCounts ?? {}, statusLabels);
  renderStatusList("#claim-status", state.data.summary.claimCounts ?? {}, claimLabels);
}

async function loadAdapterHealth() {
  const target = document.querySelector("#adapter-grid");
  try {
    const health = await api("/api/adapters/health");
    const labels = {
      deepSeek: "DeepSeek 模型",
      github: "GitHub API",
      geoEvidence: "GeoEvidence",
      videoEdit: "video-edit",
      mediaEngine: "媒体渲染引擎",
    };
    target.innerHTML = Object.entries(health)
      .map(([name, item]) => {
        const ok = item?.ok === true;
        const detail =
          name === "deepSeek"
            ? item.model || item.baseUrl
            : name === "github"
              ? item.repository
            : name === "geoEvidence"
                ? item.caseId || item.health?.case || item.baseUrl || item.mode
                : name === "mediaEngine"
                  ? item.ffmpeg
                  : `${item.topics ?? 0} topics · ${item.platformDrifts?.length ?? 0} drifts`;
        return `
          <div class="adapter-card">
            <span class="adapter-state ${ok ? "" : "offline"}">${ok ? "已连接" : "未就绪"}</span>
            <strong>${escapeHtml(labels[name] || name)}</strong>
            <small>${escapeHtml(detail || item.error || "未配置")}</small>
          </div>
        `;
      })
      .join("");
  } catch (error) {
    target.innerHTML = `<div class="empty-panel">${escapeHtml(error.message)}</div>`;
  }
}

function renderAccounts() {
  const template = document.querySelector("#account-card-template");
  const grid = document.querySelector("#account-grid");
  grid.replaceChildren();
  const accounts = state.data.accounts.filter(account => account.status !== "archived");
  document.querySelector("#account-matrix-label").textContent = `${accounts.length} 个当前登记账号 · 不代表平台已登录`;
  if (accounts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-panel";
    empty.textContent = "暂无当前运营账号。可以在编辑出版登记真实账号或查看已归档历史。";
    grid.append(empty);
    return;
  }

  const profile = primaryProfile();
  for (const account of accounts) {
    const card = template.content.firstElementChild.cloneNode(true);
    card.dataset.accountId = account.id;
    const english = String(account.language ?? "").toLowerCase().startsWith("en");
    const name = english
      ? account.nameEn || account.englishName || profile.nameEn
      : account.nameZh || account.publicName || profile.nameZh;
    const displayName = account.displayName || (english
      ? account.displayNameEn || account.englishDisplayName || profile.displayNameEn
      : account.displayNameZh || profile.displayNameZh);
    const bio = account.bio || (english
      ? account.bioEn || account.englishBio || profile.bioEn
      : account.bioZh || profile.bioZh);
    card.querySelector(".wave").textContent = account.wave ? `${account.wave} 波` : "新登记";
    const policy = card.querySelector(".policy");
    policy.textContent = account.policyStatus === "reviewed" ? "规则已审阅" : "规则待审阅";
    policy.classList.toggle("reviewed", account.policyStatus === "reviewed");
    card.querySelector("h3").textContent = account.platform;
    card.querySelector(".handle").textContent = account.handle;
    const accountProfile = card.querySelector(".account-profile");
    accountProfile.lang = english ? "en" : "zh-CN";
    card.querySelector(".account-name").textContent = name;
    card.querySelector(".account-display-name").textContent = displayName;
    card.querySelector(".account-bio").textContent = bio;
    card.querySelector(".focus").textContent = account.contentFocus || "按每个渠道版本的真实目标填写";
    card.querySelector(".audience").textContent = account.audience || "尚未登记读者定位";
    card.querySelector(".cadence").textContent = account.cadence || "按每次批准的排期执行";
    card.querySelector(".mode").textContent = `${account.publishMode || "按具体动作授权"} · ${{ active: "已启用", draft: "未启用", paused: "已暂停" }[account.status] || account.status} · ${account.identityReview?.status === "verified" ? "身份已核对" : "身份待核对"}`;
    grid.append(card);
  }
}

function renderContent() {
  const contentList = document.querySelector("#content-list");
  if (state.data.content.length === 0) {
    contentList.innerHTML =
      '<div class="empty-panel">还没有内容。先批准事实，再建立第一条内容 Brief。</div>';
  } else {
    contentList.innerHTML = state.data.content
      .map(
        (content) => `
          <article class="content-card" data-content-id="${escapeHtml(content.id)}">
            <div>
              <h3>${escapeHtml(content.title)}</h3>
              <p>${escapeHtml(content.body.slice(0, 240))}${content.body.length > 240 ? "…" : ""}</p>
              <details class="content-full-text"><summary>查看完整正文</summary><div class="operation-body">${escapeHtml(content.body)}</div></details>
              <div class="meta-row">
                <span class="meta">${escapeHtml(content.contentType)}</span>
                ${content.claimIds.map((id) => `<span class="meta">${escapeHtml(id)}</span>`).join("")}
                ${content.platforms.map((item) => `<span class="meta">${escapeHtml(item)}</span>`).join("")}
              </div>
            </div>
            <span class="status-chip ${escapeHtml(content.status)}">${escapeHtml(
              statusLabels[content.status] || content.status,
            )}</span>
          </article>
        `,
      )
      .join("");
  }

  const bank = state.data.contentBank;
  document.querySelector("#content-bank-list").innerHTML =
    bank.length === 0
      ? '<div class="empty-panel">尚未导入初始选题库。</div>'
      : bank
          .slice(0, 12)
          .map(
            (item) => `
              <div class="bank-row">
                <code>${escapeHtml(item.id)}</code>
                <p>${escapeHtml(item.title || item["内容题目"] || item.topic)}</p>
                <span>${escapeHtml(item.priority || item["优先级"] || "P1")}</span>
              </div>
            `,
          )
          .join("");
}

function renderGeo() {
  const metrics = state.engineSummary?.metrics ?? state.data.metrics;
  const statusCopy = document.querySelector("#geo-status-copy");
  if (statusCopy) {
    statusCopy.textContent =
      (metrics.successfulSamples ?? metrics.qualifiedSamples ?? 0) > 0
        ? `${metrics.successfulSamples ?? metrics.qualifiedSamples} 条 real/imported 样本 · 结论仍需结合样本量判断`
        : "没有 real 或 imported 样本，不输出效果结论。";
  }
  const formatRate = (value) =>
    typeof value === "number" && Number.isFinite(value)
      ? `${Math.round(value * 100)}%`
      : "—";
  const cards = [
    ["实体提及率", formatRate(metrics.mentionRate), "合格样本"],
    ["自有来源引用率", formatRate(metrics.ownedCitationRate), "GitHub / CNB / 官网"],
    [
      "负面提及率",
      formatRate(metrics.negativeMentionRate ?? metrics.brandNegativeMentionRate),
      "需人工复盘",
    ],
    [
      "查询覆盖率",
      formatRate(metrics.queryCoverage ?? state.engineSummary?.queryCoverage),
      `${metrics.observedQueries ?? state.engineSummary?.observedQueries ?? 0}/${metrics.totalQueries ?? state.engineSummary?.totalQueries ?? 0}`,
    ],
  ];
  document.querySelector("#geo-metrics").innerHTML = cards
    .map(
      ([label, value, note]) => `
        <article class="stat-card">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
          <small>${escapeHtml(note)}</small>
        </article>
      `,
    )
    .join("");

  document.querySelector("#query-list").innerHTML = state.data.queries
    .slice(0, 12)
    .map(
      (query) => `
        <div class="query-row">
          <code>${escapeHtml(query.id)}</code>
          <p>${escapeHtml(query.text)}</p>
          <span>${escapeHtml(query.priority)}</span>
        </div>
      `,
    )
    .join("");

  const observations =
    state.engineSamples.length > 0
      ? state.engineSamples
      : state.data.observations;
  document.querySelector("#observation-list").innerHTML =
    observations.length === 0
      ? '<div class="empty-panel">尚无采样。fixture 只能验证流程，不能证明效果。</div>'
      : observations
          .slice(-8)
          .reverse()
          .map(
            (observation) => `
              <div class="query-row">
                <code>${escapeHtml(observation.dataMode ?? observation.data_mode)}</code>
                <p>${escapeHtml(observation.surface ?? observation.platform)} · ${
                  (observation.derived?.mentioned ?? observation.analysis?.brandMentioned)
                    ? "提及实体"
                    : "未提及"
                }</p>
                <span>${escapeHtml(
                  observation.derived?.ownedCitationCount ??
                    observation.analysis?.ownedCitations?.length ??
                    0,
                )} 个自有引用</span>
              </div>
            `,
          )
          .join("");
}

function renderIntegratedEngines() {
  const engineMetrics = state.engineSummary?.metrics;
  const target = document.querySelector("#geo-engine-grid");
  if (target) {
    if (!engineMetrics) {
      target.innerHTML =
        '<div class="empty-panel">个人 GEO 引擎尚无运行样本。</div>';
    } else {
      const pct = (value) =>
        value === null || value === undefined ? "—" : `${Math.round(value * 100)}%`;
      const cards = [
        [
          "证据成功率",
          pct(engineMetrics.successRate),
          `${engineMetrics.successfulSamples}/${engineMetrics.totalSamples} 样本`,
        ],
        [
          "实体提及率",
          pct(engineMetrics.mentionRate),
          "95% CI " +
            `${pct(engineMetrics.mentionRate95?.low)}–${pct(engineMetrics.mentionRate95?.high)}`,
        ],
        [
          "引用覆盖率",
          pct(engineMetrics.citationPresenceRate),
          "真实回答中可追溯来源",
        ],
        [
          "品牌负面率",
          pct(engineMetrics.brandNegativeMentionRate),
          `${engineMetrics.brandNegativeSamples} 个提及样本`,
        ],
      ];
      target.innerHTML = cards
        .map(
          ([label, value, note]) => `
            <article class="stat-card">
              <span>${escapeHtml(label)}</span>
              <strong>${escapeHtml(value)}</strong>
              <small>${escapeHtml(note)}</small>
            </article>
          `,
        )
        .join("");
    }
  }

  const jobs = document.querySelector("#media-jobs");
  if (jobs) {
    jobs.innerHTML =
      state.mediaJobs.length === 0
        ? '<div class="empty-panel">还没有完成过媒体任务。</div>'
        : state.mediaJobs
            .map(
              (job) => `
                <article class="content-card">
                  <div>
                    <h3>${escapeHtml(job.title)}</h3>
                    <p>${escapeHtml(job.platform)} · ${escapeHtml(job.variants.join(" / "))}</p>
                    <div class="meta-row">
                      <span class="meta">${escapeHtml(job.jobId)}</span>
                      <span class="meta">${job.outputCount} 个媒体产物</span>
                      <span class="meta">${escapeHtml(job.finalDir)}</span>
                    </div>
                  </div>
                  <span class="status-chip published">${escapeHtml(job.status)}</span>
                </article>
              `,
            )
            .join("");
  }
}

async function loadIntegratedEngineData() {
  const [engineSummary, engineSamples, mediaJobs] = await Promise.all([
    api("/api/geo/engine/summary"),
    api("/api/geo/engine/samples?limit=20"),
    api("/api/media/jobs"),
  ]);
  state.engineSummary = engineSummary;
  state.engineSamples = engineSamples;
  state.mediaJobs = mediaJobs;
  renderGeo();
  renderIntegratedEngines();
}

function populateContentForm() {
  const claimSelect = document.querySelector('#content-form select[name="claimId"]');
  const platformSelect = document.querySelector('#content-form select[name="platform"]');
  claimSelect.innerHTML =
    '<option value="">不绑定（仅纯观点）</option>' +
    state.data.claims
      .map(
        (claim) =>
          `<option value="${escapeHtml(claim.id)}">${escapeHtml(claim.id)} · ${escapeHtml(
            `${claim.state === "approved" ? "已批准" : "待批准"} · ${claim.text.slice(0, 52)}`,
          )}</option>`,
      )
      .join("");
  platformSelect.innerHTML = state.data.accounts.filter(account => account.status !== "archived")
    .map(
      (account) =>
        `<option value="${escapeHtml(account.platform)}">${escapeHtml(account.platform)}</option>`,
    )
    .join("");
}

function renderAll() {
  renderOverview();
  renderAccounts();
  renderContent();
  renderGeo();
  populateContentForm();
  operationsUi.render();
  editorialUi.render();
}

function switchView(view) {
  if (![...document.querySelectorAll(".nav-item")].some((button) => button.dataset.view === view)) return;
  state.view = view;
  for (const button of document.querySelectorAll(".nav-item")) {
    button.classList.toggle("active", button.dataset.view === view);
  }
  for (const section of document.querySelectorAll(".view")) {
    const active = section.id === `view-${view}`;
    section.hidden = !active;
    section.classList.toggle("active", active);
  }
  if (window.location.hash !== `#${view}`) window.location.hash = view;
}

async function loadAuthStatus() {
  const status = await api("/api/auth/status");
  document.querySelector("#logout").hidden = !(status.enabled && status.authenticated);
}

function requestedView() {
  const value = window.location.hash.replace(/^#/, "") || "overview";
  return [...document.querySelectorAll(".nav-item")].some(button => button.dataset.view === value) ? value : "overview";
}

async function loadData() {
  clearError();
  setLoading(true);
  const refresh = document.querySelector("#refresh");
  refresh.disabled = true;
  refresh.textContent = "正在刷新…";
  try {
    state.data = await api("/api/bootstrap");
    await operationsUi.load();
    renderAll();
    void finalBackup.sync();
    setLoading(false);
    switchView(requestedView());
    const secondary = await Promise.allSettled([loadIntegratedEngineData(), loadAdapterHealth(), loadAuthStatus(), editorialUi.load()]);
    for (const result of secondary) if (result.status === "rejected") showError(result.reason);
  } catch (error) {
    showError(error);
  } finally {
    setLoading(false);
    refresh.disabled = false;
    refresh.textContent = "刷新数据";
  }
}

for (const button of document.querySelectorAll(".nav-item")) {
  button.addEventListener("click", () => switchView(button.dataset.view));
}

window.addEventListener("hashchange", () => switchView(requestedView()));

document.querySelector("#refresh").addEventListener("click", loadData);
document.querySelector("#logout").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "正在退出…";
  try {
    await api("/api/auth/logout", { method: "POST", body: "{}" });
    window.location.replace("/login");
  } catch (error) {
    showError(error);
    button.disabled = false;
    button.textContent = "退出登录";
  }
});

document.querySelector("#open-content-form").addEventListener("click", () => {
  document.querySelector("#content-form").hidden = false;
  document.querySelector('#content-form input[name="title"]').focus();
});

document.querySelector("#cancel-content-form").addEventListener("click", () => {
  document.querySelector("#content-form").hidden = true;
});

document.querySelector("#content-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const claimId = String(form.get("claimId") || "");
  const contentType = String(form.get("contentType"));
  const button = formElement.querySelector('button[type="submit"]');
  button.disabled = true;
  button.textContent = "正在保存…";
  try {
    await api("/api/content", {
      method: "POST",
      body: JSON.stringify({
        title: form.get("title"),
        body: form.get("body"),
        contentType,
        claimIds: claimId ? [claimId] : [],
        platforms: [form.get("platform")],
        owner: primaryProfile().nameEn,
        opinion: contentType === "opinion",
      }),
    });
    formElement.reset();
    formElement.hidden = true;
    await loadData();
  } catch (error) {
    showError(error);
  } finally {
    button.disabled = false;
    button.textContent = "保存草稿";
  }
});

document.querySelector("#interaction-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError();
  const form = new FormData(event.currentTarget);
  try {
    const result = await api("/api/interactions/classify", {
      method: "POST",
      body: JSON.stringify({ text: form.get("text") }),
    });
    document.querySelector("#interaction-result").classList.remove("empty-panel");
    document.querySelector("#interaction-result").innerHTML = `
      <div class="classification">
        <span class="eyebrow">处理级别</span>
        <strong>${escapeHtml(result.level)}</strong>
        <p>${escapeHtml(result.reasons.join("；"))}</p>
        <span class="meta">${escapeHtml(result.action)}</span>
      </div>
    `;
  } catch (error) {
    showError(error);
  }
});

document.querySelector("#media-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const status = document.querySelector("#media-form-status");
  const button = formElement.querySelector('button[type="submit"]');
  const sources = String(form.get("sources") || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  status.textContent = "正在运行 FFmpeg 后期、封面和打包，可能需要数分钟。";
  button.disabled = true;
  try {
    const result = await api("/api/live/media/render", {
      method: "POST",
      body: JSON.stringify({
        confirm: true,
        title: form.get("title"),
        platform: form.get("platform"),
        sources,
        subtitleText: form.get("subtitleText"),
      }),
    });
    await loadIntegratedEngineData();
    status.textContent = `完成：${result.jobId}`;
  } catch (error) {
    status.textContent = "";
    showError(error);
  } finally {
    button.disabled = false;
  }
});

const operationsUi = mountOperations({ api, getData: () => state.data, reload: loadData, showError, profile: primaryProfile });
const editorialUi = mountEditorialWorkbench({ api, getData: () => state.data, showError, afterMutation: async () => {
  state.data = await api("/api/bootstrap");
  await operationsUi.load();
  renderOverview(); renderAccounts(); renderContent(); populateContentForm(); operationsUi.render();
  void finalBackup.sync();
} });
const finalBackup = mountFinalBackup({ api });

initializeVideoWorkbench();
loadData();

const state = {
  data: null,
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
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error?.message || "请求失败");
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

function renderOverview() {
  renderStats();
  document.querySelector("#revision-label").textContent =
    `账本版本 r${state.data.revision} · 事件头 ${state.data.eventHead?.slice(0, 10) ?? "GENESIS"}`;
  renderStatusList("#content-status", state.data.summary.statusCounts ?? {}, statusLabels);
  renderStatusList("#claim-status", state.data.summary.claimCounts ?? {}, claimLabels);
}

function renderAccounts() {
  const template = document.querySelector("#account-card-template");
  const grid = document.querySelector("#account-grid");
  grid.replaceChildren();

  for (const account of state.data.accounts) {
    const card = template.content.firstElementChild.cloneNode(true);
    card.querySelector(".wave").textContent = `${account.wave} 波`;
    card.querySelector(".policy").textContent = "规则待确认";
    card.querySelector("h3").textContent = account.platform;
    card.querySelector(".handle").textContent = account.handle;
    card.querySelector(".focus").textContent = account.contentFocus;
    card.querySelector(".audience").textContent = account.audience;
    card.querySelector(".cadence").textContent = account.cadence;
    card.querySelector(".mode").textContent = account.publishMode;
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
          <article class="content-card">
            <div>
              <h3>${escapeHtml(content.title)}</h3>
              <p>${escapeHtml(content.body).slice(0, 240)}${content.body.length > 240 ? "…" : ""}</p>
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
  const metrics = state.data.metrics;
  const formatRate = (value) => (value === null ? "—" : `${Math.round(value * 100)}%`);
  const cards = [
    ["实体提及率", formatRate(metrics.mentionRate), "合格样本"],
    ["自有来源引用率", formatRate(metrics.ownedCitationRate), "GitHub / CNB / 官网"],
    ["负面提及率", formatRate(metrics.negativeMentionRate), "需人工复盘"],
    ["查询覆盖率", formatRate(metrics.queryCoverage), `${metrics.observedQueries}/${metrics.totalQueries}`],
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

  document.querySelector("#observation-list").innerHTML =
    state.data.observations.length === 0
      ? '<div class="empty-panel">尚无采样。fixture 只能验证流程，不能证明效果。</div>'
      : state.data.observations
          .slice(-8)
          .reverse()
          .map(
            (observation) => `
              <div class="query-row">
                <code>${escapeHtml(observation.dataMode)}</code>
                <p>${escapeHtml(observation.surface)} · ${observation.derived.mentioned ? "提及实体" : "未提及"}</p>
                <span>${escapeHtml(observation.derived.ownedCitationCount)} 个自有引用</span>
              </div>
            `,
          )
          .join("");
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
            claim.text.slice(0, 52),
          )}</option>`,
      )
      .join("");
  platformSelect.innerHTML = state.data.accounts
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
}

function switchView(view) {
  state.view = view;
  for (const button of document.querySelectorAll(".nav-item")) {
    button.classList.toggle("active", button.dataset.view === view);
  }
  for (const section of document.querySelectorAll(".view")) {
    const active = section.id === `view-${view}`;
    section.hidden = !active;
    section.classList.toggle("active", active);
  }
  window.location.hash = view;
}

async function loadData() {
  clearError();
  setLoading(true);
  try {
    state.data = await api("/api/bootstrap");
    renderAll();
    setLoading(false);
    const initialView = window.location.hash.replace("#", "") || "overview";
    if (document.querySelector(`[data-view="${initialView}"]`)) {
      switchView(initialView);
    }
  } catch (error) {
    showError(error);
    setLoading(false);
  }
}

for (const button of document.querySelectorAll(".nav-item")) {
  button.addEventListener("click", () => switchView(button.dataset.view));
}

document.querySelector("#refresh").addEventListener("click", loadData);

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
  try {
    await api("/api/content", {
      method: "POST",
      body: JSON.stringify({
        title: form.get("title"),
        body: form.get("body"),
        contentType,
        claimIds: claimId ? [claimId] : [],
        platforms: [form.get("platform")],
        owner: "PengStack",
        opinion: contentType === "opinion",
      }),
    });
    formElement.reset();
    formElement.hidden = true;
    await loadData();
  } catch (error) {
    showError(error);
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

loadData();

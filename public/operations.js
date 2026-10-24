const labels = { draft: "待授权", approved: "已授权", in_progress: "执行中", completed: "已完成", failed: "已结束 · 未完成" };
const accountLabels = { draft: "未启用", active: "已启用", paused: "已暂停" };

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

function approvalForm(row, person) {
  return `<details class="operation-action"><summary>授权这一次${row.type === "publish" ? "发布" : "回复"}</summary>
    <form data-operation-form="approve" data-operation-id="${html(row.id)}" class="operation-inline-form">
      ${actorField("approvedBy", "授权人", person)}
      <label><span>本次授权范围</span><textarea name="authorizationNote" required maxlength="2000" rows="3" placeholder="例如：允许 Codex 使用本机已登录的该账号，发布上方精确正文一次。"></textarea></label>
      <label class="check-label"><input type="checkbox" required /><span>我已核对目标账号和完整正文，授权执行这一次动作。</span></label>
      ${feedback()}<button class="primary-button" type="submit">确认授权</button>
    </form></details>`;
}

function receiptForm(row, person) {
  const browser = row.executionMode === "browser";
  return `<details class="operation-action"><summary>登记完成回执</summary>
    <form data-operation-form="complete" data-operation-id="${html(row.id)}" class="operation-inline-form">
      <p class="operation-note">先打开平台结果，核对账号、正文与发布状态。后台保存执行者的回读记录；不会代替你自动核验外部页面。</p>
      <div class="form-grid">
        <label class="wide"><span>${row.type === "reply" ? "已发出回复的结果链接" : "已发布内容的公开链接"}</span><input type="url" name="url" required maxlength="2000" placeholder="https://平台/真实发布结果" /></label>
        <label><span>发布时间（北京时间）</span><input type="datetime-local" name="publishedAt" value="${localInput()}" required /></label>
        ${actorField("capturedBy", "发布 / 采集人", person)}
        <label><span>数据来源</span><select name="dataMode"><option value="real" ${browser ? "selected" : ""}>real · 本次实际执行后采集</option><option value="imported" ${browser ? "" : "selected"}>imported · 导入已发生的真实记录</option></select></label>
        <label><span>回读方式</span><select name="verificationMethod"><option value="browser_readback" ${browser ? "selected" : ""}>浏览器打开结果并核对</option><option value="manual_readback" ${browser ? "" : "selected"}>本人手工回读核对</option></select></label>
        <label><span>核验时间（北京时间）</span><input type="datetime-local" name="verifiedAt" value="${localInput()}" required /></label>
        ${actorField("verifiedBy", "实际核验人", person)}
        ${actorField("actor", "后台登记人", person)}
      </div>
      <label class="check-label"><input type="checkbox" required /><span>我已打开真实平台结果，确认这次动作成功，正文与上方授权内容一致。</span></label>
      ${feedback()}<button class="primary-button" type="submit">保存回执并完成</button>
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

export function renderOperations(rows, { profile = {}, accounts = [] } = {}) {
  const person = profile.nameZh || "李大鹏";
  if (!rows.length) return '<div class="empty-panel operation-empty"><strong>还没有运营动作</strong><p>先准备一条已排期内容，或新建一次回复。完成授权、实际执行与回读后，真实结果会保存在这里。</p></div>';
  return [...rows].reverse().map((row) => {
    const account = accounts.find((item) => item.id === row.accountId);
    const expectedAccount = row.accountSnapshot ?? account;
    const identityChanged = row.accountSnapshot && account &&
      (row.accountSnapshot.handle !== account.handle || row.accountSnapshot.profileUrl !== (account.profileUrl ?? ""));
    const title = row.type === "publish" ? row.contentSnapshot?.title || row.contentId : "回复评论 / 帖子";
    const body = row.type === "publish" ? row.contentSnapshot?.body : row.replyText;
    const approval = row.approval;
    const receipt = row.receipt;
    return `<article class="operation-card" data-operation-card="${html(row.id)}">
      <div class="operation-card-heading"><div><p class="eyebrow">${html(row.id)} · ${html(row.platform)}</p><h3>${html(title)}</h3><p class="operation-subtitle">${html(expectedAccount?.handle || row.accountId)} · ${row.executionMode === "browser" ? "本机浏览器执行" : "本人手工执行"}</p></div><span class="status-chip ${html(row.status)}">${html(labels[row.status] || row.status)}</span></div>
      ${identityChanged && ["draft", "approved", "in_progress"].includes(row.status) ? '<p class="form-error">此动作建立后，账号 handle 或主页已变化。旧授权不适用于新账号，请核对原账号并重新建立动作。</p>' : ""}
      ${row.targetUrl ? `<div class="operation-target">${link(row.targetUrl, "打开要回复的帖子 / 评论")}</div>` : ""}
      <details class="operation-snapshot"><summary>查看完整${row.type === "publish" ? "发布内容" : "回复正文"}与校验哈希</summary><div class="operation-body">${html(body)}</div><p class="operation-hash">正文 SHA-256 <code>${html(row.contentHash)}</code></p></details>
      <dl class="operation-facts"><div><dt>创建</dt><dd>${html(row.createdBy)} · ${html(time(row.createdAt))}</dd></div>
      ${approval ? `<div><dt>授权</dt><dd>${html(approval.approvedBy)} · ${html(time(approval.approvedAt))}<p>${html(approval.authorizationNote)}</p></dd></div>` : ""}
      ${row.execution ? `<div><dt>执行</dt><dd>${html(row.execution.actor)} · ${html(time(row.execution.startedAt))}</dd></div>` : ""}</dl>
      ${receipt ? `<div class="operation-receipt"><span class="eyebrow">已登记完成回执 · ${html(receipt.dataMode)}</span><p>${link(receipt.url)}</p><dl class="operation-facts"><div><dt>发布</dt><dd>${html(receipt.capturedBy)} · ${html(time(receipt.publishedAt))}</dd></div><div><dt>回读</dt><dd>${receipt.verificationMethod === "browser_readback" ? "浏览器回读" : "本人手工回读"} · ${html(receipt.verifiedBy)} · ${html(time(receipt.verifiedAt))}</dd></div><div><dt>登记</dt><dd>${html(receipt.recordedBy)} · ${html(time(receipt.recordedAt))}</dd></div></dl><p class="operation-field-hint">以上为执行者登记的核验记录。</p></div>` : ""}
      ${row.failure ? `<div class="operation-failure"><strong>未完成原因</strong><p>${html(row.failure.reason)}</p><small>${html(row.failure.actor)} · ${html(time(row.failure.failedAt))}</small></div>` : ""}
      ${row.classification?.level === "L0" ? '<p class="operation-note">此互动涉及高风险事项，只能由本人手工处理。</p>' : ""}
      ${row.status === "draft" ? approvalForm(row, person) : ""}
      ${row.status === "approved" ? `<form data-operation-form="start" data-operation-id="${html(row.id)}" class="operation-inline-form"><p class="operation-note">标记后，请在本机浏览器实际执行这一次动作。此按钮不会触发外部发布。</p>${actorField("actor", "实际执行人", person)}${feedback()}<button class="primary-button" type="submit">标记开始执行</button></form>` : ""}
      ${row.status === "in_progress" ? receiptForm(row, person) : ""}
      ${["draft", "approved", "in_progress"].includes(row.status) ? failureForm(row, person) : ""}
    </article>`;
  }).join("");
}

export function mountOperations({ api, getData, reload, showError, profile }) {
  let rows = [];
  let loading = false;
  const form = document.querySelector("#operation-create-form");
  const person = () => (typeof profile === "function" ? profile() : profile) ?? {};
  const data = () => getData() ?? { accounts: [], content: [], claims: [], interactions: [] };

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
      if (errorPanel) {
        errorPanel.textContent = `${error.message}${findings ? ` ${findings}` : ""}`;
        errorPanel.hidden = false;
        errorPanel.tabIndex = -1;
        errorPanel.focus();
      } else showError(error);
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
    const available = current.content.filter((item) => item.status === "scheduled" && item.platforms.includes(account?.platform) && !rows.some((row) => row.type === "publish" && row.contentId === item.id && row.status !== "failed"));
    form.elements.contentId.innerHTML = available.length ? available.map((item) => `<option value="${html(item.id)}">${html(item.title)} · ${html(item.id)}</option>`).join("") : '<option value="">该账号还没有可发布的已排期内容</option>';
    if (available.some((item) => item.id === selectedContent)) form.elements.contentId.value = selectedContent;
    form.querySelector('button[type="submit"]').disabled = !current.accounts.length || (publish && !available.length);
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
    form.elements.accountId.innerHTML = current.accounts.map((account) => `<option value="${html(account.id)}">${html(account.platform)} · ${html(account.handle)} · ${html(accountLabels[account.status] || account.status)}</option>`).join("");
    if (current.accounts.some((item) => item.id === selected)) form.elements.accountId.value = selected;
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
      const date = localInput(account.policyCheckedAt || new Date()).slice(0, 10);
      card.insertAdjacentHTML("beforeend", `<details class="account-settings"><summary>运营设置</summary><form data-account-settings="${html(account.id)}" class="operation-inline-form">
        <label><span>实际账号 handle</span><input name="handle" value="${html(account.handle)}" required maxlength="160" /></label>
        <label><span>公开个人主页（可选）</span><input name="profileUrl" type="url" value="${html(account.profileUrl || "")}" placeholder="https://平台/我的主页" maxlength="2000" /></label>
        <label><span>账号状态</span><select name="status">${Object.entries(accountLabels).map(([value, label]) => `<option value="${value}" ${account.status === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
        <label><span>平台规则审阅</span><select name="policyStatus"><option value="manual_review_required" ${account.policyStatus === "reviewed" ? "" : "selected"}>待本人审阅</option><option value="reviewed" ${account.policyStatus === "reviewed" ? "selected" : ""}>本人已审阅该平台规则</option></select></label>
        <label><span>规则审阅日期（北京时间）</span><input name="policyCheckedAt" type="date" value="${html(date)}" required /></label>
        ${actorField("actor", "设置人 / 规则审阅人", person().nameZh || "李大鹏")}
        <p class="operation-field-hint">启用账号前，请核实 handle 是你实际登录的账号。只有在核对平台规则后，才选择“已审阅”。</p>
        ${account.profileUrl ? link(account.profileUrl, "打开账号主页") : ""}${feedback()}<button class="primary-button" type="submit">保存运营设置</button></form></details>`);
    }
  }

  function renderContentControls() {
    const next = { draft: ["fact_check", "送交事实核验"], fact_check: ["approved", "批准此内容"], approved: ["scheduled", "确认排期"], blocked: ["draft", "返回草稿"] };
    for (const card of document.querySelectorAll("#content-list [data-content-id]")) {
      card.querySelector(".operation-content-controls")?.remove();
      const content = data().content.find((item) => item.id === card.dataset.contentId);
      if (!content) continue;
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
    document.querySelector("#operation-count").textContent = `${rows.length} 次动作 · ${rows.filter((row) => row.status === "completed").length} 次已完成`;
    document.querySelector("#operations-list").innerHTML = renderOperations(rows, { profile: person(), accounts: data().accounts });
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
    await submit(target, async () => {
      if (accountId) return api(`/api/accounts/${encodeURIComponent(accountId)}`, { method: "PATCH", body: JSON.stringify({ ...fields, policyCheckedAt: `${fields.policyCheckedAt}T00:00:00+08:00` }) });
      if (claimId) return api(`/api/claims/${encodeURIComponent(claimId)}/approve`, { method: "POST", body: JSON.stringify(fields) });
      if (contentId) return api(`/api/content/${encodeURIComponent(contentId)}/transition`, { method: "POST", body: JSON.stringify({ ...fields, approvedBy: fields.actor }) });
      const id = target.dataset.operationId;
      let input = fields;
      if (action === "complete") {
        const operation = rows.find((row) => row.id === id);
        input = { actor: fields.actor, receipt: { ...fields, publishedAt: isoInput(fields.publishedAt), verifiedAt: isoInput(fields.verifiedAt), contentHash: operation.contentHash } };
        delete input.receipt.actor;
      }
      return api(`/api/operations/${encodeURIComponent(id)}/${action}`, { method: "POST", body: JSON.stringify(input) });
    });
  });

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-prepare-publication]");
    if (!button) return;
    const content = data().content.find((item) => item.id === button.dataset.preparePublication);
    const account = data().accounts.find((item) => content?.platforms.includes(item.platform));
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

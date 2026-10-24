const form = document.querySelector("#login-form");
const button = form.querySelector("button");
const errorPanel = document.querySelector("#login-error");

async function authRequest(path, options = {}) {
  const response = await fetch(path, { ...options, credentials: "same-origin", headers: { "Content-Type": "application/json" } });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || "登录服务暂时不可用，请稍后重试。");
  return payload;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorPanel.hidden = true;
  button.disabled = true;
  button.textContent = "正在验证…";
  try {
    const password = String(new FormData(form).get("password") ?? "");
    await authRequest("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) });
    form.reset();
    window.location.replace("/admin");
  } catch (error) {
    errorPanel.textContent = error.message;
    errorPanel.hidden = false;
    form.querySelector("input").focus();
  } finally {
    button.disabled = false;
    button.textContent = "登录管理后台";
  }
});

try {
  const status = await authRequest("/api/auth/status");
  if (status.authenticated) window.location.replace("/admin");
} catch (error) {
  errorPanel.textContent = error.message;
  errorPanel.hidden = false;
}

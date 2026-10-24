const target = document.querySelector("#public-claims");
const retry = document.querySelector("#retry-evidence");

function safeSource(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

async function loadPublicClaims() {
  retry.hidden = true;
  retry.disabled = true;
  target.replaceChildren();
  const status = document.createElement("p");
  status.className = "evidence-state";
  status.textContent = "正在读取公开资料…";
  target.append(status);
  try {
    const response = await fetch("/public-api/profile", { credentials: "omit" });
    if (!response.ok) throw new Error("公开资料暂时无法读取。");
    const payload = await response.json();
    if (!Array.isArray(payload.claims)) throw new Error("公开资料格式暂时不可用。");
    target.replaceChildren();
    if (payload.claims.length === 0) {
      status.textContent = "项目与文章的公开证据正在整理，审核后会在这里更新。";
      target.append(status);
    }
    for (const claim of payload.claims) {
      const article = document.createElement("article");
      const text = document.createElement("p");
      text.textContent = claim.text;
      article.append(text);
      const url = safeSource(claim.source?.url);
      if (url) {
        const link = document.createElement("a");
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "查看公开来源 ↗";
        article.append(link);
      }
      target.append(article);
    }
  } catch (error) {
    status.textContent = `${error.message} 你仍可通过 GitHub 了解我的工作。`;
    target.replaceChildren(status);
    retry.hidden = false;
  } finally {
    retry.disabled = false;
  }
}

retry.addEventListener("click", loadPublicClaims);
loadPublicClaims();

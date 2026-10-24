import { hashObject } from "../domain/hash.mjs";

async function githubRequest(fetchImpl, token, path, options = {}) {
  const response = await fetchImpl(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "PengManager-System/0.4",
      ...(options.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { rawText: text.slice(0, 1_000) };
  }
  if (!response.ok) {
    throw new Error(
      `GitHub API ${response.status}: ${String(body.message ?? body.rawText ?? "request failed").slice(0, 500)}`,
    );
  }
  return body;
}

export class GitHubAdapter {
  constructor({
    token = process.env.GITHUB_TOKEN,
    repository = process.env.GITHUB_REPOSITORY || "geniusdapeng-collab/geniusdapeng-geo-os",
    fetchImpl = fetch,
  } = {}) {
    this.token = token;
    this.repository = repository;
    this.fetchImpl = fetchImpl;
  }

  status() {
    return {
      configured: Boolean(this.token),
      repository: this.repository,
      mode: "official-github-rest-api",
      issueWrite: Boolean(this.token),
    };
  }

  #token() {
    if (!this.token) {
      throw new Error("缺少 GITHUB_TOKEN，GitHub 发布适配器保持 fail-closed。");
    }
    return this.token;
  }

  async health() {
    if (!this.token) {
      return { ...this.status(), ok: false, error: "GITHUB_TOKEN not configured" };
    }
    try {
      const body = await githubRequest(
        this.fetchImpl,
        this.#token(),
        `/repos/${this.repository}`,
      );
      return {
        ...this.status(),
        ok: true,
        private: body.private,
        defaultBranch: body.default_branch,
        permissions: body.permissions ?? null,
      };
    } catch (error) {
      return { ...this.status(), ok: false, error: error.message };
    }
  }

  async ensureLabel(name, color = "2563eb", description = "PengManager System GEO operation") {
    try {
      return await githubRequest(
        this.fetchImpl,
        this.#token(),
        `/repos/${this.repository}/labels/${encodeURIComponent(name)}`,
      );
    } catch {
      return githubRequest(
        this.fetchImpl,
        this.#token(),
        `/repos/${this.repository}/labels`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, color, description }),
        },
      );
    }
  }

  async createIssue({ title, body, label = "geo-live-smoke" }) {
    await this.ensureLabel(
      label,
      "2563eb",
      "A content publication created by the PengManager System live API adapter",
    );
    const issue = await githubRequest(
      this.fetchImpl,
      this.#token(),
      `/repos/${this.repository}/issues`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          body,
          labels: [label],
        }),
      },
    );
    return {
      id: issue.id,
      number: issue.number,
      url: issue.html_url,
      apiUrl: issue.url,
      state: issue.state,
      createdAt: issue.created_at,
      title: issue.title,
      receiptHash: hashObject({
        id: issue.id,
        number: issue.number,
        url: issue.html_url,
        title: issue.title,
        state: issue.state,
        createdAt: issue.created_at,
      }),
    };
  }
}

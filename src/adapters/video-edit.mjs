import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { hashObject } from "../domain/hash.mjs";
import { ApiError } from "../domain/errors.mjs";

const execFileAsync = promisify(execFile);

function parseJsonOutput(stdout) {
  const value = String(stdout ?? "").trim();
  if (!value) {
    throw new Error("video-edit CLI 未返回 JSON。");
  }
  return JSON.parse(value);
}

export class VideoEditAdapter {
  constructor({
    upstreamRoot = process.env.VIDEO_EDIT_ROOT,
    nodePath = process.execPath,
  } = {}) {
    this.upstreamRoot = upstreamRoot ? resolve(upstreamRoot) : null;
    this.nodePath = nodePath;
  }

  status() {
    return {
      configured: Boolean(this.upstreamRoot),
      upstreamRoot: this.upstreamRoot,
      mode: "official-video-edit-cover-and-post-cli",
    };
  }

  #root() {
    if (!this.upstreamRoot) {
      throw new Error("缺少 VIDEO_EDIT_ROOT，video-edit 适配器保持 fail-closed。");
    }
    return this.upstreamRoot;
  }

  async #run(script, args, label) {
    await access(script);
    try {
      const { stdout, stderr } = await execFileAsync(this.nodePath, [script, ...args], {
        cwd: this.#root(),
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          NO_COLOR: "1",
        },
      });
      return { stdout, stderr };
    } catch (error) {
      const detail = String(error.stderr || error.message || "").trim().slice(0, 800);
      throw new Error(`video-edit ${label} CLI 失败：${detail}`);
    }
  }

  async #cli(args) {
    const script = join(
      this.#root(),
      "bundles",
      "ai-video",
      "connectors",
      "cover-kb-bridge",
      "cli.mjs",
    );
    return this.#run(script, args, "cover");
  }

  async health() {
    if (!this.upstreamRoot) {
      return { ...this.status(), ok: false, error: "VIDEO_EDIT_ROOT not configured" };
    }
    try {
      const { stdout } = await this.#cli(["health", "--json"]);
      const payload = parseJsonOutput(stdout);
      return {
        ...this.status(),
        ok: payload.ok === true,
        topics: payload.topics,
        mappingRows: payload.mappingRows,
        paramRows: payload.paramRows,
        platformDrifts: payload.platformDrifts,
        payloadHash: hashObject(payload),
      };
    } catch (error) {
      return { ...this.status(), ok: false, error: error.message };
    }
  }

  async enrichCover({
    platform,
    theme,
    account,
    text,
    accountDir,
  }) {
    const args = ["enrich", "--platform", String(platform), "--json"];
    if (theme) args.push("--theme", String(theme));
    if (account) args.push("--account", String(account));
    if (accountDir) args.push("--account-dir", String(accountDir));
    if (text) args.push("--text", String(text));
    const { stdout } = await this.#cli(args);
    const payload = parseJsonOutput(stdout);
    if (payload.fallback) {
      throw new Error(`video-edit 对平台 ${platform} 返回 fallback，未生成生产封面提示。`);
    }
    return {
      platform,
      hints: payload.hints,
      trace: payload.trace,
      notes: payload.notes,
      conflicts: payload.conflicts,
      source: payload.source,
      payloadHash: hashObject(payload),
    };
  }

  async triageFeedback({ feedback }) {
    const script = join(
      this.#root(),
      "bundles",
      "ai-video",
      "connectors",
      "post-bridge",
      "cli.mjs",
    );
    const { stdout } = await this.#run(
      script,
      ["triage", "--feedback", String(feedback)],
      "post triage",
    );
    const output = String(stdout).trim();
    if (!output) {
      throw new Error("video-edit 反馈分诊没有返回结果。");
    }
    return {
      output,
      outputHash: hashObject({ feedback, output }),
    };
  }

  async #readLibrary(command, input) {
    if (!this.upstreamRoot) throw new ApiError(503, "VIDEO_LIBRARY_UNAVAILABLE", "内置视频资产根目录未配置。");
    const root = this.#root();
    const script = join(root, "scripts", "tools", "video-library.mts");
    try {
      await access(script);
      const { stdout } = await execFileAsync(this.nodePath, ["--import", "tsx", script, command, JSON.stringify(input)], {
        cwd: root,
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: "1" },
      });
      return parseJsonOutput(stdout);
    } catch (error) {
      let reported;
      try { reported = JSON.parse(String(error.stderr ?? "").trim()).error; }
      catch { /* Process/setup failures have no trusted library error payload. */ }
      if (reported && [400, 404, 409, 503].includes(reported.status)
        && typeof reported.code === "string" && /^VIDEO_[A-Z_]+$/.test(reported.code)
        && typeof reported.message === "string") throw new ApiError(reported.status, reported.code, reported.message.slice(0, 1000));
      throw new ApiError(503, "VIDEO_LIBRARY_UNAVAILABLE", "内置视频资产库暂不可用或完整性证据不可核实。");
    }
  }

  async libraryCatalog({ kind = "all" } = {}) {
    if (!["all", "characters", "products"].includes(kind)) throw new ApiError(400, "VIDEO_LIBRARY_KIND_INVALID", "kind只接受all、characters或products。");
    return this.#readLibrary("catalog", { kind });
  }

  async resolveCharacters(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some(key => !["intent", "metadata"].includes(key))
      || typeof input.intent !== "string" || !input.intent.trim() || input.intent.length > 8000
      || input.metadata !== undefined && (!input.metadata || typeof input.metadata !== "object" || Array.isArray(input.metadata))) {
      throw new ApiError(400, "VIDEO_CHARACTER_REQUEST_INVALID", "需要8000字以内intent与可选metadata对象。");
    }
    return this.#readLibrary("characters", input);
  }

  async selectProduct({ selector } = {}) {
    if (typeof selector !== "string" || !selector.trim() || selector.length > 240) throw new ApiError(400, "VIDEO_PRODUCT_REQUEST_INVALID", "selector需要1到240字的商品ID、名称、型号或品牌。");
    return this.#readLibrary("product", { selector });
  }
}

#!/usr/bin/env node
/** Build the complete embedded capability inventory from actual upstream declarations.
 * Discovery and source references are B evidence. They never certify a live provider call.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import YAML from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "pengmanager-capabilities.json");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const json = (p) => JSON.parse(read(p));
const present = (p) => fs.existsSync(path.join(root, p));
const uniq = (items) => [...new Set(items)].sort();
const sha = (text) => createHash("sha256").update(text).digest("hex");
function walk(relative) {
  if (!present(relative)) return [];
  const result = [];
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    if (["node_modules", "dist", ".git", "var", "work", ".venv", "__pycache__"].includes(entry.name)) continue;
    const next = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) result.push(...walk(next));
    else if (entry.isFile()) result.push(next);
  }
  return result.sort();
}
const codePaths = ["apps", "packages", "scripts", "bundles"].flatMap(walk)
  .filter((p) => /\.(?:[cm]?tsx?|[cm]?js|py|swift|sh)$/.test(p));
const code = codePaths.map((p) => ({ path: p, text: read(p), test: /(?:test|fixture|test-support)\./.test(p) }));
const refs = (needle, test) => code.filter((entry) => entry.test === test && entry.text.includes(needle)).map((entry) => entry.path);
const baseStatus = (exists, reason) => ({ declared: true, codePresent: exists, dependencyState: "unchecked", validated: "unverified", reason });
const bindings = () => ({ roleIds: [], skillIds: [], toolIds: [], capabilityIds: [] });
const testsOf = (paths = []) => ({ paths: uniq(paths), executed: "unverified", report: null });
const common = (id, name, description, bundle, sourcePaths) => ({ id, name, description, bundle,
  category: bundle === "video-edit" ? "ai-video-editing" : bundle === "hotel" ? "shared-business-context" : "ai-video-production",
  bindings: bindings(), sourcePaths, entrypoints: [], dependencies: [], evidence: "B",
  status: baseStatus(sourcePaths.every(present), "目录和文件已发现；运行依赖、实际接线与产出需以独立验收为准"), tests: testsOf() });

const installerRecipes = [
  { id: "compositor", name: "Compositor 作图工位", description: "受控 headless Compositor、工程合成、文字层、PNG/JPEG、桥接、配额和回执", paths: ["bundles/geo-growth/connectors/visual-bridge/executor.ts", "scripts/pengmanager-tools.mjs"], tools: ["visualread.", "visualwrite."], kind: "local-station" },
  { id: "voice", name: "配音与声音克隆工位", description: "目标自有 MLX TTS/ASR、声音档案、授权、录音、播报、配音与独立诊断", paths: ["bundles/ai-video/connectors/voice-bridge/server.mjs", "bundles/ai-video/connectors/voice-bridge/kit/install.sh", "scripts/pengmanager-tools.mjs"], tools: ["voiceread.", "voicewrite."], kind: "local-model-station" },
  { id: "talkcraft", name: "口播解说片 / Remotion", description: "安装期按 pin 获取完整引擎、配方卡、浏览器、渲染与机器闸；保留原商业授权边界", paths: ["scripts/tools/talkcraft-engine-install.mts", "apps/server/src/video/explainer/engine.ts", "apps/server/src/video/explainer/pipeline.ts"], tools: ["explainerread.", "explainerwrite."], kind: "licensed-engine" },
  { id: "asr", name: "口播逐字稿 / ASR", description: "词级时间戳、原样转写、停顿标记与对齐，模型与精度按真实后端回执", paths: ["scripts/tools/edit-talk-asr.mts", "scripts/tools/talkcraft-asr-words.py", "apps/server/src/video/explainer/asr-aligner.ts"], tools: ["talk."], kind: "local-model" },
  { id: "whiteboard", name: "手绘白板工位", description: "本地白板渲染器、Python 依赖、字幕、旁白和视频封装", paths: ["scripts/tools/whiteboard-env-install.mts", "vendor/srt-whiteboard/requirements.txt", "apps/server/src/video/whiteboard/engine.ts"], tools: ["whiteboard"], kind: "local-engine" },
  { id: "ffmpeg", name: "媒体与后期工具链", description: "FFmpeg/FFprobe、后期、字幕、BGM、调色、封面、返修与交付质检", paths: ["scripts/tools/video-doctor.mts", "scripts/tools/edit-post.mts", "bundles/ai-video/connectors/post-bridge/core.mjs"], tools: ["bgm", "color", "post", "cover", "subtitle", "caption", "edit.", "rhythm", "audio"], kind: "system-tool" },
  { id: "generation-providers", name: "AI 图片 / 视频模型供应商", description: "目录、报价、参数、资格、预算、提交、轮询与回执；实际调用需要有效账号和授权", paths: ["apps/server/src/video/gen/catalog.ts", "apps/server/src/video/gen/providers.ts", "apps/server/src/video/gen/submission-ledger.ts"], tools: ["render.", "generation.", "image"], kind: "provider" },
];
const installers = installerRecipes.map((recipe) => ({ ...common(recipe.id, recipe.name, recipe.description, "runtime", recipe.paths),
  kind: recipe.kind, command: recipe.kind === "provider" ? null : `node scripts/pengmanager-tools.mjs setup --tool ${recipe.id}`,
  configuration: recipe.kind === "provider" ? { kind: "native-ui", path: "/onboarding", requires: ["valid provider credentials", "current text connectivity probe", "native generation qualification and budget approval"] } : null,
  entrypoints: recipe.paths.filter(present).map((p) => ({ kind: /\.mts$/.test(p) ? "cli" : "module", path: p })),
  licenseBoundary: recipe.id === "talkcraft" ? "noncommercial evaluation; commercial use requires actual LICENSE-GRANT.md" : null,
}));
const dependenciesOf = (tool) => installerRecipes.filter((item) => item.tools.some((prefix) => tool.startsWith(prefix)))
  .map((item) => ({ kind: item.kind, id: item.id, installId: item.id, reason: item.description }));

const bundles = [], roles = [], skills = [], tools = [], pipelines = [], toolDeclarations = [];
for (const entry of code.filter((item) => !item.test && /(?:connectors\/.*\/(?:executor|server-adapter)|adapter)/.test(item.path))) {
  // Current upstream declarations use literal string arrays. Fail rather than silently omitting a changed expression.
  for (const match of entry.text.matchAll(/export\s+const\s+([A-Z_]*TOOLS|TOOL_PATTERNS|toolPatterns)\s*=\s*\[([\s\S]*?)\]\s*(?:as\s+const)?/g)) {
    const values = [...match[2].matchAll(/["']([^"']+)["']/g)].map((value) => value[1]);
    const residue = match[2].replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "").replace(/["'][^"']+["']/g, "").replace(/[\s,]/g, "");
    if (residue) throw new Error(`Unsupported tool declaration ${entry.path}:${match[1]}`);
    for (const name of values) toolDeclarations.push({ name, sourcePath: entry.path, declaration: match[1], kind: name.includes("*") ? "adapter-pattern" : "connector-tool", evidence: "B" });
  }
}
for (const bundle of fs.readdirSync(path.join(root, "bundles")).sort()) {
  const manifestPath = `bundles/${bundle}/bundle.json`;
  if (!present(manifestPath)) continue;
  const manifest = json(manifestPath), provides = manifest.workloom?.provides ?? {};
  bundles.push({ id: bundle, name: manifest.name ?? manifest.workloom?.name ?? bundle, version: manifest.version,
    sourcePaths: [manifestPath], provides, manifestSha256: sha(read(manifestPath)), evidence: "B" });
  for (const presetPath of walk(`bundles/${bundle}/presets`).filter((p) => /\.ya?ml$/.test(p))) {
    const preset = YAML.parse(read(presetPath));
    if (!preset?.preset_key) throw new Error(`Missing preset_key: ${presetPath}`);
    const row = common(`${bundle}:${preset.preset_key}`, preset.name ?? preset.preset_key, preset.description ?? "", bundle, [presetPath]);
    row.key = preset.preset_key; row.fenceBindings = preset.fence_bindings ?? []; row.readonly = preset.readonly === true;
    row.bindings.skillIds = (preset.skills ?? []).map((id) => `${bundle}:${id}`);
    row.bindings.toolIds = (preset.tools ?? []).map((tool) => tool.name);
    row.declaredTools = preset.tools ?? []; row.dependencies = uniq(row.bindings.toolIds.flatMap((name) => dependenciesOf(name).map((item) => item.id)))
      .map((id) => ({ id, installId: id, kind: installerRecipes.find((item) => item.id === id).kind, reason: "岗位声明的工具所需运行环境" }));
    row.entrypoints = [{ kind: "native-ui", path: "/p8" }, { kind: "trpc", path: "workspace.agents", method: "query" }];
    roles.push(row);
  }
  for (const skillPath of walk(`bundles/${bundle}/skills`).filter((p) => p.endsWith("/SKILL.md"))) {
    const text = read(skillPath), id = path.basename(path.dirname(skillPath));
    const name = text.match(/^#\s+(.+)$/m)?.[1] ?? id;
    const row = common(`${bundle}:${id}`, name, text.split("\n").find((line) => line.trim() && !/^(?:#|>|\||---|\s*-)/.test(line)) ?? "", bundle, [skillPath]);
    row.key = id; row.contentSha256 = sha(text); row.signedDeclaration = (provides.skills ?? []).includes(path.posix.relative(`bundles/${bundle}`, skillPath));
    skills.push(row);
  }
  for (const pipelinePath of walk(`bundles/${bundle}/pipelines`).filter((p) => /\.ya?ml$/.test(p))) {
    const data = YAML.parse(read(pipelinePath));
    const id = data.id ?? data.pipeline_key ?? data.key ?? path.basename(pipelinePath).replace(/\.ya?ml$/, "");
    const row = common(`pipeline:${bundle}:${id}`, data.name ?? data.title ?? id, data.description ?? "", bundle, [pipelinePath]);
    row.kind = "pipeline"; row.pipeline = data; pipelines.push(row);
  }
}
for (const origin of ["official", "registry"]) {
  for (const skillPath of walk(`skills/${origin}`).filter((item) => item.endsWith("/SKILL.md"))) {
    const text = read(skillPath), frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
    const metadata = frontmatter ? YAML.parse(frontmatter) : {};
    const key = String(metadata.name ?? path.basename(path.dirname(skillPath)));
    if (origin === "official" && !metadata.name) throw new Error(`Official skill name missing: ${skillPath}`);
    const row = common(`${origin}:${key}`, key, String(metadata.description ?? ""), origin, [skillPath]);
    const nativeVersion = frontmatter?.match(/^version:\s*(.+)$/m)?.[1]?.trim();
    row.key = key; row.origin = origin; row.version = origin === "official" ? nativeVersion || "1.0" : String(metadata.version ?? "1.0"); row.contentSha256 = sha(text);
    row.signedDeclaration = false; row.status.reason = "随完整引擎分发的包外技能；安装与运行以原生 registry、岗位装配及回执为准";
    skills.push(row);
  }
}
const resolvedCrossBundleSkills = [];
const presetOwners = json("bundles/geo-growth/bundle.json").workloom.composition?.presetOwners ?? {};
for (const role of roles) {
  const definitions = roles.filter((item) => item.key === role.key);
  const isAlias = definitions.length > 1 && presetOwners[role.key] !== role.bundle;
  role.runtimePresetKey = isAlias ? `${role.bundle}--${role.key}` : role.key;
  role.runtimeIdentity = { sourceBundleId: role.bundle, originalPresetKey: role.key, alias: isAlias, mode: "WORKLOOM_PRESERVE_SHADOWED_ROLES=1" };
  role.bindings.skillIds = role.bindings.skillIds.map((id) => {
    if (skills.some((skill) => skill.id === id)) return id;
    const key = id.slice(id.indexOf(":") + 1), available = skills.filter((skill) => skill.key === key);
    const official = available.filter((skill) => skill.origin === "official");
    const candidates = official.length ? official : available;
    if (candidates.length !== 1) return id;
    resolvedCrossBundleSkills.push({ roleId: role.id, declaredSkillId: id, resolvedSkillId: candidates[0].id, evidence: "B", reason: candidates[0].origin === "official" ? "native loadOfficialSkills resolves the referenced globally named official skill" : "unique skill key exists in another included asset set" });
    return candidates[0].id;
  });
}
for (const name of uniq([...roles.flatMap((role) => role.bindings.toolIds), ...toolDeclarations.map((item) => item.name)])) {
  const declared = roles.flatMap((role) => role.declaredTools).find((tool) => tool.name === name);
  const implementation = refs(name, false).filter((p) => !p.includes("/presets/") && !p.includes("/skills/") && !p.endsWith("pengmanager-capabilities.mjs"));
  const deps = dependenciesOf(name);
  const declarations = toolDeclarations.filter((item) => item.name === name);
  const sourcePaths = uniq([...declarations.map((item) => item.sourcePath), ...implementation, ...deps.flatMap((dep) => installerRecipes.find((item) => item.id === dep.id).paths.filter(present))]);
  const row = common(name, name, declared?.desc ?? "", "shared", sourcePaths);
  row.bundles = uniq(roles.filter((role) => role.bindings.toolIds.includes(name)).map((role) => role.bundle));
  row.access = declared?.access ?? (/write\./.test(name) ? "write" : /read\./.test(name) ? "read" : "unknown"); row.dependencies = deps;
  row.declarations = declarations;
  row.implementationReferences = implementation; row.implementationState = implementation.length ? "literal-reference-found" : "declared-tool-mapped-runtime-unverified";
  row.status.codePresent = implementation.length > 0;
  row.status.reason = implementation.length ? "发现对应源码引用；尚未证明当前工位已接线或真实调用成功" : "岗位有声明；必须核实部署执行器或原生服务接线，不能据目录宣称已执行";
  row.tests = testsOf(refs(name, true));
  row.entrypoints = sourcePaths.filter((p) => /(?:executor|server-adapter|router|cli|scripts\/tools)/.test(p)).map((p) => ({ kind: /\/scripts\/|^scripts\//.test(p) ? "cli" : "module", path: p }));
  row.bindings.roleIds = roles.filter((role) => role.bindings.toolIds.includes(name)).map((role) => role.id);
  tools.push(row);
}
for (const role of roles) {
  role.tests = testsOf(uniq(role.bindings.toolIds.flatMap((name) => tools.find((tool) => tool.id === name)?.tests.paths ?? [])));
  delete role.declaredTools;
}
for (const skill of skills) {
  skill.bindings.roleIds = roles.filter((role) => role.bindings.skillIds.includes(skill.id)).map((role) => role.id);
  skill.bindings.toolIds = uniq(roles.filter((role) => skill.bindings.roleIds.includes(role.id)).flatMap((role) => role.bindings.toolIds));
  skill.dependencies = uniq(skill.bindings.toolIds.flatMap((name) => dependenciesOf(name).map((item) => item.id)))
    .map((id) => ({ id, installId: id, kind: installerRecipes.find((item) => item.id === id).kind, reason: "绑定岗位声明工具的运行环境" }));
}
const capabilitySources = ["scripts/agent-capabilities.core.json", "bundles/geo-growth/agent-capabilities.json"];
const capabilities = capabilitySources.flatMap((p) => json(p).capabilities.map((capability) => ({
  ...common(capability.id, capability.title, capability.description, p.includes("geo-growth") ? "geo-growth" : "core", [p, ...(capability.transport?.module ? [capability.transport.module] : [])]),
  kind: "agent-capability", operation: capability.operation, declaredDataMode: capability.dataMode,
  entrypoints: [{ kind: capability.transport.kind, path: capability.transport.path ?? capability.transport.module, method: capability.transport.method, export: capability.transport.export }],
}))).concat(pipelines);
const tour = json("docs/capabilities.auto.json");
for (const group of tour.groups ?? []) for (const item of group.items ?? []) capabilities.push({
  ...common(item.id, item.name, item.desc ?? "", "source-catalog", item.sourcePaths ?? group.sourcePaths ?? []),
  kind: "source-catalog", category: group.title, entrypoints: [{ kind: "guide", path: item.how }],
});
const missingSkillBindings = roles.flatMap((role) => role.bindings.skillIds.filter((id) => !skills.some((skill) => skill.id === id)).map((id) => ({ roleId: role.id, skillId: id })));
const upstreamPin = JSON.parse(fs.readFileSync(path.resolve(root, "../../upstreams/workloom-video-edit.pin.json"), "utf8"));
const result = { schemaVersion: "pengmanager.video-capabilities/v1", generatedAt: "2026-10-24", source: {
  repository: upstreamPin.repository, pin: upstreamPin.commit, tree: upstreamPin.tree },
  evidenceNotice: "B级完整声明/源码引用目录；发现、已接线、依赖就绪和真实产出分开记录。目录导入不等于模型调用或经营完成。",
  bundles, capabilities, roles, skills, tools, installers,
  summary: { bundles: bundles.length, capabilities: capabilities.length, roles: roles.length, uniqueRoleKeys: uniq(roles.map((role) => role.key)).length, skills: skills.length,
    bundledSkills: skills.filter((skill) => !skill.origin).length, officialSkills: skills.filter((skill) => skill.origin === "official").length, registrySkills: skills.filter((skill) => skill.origin === "registry").length,
    uniqueSkillKeys: uniq(skills.map((skill) => skill.key)).length, runtimeRoles: uniq(roles.map((role) => role.runtimePresetKey)).length, tools: tools.length, pipelines: pipelines.length, installers: installers.length },
  checks: { evidence: "B", sourceCatalogIncluded: true, allBundledPresetsParsed: true, allSkillFilesParsed: true, missingSkillBindings, resolvedCrossBundleSkills,
    connectorToolDeclarationCount: toolDeclarations.length, toolDeclarationSources: uniq(toolDeclarations.map((item) => item.sourcePath)),
    sourceDeclarationTotals: tour.declarationTotals, ownRuntimeVerified: false, providerCalls: 0 },
};
const output = `${JSON.stringify(result, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (!present("pengmanager-capabilities.json") || read("pengmanager-capabilities.json") !== output) throw new Error("PENGMANAGER_CAPABILITY_CATALOG_DRIFT: run node scripts/pengmanager-capabilities.mjs --write");
  process.stdout.write(`${JSON.stringify({ ok: true, ...result.summary })}\n`);
} else if (process.argv.includes("--write")) {
  fs.writeFileSync(file, output);
  process.stdout.write(`${JSON.stringify({ path: file, sha256: sha(output), ...result.summary })}\n`);
} else process.stdout.write(output);

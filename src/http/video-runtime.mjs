import { ApiError } from "../domain/errors.mjs";

const STATES = new Set(["not-installed", "stopped", "setting-up", "starting", "ready", "stopping", "error"]);
const DEPENDENCIES = new Set(["unchecked", "ready", "missing", "blocked"]);
const VALIDATIONS = new Set(["unverified", "passed", "failed"]);
const CATEGORY_STATES = new Set(["available", "dependency-missing", "starting", "unverified"]);
const CATEGORY_IDS = new Set(["ai-generation", "ai-editing", "ai-presenter", "visual-design"]);
const SCHEMA = "pengmanager.video-capabilities/v1";

function text(value) {
  return typeof value === "string" ? value : "";
}

function strings(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === "string") : [];
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function sha(value) {
  return typeof value === "string" && /^[a-f0-9]{40}$/.test(value) ? value : null;
}

// Only the supervisor's own root-origin workbench can become a clickable link.
export function publicWorkbenchUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return null;
    if (!url.port || Number(url.port) < 1 || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function publicVideoStatus(raw) {
  const state = STATES.has(raw?.state) ? raw.state : "error";
  const workbenchUrl = publicWorkbenchUrl(raw?.workbenchUrl);
  const workbenchEnabled = raw?.workbenchEnabled !== false;
  const ready = raw?.ready === true && state === "ready" && (!workbenchEnabled || workbenchUrl !== null)
    && raw?.backendHealth?.ok === true && raw?.dbHealth?.ok === true && raw?.dbHealth?.owned === true;
  const invalidReady = !ready && (state === "ready" || raw?.ready === true);
  return {
    version: 1,
    ready,
    state: invalidReady ? "error" : state,
    sourceMain: sha(raw?.sourceMain),
    workbenchEnabled,
    workbenchUrl: ready && workbenchEnabled ? workbenchUrl : null,
    backendHealth: { ok: raw?.backendHealth?.ok === true },
    dbHealth: { ok: raw?.dbHealth?.ok === true, owned: raw?.dbHealth?.owned === true },
    errorSafe: state === "error" || invalidReady
      ? "视频工作台未就绪，请运行本地诊断并检查受保护的运行日志。" : null,
  };
}

function entrypoints(value) {
  return (Array.isArray(value) ? value : []).map(item => typeof item === "string" ? ({
    kind: item.startsWith("/") ? "native-ui" : "native-operation", path: item,
  }) : ({
    kind: text(item?.kind), path: text(item?.path),
    ...(typeof item?.method === "string" ? { method: item.method } : {}),
  }));
}

function row(item) {
  const bindings = item?.bindings;
  return {
    id: text(item?.id), name: text(item?.name), description: text(item?.description),
    bundle: text(item?.bundle), bundles: strings(item?.bundles), category: text(item?.category),
    ...(typeof item?.runtimePresetKey === "string" ? {
      runtimePresetKey: item.runtimePresetKey,
      runtimeIdentity: {
        sourceBundleId: text(item.runtimeIdentity?.sourceBundleId),
        originalPresetKey: text(item.runtimeIdentity?.originalPresetKey),
        alias: item.runtimeIdentity?.alias === true,
      },
    } : {}),
    fenceBindings: strings(item?.fenceBindings), readonly: item?.readonly === true,
    bindings: Object.fromEntries(["roleIds", "skillIds", "toolIds", "capabilityIds"].map(key => [key, strings(bindings?.[key])])),
    sourcePaths: strings(item?.sourcePaths), entrypoints: entrypoints(item?.entrypoints),
    dependencies: (Array.isArray(item?.dependencies) ? item.dependencies : []).map(dependency => ({
      kind: text(dependency?.kind), id: text(dependency?.id), reason: text(dependency?.reason), installId: text(dependency?.installId),
    })),
    status: {
      declared: item?.status?.declared === true, codePresent: item?.status?.codePresent === true,
      dependencyState: DEPENDENCIES.has(item?.status?.dependencyState) ? item.status.dependencyState : "unchecked",
      validated: VALIDATIONS.has(item?.status?.validated) ? item.status.validated : "unverified",
      reason: text(item?.status?.reason),
    },
    tests: {
      paths: strings(item?.tests?.paths),
      executed: VALIDATIONS.has(item?.tests?.executed) ? item.tests.executed : "unverified",
      report: typeof item?.tests?.report === "string" ? item.tests.report : null,
    },
    evidence: ["A", "B", "C", "D"].includes(item?.evidence) ? item.evidence : "D",
    ...(typeof item?.command === "string" ? { command: item.command } : {}),
    ...(typeof item?.licenseBoundary === "string" ? { licenseBoundary: item.licenseBoundary } : {}),
  };
}

function runtimeTool(item) {
  let license;
  if (typeof item?.license === "string") license = item.license;
  else if (item?.license && typeof item.license === "object" && !Array.isArray(item.license)) {
    const scope = ["noncommercial", "authorized"].includes(item.license.scope) ? item.license.scope : "unverified";
    const commercialGrantPresent = item.license.commercialGrantPresent === true;
    license = {
      scope, commercialGrantPresent,
      commercialReady: scope === "authorized" && commercialGrantPresent && item.license.commercialReady === true,
      condition: text(item.license.condition),
    };
  }
  return {
    id: text(item?.id), label: text(item?.label),
    installed: item?.installed === true, ready: item?.ready === true, running: item?.running === true,
    missing: strings(item?.missing), entrypoints: strings(item?.entrypoints),
    productionVerified: item?.productionVerified === true,
    readinessKind: "dependency-and-process-status",
    ...(license === undefined ? {} : { license }),
  };
}

function missingDependencies(value) {
  return (Array.isArray(value) ? value : []).flatMap(item => typeof item === "string" ? [item]
    : typeof item?.id === "string" ? [`${item.id}${strings(item.reasons).length ? `：${strings(item.reasons).join("、")}` : ""}`] : []);
}

export function publicVideoCapabilities(raw) {
  if (raw?.schemaVersion !== SCHEMA || raw?.scope !== "complete-edit" || raw?.catalog?.schemaVersion !== SCHEMA
    || !sha(raw.sourceMain) || raw.catalog.source?.pin !== raw.sourceMain
    || ["capabilities", "roles", "skills", "tools", "installers"].some(key => !Array.isArray(raw.catalog[key]))) {
    throw new ApiError(503, "VIDEO_CAPABILITIES_UNAVAILABLE", "完整视频能力目录尚不可用，请运行本地诊断。");
  }
  const catalog = raw.catalog;
  const arrays = Object.fromEntries(["capabilities", "roles", "skills", "tools", "installers"].map(key => [key,
    (Array.isArray(catalog[key]) ? catalog[key] : []).map(row),
  ]));
  return {
    schemaVersion: SCHEMA, scope: "complete-edit", sourceMain: sha(raw.sourceMain),
    ready: raw.ready === true && raw.state === "ready", state: STATES.has(raw.state) ? raw.state : "error",
    inventory: {
      fileCount: count(raw.inventory?.fileCount), roleCount: arrays.roles.length,
      skillCount: arrays.skills.length, toolCount: arrays.tools.length,
    },
    categories: (Array.isArray(raw.categories) ? raw.categories : []).filter(item => CATEGORY_IDS.has(item?.id)).map(item => ({
      id: item.id, label: text(item.label), status: CATEGORY_STATES.has(item.status) ? item.status : "unverified",
      missing: missingDependencies(item.missing), entrypoints: entrypoints(item.entrypoints),
    })),
    tools: Array.isArray(raw.tools) ? raw.tools.map(runtimeTool) : [],
    catalog: {
      schemaVersion: SCHEMA, generatedAt: text(catalog.generatedAt), evidenceNotice: text(catalog.evidenceNotice),
      source: { pin: sha(catalog.source?.pin), tree: sha(catalog.source?.tree) },
      ...arrays,
    },
  };
}

export async function readVideoRuntime(videoRuntime, kind) {
  if (!videoRuntime) {
    if (kind === "status") return publicVideoStatus({ state: "not-installed" });
    throw new ApiError(503, "VIDEO_RUNTIME_UNAVAILABLE", "视频运行环境未安装，请运行本地安装与诊断命令。");
  }
  let raw;
  try {
    raw = await videoRuntime[kind]();
  } catch {
    throw new ApiError(503, "VIDEO_RUNTIME_UNAVAILABLE", "视频运行环境读取失败，请运行本地诊断。");
  }
  return kind === "status" ? publicVideoStatus(raw) : publicVideoCapabilities(raw);
}

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AUTO_GATES, GATE_PRODUCER_STAGE, gateDeterministicChecks, portraitGateEvidence, portraitReviewManifest,
  renderSubmitAutoAllowed,
} from "./gate-policy.js";
let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "portrait-proof-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function fixture() {
  const root = path.join(dir, "characters", "P1"); mkdirSync(root, { recursive: true });
  const files: Record<string, string> = {};
  for (const angle of ["front", "threeQuarter", "closeup", "side"]) {
    files[angle] = path.join(root, `${angle}.png`); writeFileSync(files[angle]!, Buffer.from([137,80,78,71,13,10,26,10,1,2]));
  }
  const index = { schemaVersion: "workloom.portrait-index/v1", projectId: "P1", characters: { c1: { kind: "character", id: "c1", files } }, products: {} };
  const indexPath = path.join(root, "portrait-index.json"); writeFileSync(indexPath, JSON.stringify(index));
  const input = { workDir: dir, projectId: "P1", stage: { status: "completed", characters: 1, products: 0, completedPortraits: 4, pendingPortraits: 0 }, scriptReport: { characters_count: 1 } };
  return { root, files, index, indexPath, input };
}
describe("服务预生产 G5/G7", () => {
  it("G7 是文字预生产收口，不错误调用要求成片和听音回执的 master", () => expect(GATE_PRODUCER_STAGE.G7_FINAL).toBe("prompt"));
  it("只把实际读取的本项目四角度图片送审", () => {
    const f = fixture(); const evidence = portraitGateEvidence(f.input);
    expect(evidence.notApplicable).toBe(false); expect(evidence.deterministic.every(item => item.pass)).toBe(true);
    expect(evidence.artifacts.filter(item => item.kind === "image").map(item => item.path)).toEqual(Object.values(f.files).map(file => realpathSync(file)));
  });
  it.each(["missing-angle", "empty", "other-project", "escape", "symlink", "pending", "count"])("%s 证据失败关闭", kind => {
    const f = fixture();
    if (kind === "missing-angle") delete f.index.characters.c1.files.side;
    if (kind === "empty") writeFileSync(f.files.front!, "");
    if (kind === "other-project") f.index.projectId = "P2";
    if (kind === "escape") { f.index.characters.c1.files.front = path.join(dir, "outside.png"); writeFileSync(f.index.characters.c1.files.front, "image"); }
    if (kind === "symlink") { rmSync(f.files.front!); symlinkSync(f.files.side!, f.files.front!); }
    if (kind === "pending") f.input.stage.pendingPortraits = 1;
    if (kind === "count") f.input.stage.characters = 2;
    writeFileSync(f.indexPath, JSON.stringify(f.index));
    const result = portraitGateEvidence(f.input);
    expect(result.notApplicable).toBe(false); expect(result.deterministic.some(item => item.hard && !item.pass)).toBe(true);
    expect(result.artifacts).toEqual([]);
  });
  it("不适用需要本次明确无任务及剧本角色数零；空图本身不构成 N/A", () => {
    expect(portraitGateEvidence({ workDir: dir, projectId: "P1", stage: {}, scriptReport: {} }).notApplicable).toBe(false);
    const input = { workDir: dir, projectId: "P1", stage: { status: "skipped", reason: "no-characters-or-products" }, scriptReport: { characters_count: 0 } };
    expect(portraitGateEvidence(input)).toMatchObject({ notApplicable: true, deterministic: [{ status: "not_applicable" }] });
    expect(portraitGateEvidence({ ...input, scriptReport: { characters_count: 1 } }).notApplicable).toBe(false);
  });
});

describe("默认门策略（T-2026-1001-0007）：机器不替人类做决定", () => {
  it("G5 定妆照默认人审：不在 AUTO_GATES 默认表里", () => {
    expect(AUTO_GATES.has("G5_PORTRAIT")).toBe(false);
    expect(AUTO_GATES.has("G2_THEME")).toBe(true);
  });

  it("渲染提交默认人审：只有显式 WORKLOOM_RENDER_AUTO=1 才自动放行", () => {
    expect(renderSubmitAutoAllowed({})).toBe(false);
    expect(renderSubmitAutoAllowed({ WORKLOOM_RENDER_AUTO: "0" })).toBe(false);
    expect(renderSubmitAutoAllowed({ WORKLOOM_RENDER_AUTO: "1" })).toBe(true);
  });

  it("人类验收清单逐张列出定妆照文件与指纹（放行前可核对原图）", () => {
    const f = fixture();
    const manifest = portraitReviewManifest({ workDir: dir, projectId: "P1" });
    expect(manifest.files).toHaveLength(4);
    expect(manifest.markdown).toContain("放行前请逐张看过原图");
    expect(manifest.markdown).toContain("角色 c1（front）");
    expect(manifest.markdown).toContain("sha256");
    expect(manifest.files.every((entry) => entry.sha256.length === 64)).toBe(true);
    expect(f.files.front).toBeTruthy();
  });
});

it("营销G1允许合法JSON空值，拒绝仅摘要或旧自报档案", () => {
  const good = {
    facts: {
      schemaVersion: "workloom.marketing-facts/v1",
      stages: [
        { stage: "A1", facts: { status: "source_bound", claims: [], payload: { identity: { name: "合成服务" }, images: [] } } },
        { stage: "A2", facts: { status: "no_evidence", claims: [], payload: { reviews: [] } } },
        { stage: "A3", facts: { status: "no_evidence", claims: [], payload: { competitors: [] } } },
      ],
      sources: [{ sourceId: "SRC-1" }],
      restrictions: [],
      dossier: { identity: {}, provenance: [], pros_cons: { pros: [] } },
      cards: {
        insight_card: { consensus_points: [], market_position: { our_opening: [] } },
        theme_card: { differentiation_space: [] },
        prd_card: { compliance_redlines: [] },
        portrait_manifest: { reference_images: [] },
      },
    },
    integrity: { schemaVersion: "workloom.g1-content-integrity/v1", algorithm: "sha256", factsSha256: "a".repeat(64),
      factsHashScope: "canonical facts", evidenceHashPolicy: "producer evidence binds exact bytes" },
  };
  expect(gateDeterministicChecks("G1_DOSSIER", JSON.stringify(good)).every(check => check.pass)).toBe(true);
  for (const bad of ["商品事实摘要".repeat(100), JSON.stringify({ ...good, facts: { ...good.facts, stages: [1] } }), "null"]) expect(gateDeterministicChecks("G1_DOSSIER", bad).some(check => check.hard && !check.pass)).toBe(true);
});

it("营销G1确定性拒绝媒体冒充官方、无证据共识/差异、红线遗漏、图片授权和价格日期缺口", () => {
  const invalid: any = {
    facts: {
      schemaVersion: "workloom.marketing-facts/v1",
      stages: [
        { stage: "A1", facts: { status: "source_bound", claims: [], payload: { identity: { name: "合成商品" }, images: [{ url: "https://media.example.com/a.png", page_url: "https://source.example.com", angle: "unknown" }] } } },
        { stage: "A2", facts: { status: "no_evidence", claims: [], payload: { reviews: [] } } },
        { stage: "A3", facts: { status: "no_evidence", claims: [], payload: { competitors: [] } } },
      ],
      sources: [{ sourceId: "SRC-1" }],
      restrictions: ["没有可核实竞品证据：禁止竞品对比", "不写销量、价格或绝对性能结论"],
      dossier: {
        identity: { price_band: "CNY 128000" },
        provenance: [{ evidence_id: "EV-1", channel_class: "unknown" }],
        pros_cons: { pros: [{ point: "媒体转述", claim_nature: "official", source_refs: ["EV-1"] }] },
      },
      cards: {
        insight_card: { consensus_points: [{ point: "用户共识" }], market_position: { our_opening: ["差异"] } },
        theme_card: { differentiation_space: ["差异"] },
        prd_card: { compliance_redlines: [], hook_candidates: { data_points: ["价格带：CNY 128000"] }, reference_image_policy: { licensed_for_delivery: true } },
        portrait_manifest: { reference_images: [{ license_risk: "high" }] },
        brief_card: { productHero: { heroImageId: "x", licensed_for_delivery: true } },
        router_material: { hook_material: { data_points: ["价格带：CNY 128000"] } },
      },
    },
    integrity: { schemaVersion: "workloom.g1-content-integrity/v1", algorithm: "sha256", factsSha256: "a".repeat(64),
      factsHashScope: "canonical facts", evidenceHashPolicy: "producer evidence binds exact bytes" },
  };
  const check = gateDeterministicChecks("G1_DOSSIER", JSON.stringify(invalid)).find(item => item.id === "marketing-evidence-integrity")!;
  expect(check.pass).toBe(false);
  expect(check.detail).toContain("声称official");
  expect(check.detail).toContain("用户共识");
  expect(check.detail).toContain("差异化空位");
  expect(check.detail).toContain("PRD合规红线遗漏");
  expect(check.detail).toContain("高授权风险图片");
  expect(check.detail).toContain("图片授权限制未内联");
  expect(check.detail).toContain("hook/creative字段仍分发价格");
  expect(check.detail).toContain("价格缺少来源页面日期");
});

it("明确商品时G1必须绑定A1已接受真实图，外观授权由宿主结构化产生", () => {
  const base: any = {
    facts: {
      schemaVersion: "workloom.marketing-facts/v1",
      stages: [
        { stage: "A1", facts: { status: "source_bound", payload: { identity: { name: "合成商品" }, images: [] } } },
        { stage: "A2", facts: { status: "no_evidence" } },
        { stage: "A3", facts: { status: "no_evidence" } },
      ],
      sources: [{ sourceId: "SRC-1" }],
    },
    requestedMetadata: { brief: { product: "合成商品" } },
  };
  const missing = gateDeterministicChecks("G1_DOSSIER", JSON.stringify(base));
  expect(missing.find(check => check.id === "product-visual-authority")).toMatchObject({ pass: false, hard: true });
  base.facts.stages[0]!.facts.payload.images.push({
    url: "https://media.example.com/product.png",
    page_url: "https://source.example.com/product",
    angle: "unknown",
  });
  const present = gateDeterministicChecks("G1_DOSSIER", JSON.stringify(base));
  expect(present.find(check => check.id === "product-visual-authority")).toMatchObject({
    pass: true, detail: expect.stringContaining("1 张本次 G1 已接受图片"),
  });
});

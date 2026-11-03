/** Live PG/RLS and the pinned native product portrait planner and executor. Image HTTP is a fixture. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { createPortraitRuntime, installPortraitArchivePlanBridge, withPortraitArchivePlan,
  type PortraitRuntime, type PortraitRuntimePlan } from "@hyperreality/video-studio";
import { resolveStudioProductReferences } from "./studio-product-references.js";
import { upsertProductProfileFromDossier } from "./media/products.js";

const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_APP_URL);
const repo = path.resolve(import.meta.dirname, "../../../..");
const { PortraitStudio } = createRequire(import.meta.url)(path.join(repo, "vendor/supermickey/hyperreality-system/engines/portrait-studio/index.js")) as {
  PortraitStudio: new (input: { executor: string; mode: string }) => {
    plan(context: Record<string, unknown>): PortraitRuntimePlan;
    execute(plan: PortraitRuntimePlan, runtime: PortraitRuntime): Promise<{ executed: number; failed: number }>;
  };
};

describe.runIf(RUN_DB)("current Studio product image authority", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });
  const gateway = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });
  const scope = { tenantId: `test-tenant-${randomUUID()}`, workspaceId: `test-workspace-${randomUUID()}` };
  const other = { tenantId: `test-tenant-${randomUUID()}`, workspaceId: `test-workspace-${randomUUID()}` };
  const projectId = `test-project-${randomUUID()}`, otherProject = `test-project-${randomUUID()}`;
  let root: string;
  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "studio-product-refs-")));
    for (const ctx of [scope, other]) {
      await owner.query("INSERT INTO tenants(id,name,plan) VALUES ($1,'图片凭据测试','community')", [ctx.tenantId]);
      await owner.query("INSERT INTO workspaces(id,tenant_id,name,slug) VALUES ($1,$2,'隔离工作区',$1)", [ctx.workspaceId, ctx.tenantId]);
    }
    for (const id of [projectId, otherProject]) {
      await owner.query("INSERT INTO video_projects(id,workspace_id,title,kind,created_by) VALUES ($1,$2,'图片凭据项目','marketing','fixture')", [id, scope.workspaceId]);
    }
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await Promise.all([app.end(), gateway.end(), owner.end(), rm(root, { recursive: true, force: true })]);
  });
  async function asset(options: { workspaceId?: string; projectId?: string; sourceType?: string; risk?: string; status?: string; link?: boolean; invalidImage?: boolean } = {}) {
    const id = `test-image-${randomUUID()}`;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVmsAAAAASUVORK5CYII=", "base64");
    const bytes = Buffer.concat([options.invalidImage ? Buffer.from("not an image") : png, Buffer.from(id), Buffer.alloc(1_024)]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const workspaceId = options.workspaceId ?? scope.workspaceId;
    const relative = `upload/${workspaceId}/${sha256}.png`, file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    if (options.link) {
      const external = path.join(root, `${id}.png`); await writeFile(external, bytes); await symlink(external, file);
    } else await writeFile(file, bytes);
    await owner.query(`INSERT INTO video_assets(id,workspace_id,project_id,chain_id,kind,source_url,license_risk,sha256,meta,status,source_type,created_by)
      VALUES($1,$2,$3,$1,'upload_image','fixture',$4,$5,$6,$7,$8,'fixture')`,
    [id, workspaceId, options.projectId ?? null, options.risk ?? "unknown", sha256, { localPath: relative }, options.status ?? "registered", options.sourceType ?? "uploaded"]);
    return { id, relative, file, bytes };
  }
  function product(id: string, images: unknown[]) { return { id, name: id, referenceManifest: { reference_images: images } }; }
  async function resolveRefs(products: ReturnType<typeof product>[]) {
    vi.stubEnv("WORKLOOM_MEDIA_DIR", root);
    return resolveStudioProductReferences({ app, scope, projectId, repositoryRoot: repo, metadata: { products } });
  }

  it("passes two separately registered SKUs through the actual vendor plan/execution and preserves each wire image", async () => {
    const first = await asset({ projectId }), second = await asset();
    const products = [product("fixture-a", [{ assetId: first.id }]), product("fixture-b", [{ localPath: second.relative }])];
    const refs = await resolveRefs(products);
    expect(refs.map(item => [item.productId, item.files[0]?.path])).toEqual([["fixture-a", first.file], ["fixture-b", second.file]]);
    const sent: string[] = [];
    const runtime = createPortraitRuntime({ workDir: path.join(root, "runtime"), projectId, apiKey: "fixture-only", model: "fixture-model",
      trustedProductReferences: refs, fetchImpl: async (_url, init) => {
        if (init?.method !== "POST") return new Response(new Uint8Array(2048));
        sent.push(JSON.parse(String(init.body)).image);
        return new Response(JSON.stringify({ data: [{ url: "https://cdn.example.invalid/fixture.png" }] }));
      } });
    const vendor = new PortraitStudio({ executor: "api", mode: "auto" });
    const dispose = installPortraitArchivePlanBridge();
    try {
      const result = await withPortraitArchivePlan(runtime, async () => vendor.execute(vendor.plan({ products }), runtime));
      expect(result).toMatchObject({ executed: 10, failed: 0 });
      expect(sent).toEqual([first, second].flatMap(item => Array<string>(5).fill(`data:image/png;base64,${item.bytes.toString("base64")}`)));
      await writeFile(first.file, Buffer.alloc(first.bytes.length, 1));
      await expect(runtime.searchReferences({ productId: "fixture-a" })).rejects.toThrow("PORTRAIT_PRODUCT_REFERENCE_CHANGED");
      await expect(runtime.apiRender({ productId: "fixture-b", view: "front" }, first.file)).rejects.toThrow("PORTRAIT_PRODUCT_REFERENCE_INVALID");
      expect(sent).toHaveLength(10);
    } finally { dispose(); }
  });

  it("rejects another tenant/project, archived or rights-unknown import, symlinks and a mislabeled file", async () => {
    for (const candidate of [await asset({ workspaceId: other.workspaceId }), await asset({ projectId: otherProject }),
      await asset({ status: "archived" }), await asset({ sourceType: "imported", risk: "unknown" }), await asset({ link: true }),
      await asset({ invalidImage: true })]) {
      await expect(resolveRefs([product("fixture-denied", [{ assetId: candidate.id }])])).rejects.toThrow("PORTRAIT_PRODUCT_REFERENCE_INVALID");
    }
    expect(await resolveRefs([product("fixture-url", [{ url: "https://vendor.example.invalid/citation.png" }])])).toEqual([]);
  });

  it("MC-008 refuses a dossier hero URL targeting an actual loopback HTTP server", async () => {
    let requests = 0;
    const http = createServer((_req, res) => { requests++; res.end("private service response fixture"); });
    await new Promise<void>(done => http.listen(0, "127.0.0.1", done));
    try {
      const address = http.address();
      if (!address || typeof address === "string") throw new Error("fixture listen failed");
      const input = { dossierRoot: path.join(root, "dossiers"), productId: "loopback-hero", by: "fixture" };
      const dir = path.join(input.dossierRoot, input.productId);
      await mkdir(path.join(dir, "images"), { recursive: true });
      await writeFile(path.join(dir, "dossier.json"), JSON.stringify({ product_id: input.productId, identity: { name: "商品图边界" } }));
      await writeFile(path.join(dir, "images", "manifest.json"), JSON.stringify({ hero_image_id: "img-1",
        reference_images: [{ id: "img-1", url: `http://127.0.0.1:${address.port}/private`, license_risk: "none" }] }));
      vi.stubEnv("WORKLOOM_MEDIA_DIR", root);
      vi.stubEnv("MEDIA_SIGNING_SECRET", "fixture-only-media-signing");
      const result = await upsertProductProfileFromDossier(app, gateway, scope, input);
      expect(requests).toBe(0);
      expect(result.profile.heroAssetId).toBeNull();
    } finally { await new Promise<void>((done, reject) => http.close(error => error ? reject(error) : done())); }
  });

  it("MC-008 refreshes the exact current image even when dossier.json is unchanged", async () => {
    const input = { dossierRoot: path.join(root, "dossiers"), productId: "strict-local-hero", by: "fixture", fetchHero: false };
    const dir = path.join(input.dossierRoot, input.productId), images = path.join(dir, "images");
    await mkdir(images, { recursive: true });
    await writeFile(path.join(dir, "dossier.json"), JSON.stringify({ product_id: input.productId, identity: { name: "主图变化" } }));
    const manifest = (id: string) => writeFile(path.join(images, "manifest.json"), JSON.stringify({ hero_image_id: id,
      reference_images: [{ id }, { id: "img-10" }] }));
    await manifest("img-1");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVmsAAAAASUVORK5CYII=", "base64");
    await writeFile(path.join(images, "img-10.png"), Buffer.concat([png, Buffer.from("wrong image")]));
    vi.stubEnv("WORKLOOM_MEDIA_DIR", root);
    vi.stubEnv("MEDIA_SIGNING_SECRET", "fixture-only-media-signing");
    const missing = await upsertProductProfileFromDossier(app, gateway, scope, input);
    expect(missing.profile.heroAssetId).toBeNull();
    await manifest("img-2");
    await writeFile(path.join(images, "img-2.png"), Buffer.concat([png, Buffer.from("current image")]));
    const selected = await upsertProductProfileFromDossier(app, gateway, scope, input);
    expect(selected.heroError).toBeNull();
    expect(selected.profile.heroAssetId).not.toBeNull();
    expect(selected.changed).toBe(true);
    expect(selected.profile.dossierSha256).toBe(missing.profile.dossierSha256);
    await rm(path.join(images, "img-2.png"));
    const removed = await upsertProductProfileFromDossier(app, gateway, scope, input);
    expect(removed.profile.heroAssetId).toBeNull();
    expect(removed.changed).toBe(true);
  });
});

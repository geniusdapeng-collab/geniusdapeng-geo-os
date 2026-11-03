import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadToMediaStore, storeLocalFile } from "./ingest.js";
import { fetchPublicProviderMedia } from "./public-provider-media.js";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "render-ingest-"));
  vi.stubEnv("WORKLOOM_MEDIA_DIR", join(directory, "store"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe("rendered media bytes and ingest bounds", () => {
  it("does not open provider-supplied loopback URLs or DNS answers containing internal IPs", async () => {
    let reached = 0;
    const server = createServer((_request, response) => { reached++; response.end("internal fixture"); });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("fixture has no port");
      await expect(downloadToMediaStore(`http://127.0.0.1:${address.port}/result`, { workspaceId: "fixture" }))
        .rejects.toThrow(/SOURCE_URL_(?:PRIVATE|INVALID)/);
      expect(reached).toBe(0);
      await expect(fetchPublicProviderMedia("https://media.example.com/signed-result", AbortSignal.timeout(1_000), async () => [
        { address: "8.8.8.8", family: 4 }, { address: "169.254.169.254", family: 4 },
      ])).rejects.toThrow(/SOURCE_URL_PRIVATE/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("cuts an undeclared oversize download short and publishes no partial asset", async () => {
    let pulled = 0, cancelled = false;
    const fixture = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++pulled <= 16) controller.enqueue(new Uint8Array(32).fill(pulled));
        else controller.close();
      },
      cancel() { cancelled = true; },
    });
    const fetchImpl = (async () => new Response(fixture, { headers: { "content-type": "video/mp4" } })) as typeof fetch;
    await expect(downloadToMediaStore("https://media.example.test/clip.mp4", { workspaceId: "fixture", maxBytes: 64, fetchImpl }))
      .rejects.toThrow(/超过大小上限/);
    expect(pulled).toBeLessThan(16);
    expect(cancelled).toBe(true);
    expect(readdirSync(join(directory, "store", "video", "fixture"))).toEqual([]);
  });

  it("refuses an empty remote result and does not publish it as a successful local asset", async () => {
    await expect(downloadToMediaStore("https://media.example.test/empty.mp4", {
      workspaceId: "fixture", fetchImpl: (async () => new Response(null)) as typeof fetch,
    })).rejects.toThrow(/为空/);
  });

  it("writes exactly the hashed local bytes and rejects a mismatching existing content address", () => {
    const file = join(directory, "fixture.mp4");
    const bytes = Buffer.from("local fixture video bytes");
    writeFileSync(file, bytes);
    const result = storeLocalFile(file, { workspaceId: "fixture" });
    expect(readFileSync(result.absPath)).toEqual(bytes);
    expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(storeLocalFile(file, { workspaceId: "fixture" })).toEqual(result);
    writeFileSync(result.absPath, Buffer.alloc(bytes.length, 0xff));
    expect(() => storeLocalFile(file, { workspaceId: "fixture" })).toThrow(/字节不符/);
    expect(readFileSync(result.absPath)).toEqual(Buffer.alloc(bytes.length, 0xff));
  });

  it("rejects a local symlink and a workspace path escape", () => {
    const source = join(directory, "original.mp4"), link = join(directory, "symlink.mp4");
    writeFileSync(source, "fixture");
    symlinkSync(source, link);
    expect(() => storeLocalFile(link, { workspaceId: "fixture" })).toThrow();
    expect(() => storeLocalFile(source, { workspaceId: "../../escaped" })).toThrow(/工作区/);
  });
});

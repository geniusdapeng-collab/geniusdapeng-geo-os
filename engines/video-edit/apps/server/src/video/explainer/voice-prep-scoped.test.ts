import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { prepareVoice } from "./voice-prep.js";

it.each(["accepted", "connection-lost", "wrong-path"])("scoped speech uses exact station bytes or holds one unresolved POST (%s)", async scenario => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "scoped-voice-")));
  mkdirSync(join(root, "deliveries"));
  const source = join(root, "fixture.wav");
  const ffmpeg = process.env.WL_FFMPEG || "ffmpeg";
  const wave = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=d=0.25",
    "-ac", "1", "-ar", "24000", source], { encoding: "utf8" });
  expect(wave.status, wave.stderr).toBe(0);
  const bytes = readFileSync(source);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const requests: Array<{ tool: string; params: { tenant_id: string; out: string; profile: string } }> = [];
  const server = createServer((req, res) => {
    const body: Buffer[] = [];
    req.on("data", data => body.push(data));
    req.on("end", () => {
      const input = JSON.parse(Buffer.concat(body).toString("utf8")) as typeof requests[number];
      requests.push(input);
      if (scenario === "connection-lost") { res.destroy(); return; }
      if (scenario === "accepted") {
        mkdirSync(dirname(input.params.out), { recursive: true });
        writeFileSync(input.params.out, bytes);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { out: scenario === "accepted" ? input.params.out : source }, receipt: { sha256 } }));
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const port = (server.address() as { port: number }).port;
    const env = { ...process.env, WORKLOOM_VOICE_BRIDGE_URL: `http://127.0.0.1:${port}`,
      WORKLOOM_VOICE_BRIDGE_TOKEN: "local-fixture-token", WORKLOOM_VOICE_STATION_DIR: root, FFMPEG_PATH: ffmpeg };
    const input = { source: "tts" as const, text: "按原请求生成。", profile: "scoped-profile",
      stationScope: "workspace-fixture", env, timeoutMs: 1000 };
    if (scenario === "accepted") {
      const first = await prepareVoice({ ...input, jobDir: join(root, "job-1") });
      const resumed = await prepareVoice({ ...input, jobDir: join(root, "job-2") });
      expect(first.sha256).toBe(resumed.sha256);
      expect(first.bytes).toBeGreaterThan(0);
      expect(readdirSync(join(root, "deliveries")).filter(name => name.endsWith(".receipt.json"))).toHaveLength(1);
    } else {
      await expect(prepareVoice({ ...input, jobDir: join(root, "job-1") })).rejects.toThrow("VOICE_POST_UNVERIFIED");
      await expect(prepareVoice({ ...input, jobDir: join(root, "job-2") })).rejects.toThrow("VOICE_POST_UNVERIFIED");
      expect(readdirSync(join(root, "deliveries"))).toEqual([expect.stringMatching(/\.pending\.json$/)]);
    }
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ tool: "voicewrite.speak", params: { tenant_id: input.stationScope, profile: input.profile } });
  } finally {
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    rmSync(root, { recursive: true, force: true });
  }
});

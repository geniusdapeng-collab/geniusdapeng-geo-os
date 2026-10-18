import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { JsonStore } from "../src/storage/json-store.mjs";
import { loadSeedState } from "../src/services/bootstrap.mjs";
import { GeoOsService } from "../src/services/geo-os-service.mjs";
import { LivePipelineService } from "../src/services/live-pipeline.mjs";

const rootDir = resolve(import.meta.dirname, "..");
const dataDir = join(rootDir, "data", "seed");
const now = () => new Date("2026-10-18T12:30:00.000Z");

test("current-model content can pass the evidence state machine and receive a platform receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pengstack-live-"));
  const filePath = join(directory, "state.json");

  try {
    const store = new JsonStore({ filePath, clock: now });
    await store.open(() => loadSeedState(dataDir));
    const service = new GeoOsService({ store, clock: now });
    const deepSeek = {
      async health() {
        return { ok: true };
      },
      async generateContent() {
        return {
          title: "为什么 GEO 需要证据控制面",
          body: "GEO 不是让模型说好话，而是让正确事实可验证、可引用、可复测。",
          hook: "证据先于内容",
          cta: "查看项目",
          hashtags: ["#GEO"],
          model: "deepseek-flash",
          responseId: "resp-test",
          usage: { total_tokens: 100 },
          responseHash: "a".repeat(64),
        };
      },
    };
    const github = {
      async health() {
        return { ok: true, configured: true };
      },
      async createIssue(input) {
        assert.match(input.body, /可验证/);
        return {
          id: 1,
          number: 1,
          url: "https://github.com/owner/repo/issues/1",
          createdAt: now().toISOString(),
          receiptHash: "b".repeat(64),
        };
      },
    };
    const unused = {
      async health() {
        return { configured: false };
      },
    };
    const live = new LivePipelineService({
      service,
      deepSeek,
      github,
      geoEvidence: unused,
      videoEdit: unused,
      clock: now,
    });

    await service.approveClaim("C003", {
      approvedBy: "Dapeng Li",
      publicLevel: "private",
    });
    await store.mutate({ type: "account.activated", actor: "test" }, (state) => {
      const account = state.accounts.find((item) => item.id === "github");
      account.status = "active";
      account.policyStatus = "reviewed";
      return account;
    });

    const generated = await live.generateContent({
      brief: "解释证据优先的 GEO",
      claimIds: ["C003"],
      platform: "GitHub",
    });
    const contentId = generated.content.id;
    for (const target of ["fact_check", "approved", "scheduled"]) {
      await service.transitionContent(contentId, {
        target,
        actor: "Dapeng Li",
        approvedBy: "Dapeng Li",
      });
    }
    const published = await live.publishContentToGitHub({ contentId });
    assert.equal(published.issue.number, 1);
    assert.equal(published.publication.dataMode, "real");
    assert.equal(
      store.snapshot().content.find((item) => item.id === contentId).status,
      "published",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

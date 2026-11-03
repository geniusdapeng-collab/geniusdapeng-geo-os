import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { compileCreativeContract, creativeTextHash, extractProductVisualAuthority, CREATIVE_ART_DIMENSIONS, UNVERIFIED_MIRROR_DETAIL_RULE, CreativeRuntime, withCreativeBudget, type CreativeModelOutcome } from "@hyperreality/video-studio";
import { describe, expect, it } from "vitest";
import { generateCreativeAssessments } from "./creative-api-service.js";
import type { ProductionProductReference } from "./studio-product-references.js";

const model = "deepseek-flash";
const contract = compileCreativeContract({
  scope: { tenantId: "candidate-tenant", workspaceId: "candidate-workspace", projectId: "candidate-project" },
  rawIntent: "窗边光影故事短片，成片时长10秒。",
  requiredFields: ["画面"],
});
const shot = {
  shotId: "S1", sceneId: "SC1", duration: 10, purpose: "窗边光影渐次转暖", subject: "窗台", action: "光斑沿窗台移动",
  sound: "", textLayers: [], fields: { 画面: "固定近景，光斑移动" }, fieldOrder: ["画面"], prompt: "窗台光斑近景",
};
const wrongShot = { ...shot, duration: "10秒", untrustedSecretKey: "UNTRUSTED-RAW-OUTPUT" };
type Request = { model: string; response_format: { type: string }; messages: Array<{ role: string; content: string }> };
type Fixtures = (user: Record<string, any>, index: number) => {
  value?: unknown; content?: string; usage?: "missing"; finishReason?: "stop" | "length";
};
const expectedKeys = (value: Record<string, unknown>) => Object.keys(value).sort();
const goodReview = (user: Record<string, any>) => ({
  contractHash: user.contractHash, candidateHash: user.candidateHash, rubricVersion: user.rubricVersion, findings: [],
  scores: Object.fromEntries(CREATIVE_ART_DIMENSIONS.map(key => [key, { score: 84, evidence: "S1 的光斑移动与固定构图" }])),
});

async function withFixture<T>(fixture: Fixtures, run: (endpoint: { model: string; baseUrl: string; apiKey: string }, requests: Request[], hashes: string[]) => Promise<T>) {
  const requests: Request[] = [], hashes: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Request;
    requests.push(body);
    const { value, content, usage, finishReason = "stop" } = fixture(JSON.parse(body.messages.at(-1)!.content), requests.length);
    const raw = JSON.stringify({ id: `fixture-response-${requests.length}`, model,
      choices: [{ finish_reason: finishReason, message: { content: content ?? JSON.stringify(value) } }],
      ...(usage === "missing" ? {} : { usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }) });
    hashes.push(createHash("sha256").update(raw).digest("hex"));
    res.setHeader("content-type", "application/json");
    res.end(raw);
  });
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("loopback fixture did not bind");
    return await run({ model, baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "local-fixture" }, requests, hashes);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

function budget(settlements: CreativeModelOutcome[] = []) {
  return {
    beforeModelCall: async () => settlements.length + 1,
    afterModelCall: async (_reservation: unknown, outcome: CreativeModelOutcome) => { settlements.push(outcome); },
  };
}

describe("current owner product image in exact candidate and independent review inputs", () => {
  const runId = "candidate-product-run", productName = "合成示例产品 A1";
  const sourceUrl = "https://product-fixture.invalid/registered.jpg", pageUrl = "https://product-fixture.invalid/a1";
  const sourceMetadata = { brief: { product: productName, duration: 10,
    productionRequirements: { visualMode: "verified_product_appearance" } } };
  const rawIntent = "只展示已授权产品实物外观，成片时长10秒。";
  const content = JSON.stringify({ requestedIntent: rawIntent, requestedMetadata: sourceMetadata, facts: {
    schemaVersion: "workloom.marketing-facts/v1", issuer: "workloom.marketing-authority",
    scope: { ...contract.scope, runId, attempt: 1 }, productQuery: { name: productName },
    stages: [{ stage: "A1", facts: { payload: { images: [{ url: sourceUrl, page_url: pageUrl }] } } }],
    cards: { portrait_manifest: { reference_images: [{ id: "research-card", url: sourceUrl, license_risk: "high" }] } },
  } });
  const marketing = compileCreativeContract({ scope: contract.scope, rawIntent, metadata: sourceMetadata, isMarketing: true,
    requiredFields: ["画面"], facts: { content, hash: creativeTextHash(content), claims: [] } });
  const visual = extractProductVisualAuthority(content);
  const ref: ProductionProductReference = { productId: "fixture-product", productName, assetId: "VA-fixture",
    sourceUrl, pageUrl, sha256: "e".repeat(64), authorizationBasis: "owner-confirmed-reference-use",
    projectId: contract.scope.projectId, rawIntentSha256: marketing.rawIntentHash,
    relativePath: "PRIVATE-REGISTERED-FILE", bytes: 2048, mimeType: "image/jpeg", ownerManifestSha256: "f".repeat(64) };
  const inspected: ProductionProductReference = { ...ref, productId: "zxmoto-820rr-rc",
    sha256: "575d2bb914d62fafecfa34e16dd8b37ce06e5f020ff1872a7d9a8b489c2e888d" };

  it("binds the exact registered image to the candidate hash before independent review", async () => {
    await withFixture(user => ({ value: user.candidateHash ? goodReview(user) : { shots: [shot] } }),
      async (endpoint, requests, hashes) => {
        const result = await withCreativeBudget(budget(), () => generateCreativeAssessments({ contract: marketing,
          endpoint, runId, visual, trustedProductReferences: [ref], count: 1, assertCurrent: async () => {} }));
        const opaque = "product:sha256:" + ref.sha256;
        const [generation, review] = requests.map(request => JSON.parse(request.messages.at(-1)!.content));
        expect(requests).toHaveLength(2);
        expect(generation.outputContract.schema.properties.shots.items.properties).not.toHaveProperty("assetRefs");
        expect(generation.trustedProductReferences).toMatchObject([{ ref: opaque, assetId: ref.assetId, productName,
          sha256: ref.sha256, ownerManifestSha256: ref.ownerManifestSha256,
          authorizationBasis: "owner-confirmed-reference-use", g1ContentSha256: marketing.facts!.hash, g1ImageIndex: 0 }]);
        expect(review.trustedProductReferences).toEqual(generation.trustedProductReferences);
        expect(review.shots[0].assetRefs).toEqual([opaque]);
        expect(result.selected?.shots[0]?.assetRefs).toEqual([opaque]);
        expect(result.selected?.review).toMatchObject({ candidateHash: review.candidateHash, responseHash: hashes[1] });
        expect(JSON.stringify(requests)).not.toContain(ref.relativePath);
        expect(result.selected?.trustedProductReferences).toEqual(review.trustedProductReferences);
        const options = {
          contract: marketing, model, nativeSchemaHash: "a".repeat(64), visualAuthority: visual,
          fields: { keys: ["scene"], labels: { scene: "画面" } },
          cache: { read: async () => null, write: async () => {} },
          generate: async () => { throw new Error("unexpected model call"); },
        };
        const runtime = new CreativeRuntime({ ...options, selectedCandidate: result.selected! });
        const downstream = runtime.selectionContext();
        expect(downstream).toContain("workloom.registered-product-reference/v1");
        expect(downstream).toContain("licensed_for_delivery 原样适用其公开素材");
        expect(downstream).toContain(opaque);
        expect(downstream).not.toContain(ref.relativePath);
        const corrupted = structuredClone(result.selected!);
        corrupted.trustedProductReferences![0]!.g1ContentSha256 = "0".repeat(64);
        expect(() => new CreativeRuntime({ ...options, selectedCandidate: corrupted })).toThrow("CREATIVE_PRODUCT_REFERENCE_UNVERIFIED");
      });
  });

  it.each([
    ["missing", []],
    ["different project", [{ ...ref, projectId: "another-project" }]],
    ["different intent", [{ ...ref, rawIntentSha256: "0".repeat(64) }]],
    ["different product", [{ ...ref, productName: "Another product" }]],
    ["different G1 image", [{ ...ref, sourceUrl: "https://product-fixture.invalid/other.jpg" }]],
    ["duplicate", [ref, ref]],
  ] as const)("refuses %s owner image receipt before a model call", async (_kind, trustedProductReferences) => {
    await withFixture(() => ({ value: { shots: [shot] } }), async (endpoint, requests) => {
      await expect(withCreativeBudget(budget(), () => generateCreativeAssessments({ contract: marketing,
        endpoint, runId, visual, trustedProductReferences, count: 1, assertCurrent: async () => {} })))
        .rejects.toMatchObject({ code: "CREATIVE_PRODUCT_REFERENCE_UNVERIFIED" });
      expect(requests).toHaveLength(0);
    });
  });

  it("refuses owner product references when the exact accepted G1 belongs to another run", async () => {
    await withFixture(() => ({ value: { shots: [shot] } }), async (endpoint, requests) => {
      await expect(withCreativeBudget(budget(), () => generateCreativeAssessments({ contract: marketing, endpoint,
        runId: "another-run", visual, trustedProductReferences: [ref], count: 1, assertCurrent: async () => {} })))
        .rejects.toMatchObject({ code: "CREATIVE_PRODUCT_REFERENCE_UNVERIFIED" });
      expect(requests).toHaveLength(0);
    });
  });

  it("rejects an invented product ref in a model candidate rather than adopting it", async () => {
    await withFixture(() => ({ value: { shots: [{ ...shot, assetRefs: ["model-invented"] }] } }),
      async (endpoint, requests) => {
        const result = await withCreativeBudget(budget(), () => generateCreativeAssessments({ contract: marketing, endpoint,
          runId, visual, trustedProductReferences: [ref], count: 1, assertCurrent: async () => {} }));
        expect(result.selected).toBeNull();
        expect(result.rejected).toMatchObject([{ code: "CREATIVE_CANDIDATE_INVALID" }]);
        expect(requests).toHaveLength(1);
      });
  });

  it.each(["画面从后视镜看到追兵", "不使用后视镜，但镜头切到后视镜反光", "Camera tracks in the rear-view mirror"])(
    "rejects unsupported executable mirror content before the independent review (%s)", async action => {
      await withFixture(() => ({ value: { shots: [{ ...shot, action }] } }), async (endpoint, requests) => {
        const result = await withCreativeBudget(budget(), () => generateCreativeAssessments({
          contract: marketing, endpoint, runId, visual, trustedProductReferences: [inspected], count: 1, assertCurrent: async () => {},
        }));
        expect(result.selected).toBeNull();
        expect(result.rejected).toMatchObject([{ code: "PRODUCT_VISUAL_DETAIL_UNVERIFIED" }]);
        expect(requests).toHaveLength(1);
      });
    },
  );

  it("retains a negative instruction to omit the unverified part", async () => {
    await withFixture(user => ({ value: user.candidateHash ? goodReview(user) : {
      shots: [{ ...shot, action: "固定机位拍摄整体轮廓", fields: { 画面: UNVERIFIED_MIRROR_DETAIL_RULE } }],
    } }), async (endpoint, requests) => {
      const result = await withCreativeBudget(budget(), () => generateCreativeAssessments({
        contract: marketing, endpoint, runId, visual, trustedProductReferences: [inspected], count: 1, assertCurrent: async () => {},
      }));
      expect(result.selected?.shots[0]?.fields.画面).toBe(UNVERIFIED_MIRROR_DETAIL_RULE);
      expect(requests).toHaveLength(2);
    });
  });

  it.each([
    ["other authorized product", { ...inspected, productId: ref.productId }],
    ["other authorized source of the same product", { ...inspected, sha256: ref.sha256 }],
  ] as const)("keeps the %s with visible mirrors subject to independent review", async (_kind, reference) => {
    const action = "画面从后视镜看到追兵";
    await withFixture(user => ({ value: user.candidateHash ? goodReview(user) : { shots: [{ ...shot, action }] } }),
      async (endpoint, requests) => {
        const result = await withCreativeBudget(budget(), () => generateCreativeAssessments({
          contract: marketing, endpoint, runId, visual, trustedProductReferences: [reference], count: 1, assertCurrent: async () => {},
        }));
        expect(result.selected?.shots[0]?.action).toBe(action);
        expect(requests).toHaveLength(2);
        expect(JSON.stringify(requests[0])).not.toContain(UNVERIFIED_MIRROR_DETAIL_RULE);
      });
  });
});

describe("native creative candidate structure at the actual model transport", () => {
  it("sends complete JSON contracts, diagnoses malformed shape and uses one settled same-model successor within the candidate count", async () => {
    await withFixture((user, index) => ({
      value: user.candidateHash ? goodReview(user) : index === 1 ? { shots: [wrongShot] } : { shots: [shot] },
    }), async (endpoint, requests, hashes) => {
      const settled: CreativeModelOutcome[] = [];
      const result = await withCreativeBudget(budget(settled), () => generateCreativeAssessments({ contract, endpoint, count: 2, assertCurrent: async () => {} }));
      expect(requests).toHaveLength(3);
      expect(requests.every(req => req.model === model && req.response_format.type === "json_object")).toBe(true);
      const [first, next, review] = requests.map(request => JSON.parse(request.messages.at(-1)!.content));
      expect(first.outputContract.schema.additionalProperties).toBe(false);
      expect(first.outputContract.schema.properties.shots.items.additionalProperties).toBe(false);
      expect(first.outputContract.schema.properties.shots.items.required.sort()).toEqual(expectedKeys(shot));
      expect(expectedKeys(first.outputContract.example.shots[0])).toEqual(expectedKeys(shot));
      expect(review.outputContract.schema.properties.scores.required.sort()).toEqual([...CREATIVE_ART_DIMENSIONS].sort());
      expect(review.outputContract.example.contractHash).toBe(contract.hash);
      expect(review.outputContract.example.candidateHash).toBe(review.candidateHash);
      expect(next.structureSuccessorOf).toEqual({ requestId: "fixture-response-1", responseHash: hashes[0],
        issues: expect.arrayContaining([{ path: ["shots", 0, "duration"], code: "invalid_type" }, { path: ["shots", 0], code: "unrecognized_keys" }]) });
      expect(result.rejected[0]).toMatchObject({ code: "CREATIVE_CANDIDATE_INVALID", response: {
        phase: "generation", requestId: "fixture-response-1", responseHash: hashes[0], issues: next.structureSuccessorOf.issues,
      } });
      expect(JSON.stringify(result.rejected)).not.toMatch(/UNTRUSTED-RAW-OUTPUT|untrustedSecretKey/);
      expect(JSON.stringify(requests[1])).not.toMatch(/UNTRUSTED-RAW-OUTPUT|untrustedSecretKey/);
      expect(result.selected?.generation).toMatchObject({ model, requestId: "fixture-response-2", responseHash: hashes[1] });
      expect(result.selected?.review).toMatchObject({ model, requestId: "fixture-response-3", responseHash: hashes[2] });
      expect(settled.map(row => row.providerRequestId)).toEqual(["fixture-response-1", "fixture-response-2", "fixture-response-3"]);
    });
  });

  it("never spends a third planned slot on repeated malformed structure or follows unknown usage", async () => {
    await withFixture(() => ({ value: { shots: [wrongShot] } }), async (endpoint, requests) => {
      const result = await withCreativeBudget(budget(), () => generateCreativeAssessments({ contract, endpoint, count: 3, assertCurrent: async () => {} }));
      expect(result.selected).toBeNull();
      expect(result.rejected).toHaveLength(2);
      expect(requests).toHaveLength(2);
    });
    await withFixture(() => ({ value: { shots: [wrongShot] }, usage: "missing" }), async (endpoint, requests) => {
      await expect(withCreativeBudget(budget(), () => generateCreativeAssessments({ contract, endpoint, count: 3, assertCurrent: async () => {} })))
        .rejects.toMatchObject({ code: "CREATIVE_USAGE_UNKNOWN" });
      expect(requests).toHaveLength(1);
    });
  });

  it.each([["{UNTRUSTED-RAW-OUTPUT", "invalid_json"], ["   ", "empty_json"]])(
    "recovers a known stopped generation with one slot and safe diagnostics (%s)", async (content, code) => {
      await withFixture((user, index) => index === 1 ? { content } : ({
        value: user.candidateHash ? goodReview(user) : { shots: [shot] },
      }), async (endpoint, requests, hashes) => {
        const settled: CreativeModelOutcome[] = [];
        const result = await withCreativeBudget(budget(settled), () => generateCreativeAssessments({
          contract, endpoint, count: 2, assertCurrent: async () => {},
        }));
        const expected = { requestId: "fixture-response-1", responseHash: hashes[0], issues: [{ path: [], code }] };
        expect(requests).toHaveLength(3);
        expect(JSON.parse(requests[1]!.messages.at(-1)!.content).structureSuccessorOf).toEqual(expected);
        expect(result.rejected[0]).toMatchObject({ response: { phase: "generation", ...expected } });
        expect(result.selected?.generation.requestId).toBe("fixture-response-2");
        expect(settled.map(row => [row.usageKnown, row.success, row.finishReason]))
          .toEqual([[true, false, "stop"], [true, true, "stop"], [true, true, "stop"]]);
        expect(JSON.stringify({ requests, rejected: result.rejected })).not.toContain("UNTRUSTED-RAW-OUTPUT");
      });
    },
  );

  it.each([2, 3])("keeps the independently valid first candidate after the second review fails with %i planned slots", async count => {
    await withFixture((user, index) => index >= 4 ? { content: "{not-json" } : ({
      value: user.candidateHash ? goodReview(user) : { shots: [{ ...shot, action: shot.action + index }] },
    }), async (endpoint, requests, hashes) => {
      const settled: CreativeModelOutcome[] = [];
      const result = await withCreativeBudget(budget(settled), () => generateCreativeAssessments({
        contract, endpoint, count, assertCurrent: async () => {},
      }));
      const expectedRequests = count + 2;
      expect(requests).toHaveLength(expectedRequests);
      expect(result.selected?.review.requestId).toBe("fixture-response-2");
      expect(result.rejected[0]).toMatchObject({ code: "CREATIVE_ART_REVIEW_UNVERIFIED", response: {
        phase: "review", requestId: `fixture-response-${expectedRequests}`, responseHash: hashes[expectedRequests - 1],
        issues: [{ path: [], code: "invalid_json" }],
      } });
      expect(settled[3]).toMatchObject({ usageKnown: true, success: false, finishReason: "stop" });
    });
  });

  it.each([["{UNTRUSTED-RAW-REVIEW", "invalid_json"], ["   ", "empty_json"]])(
    "re-reviews exactly the frozen candidate after settled %s using the remaining planned slot", async (content, code) => {
      await withFixture((user, index) => index === 2 ? { content } : ({
        value: user.candidateHash ? goodReview(user) : { shots: [shot] },
      }), async (endpoint, requests, hashes) => {
        const settled: CreativeModelOutcome[] = [];
        const result = await withCreativeBudget(budget(settled), () => generateCreativeAssessments({
          contract, endpoint, count: 2, assertCurrent: async () => {},
        }));
        expect(requests).toHaveLength(3);
        const [generation, firstReview, retry] = requests.map(request => JSON.parse(request.messages.at(-1)!.content));
        const { reviewStructureRetryOf, ...retryInput } = retry;
        expect(generation).toMatchObject({ candidateOrdinal: 1 });
        expect(retryInput).toEqual(firstReview);
        expect(reviewStructureRetryOf).toEqual({ requestId: "fixture-response-2", responseHash: hashes[1], issues: [{ path: [], code }] });
        expect(requests.every(request => request.model === model && request.response_format.type === "json_object")).toBe(true);
        expect(result.selected?.generation.requestId).toBe("fixture-response-1");
        expect(result.selected?.review).toMatchObject({ candidateHash: firstReview.candidateHash, requestId: "fixture-response-3" });
        expect(result.rejected).toEqual([]);
        expect(settled.map(row => [row.usageKnown, row.success, row.finishReason])).toEqual([
          [true, true, "stop"], [true, false, "stop"], [true, true, "stop"],
        ]);
        expect(JSON.stringify(requests)).not.toContain("UNTRUSTED-RAW-REVIEW");
      });
    },
  );

  it("spends at most one further planned slot after a known malformed review", async () => {
    await withFixture((user, index) => user.candidateHash ? { content: "{not-json" } : ({
      value: { shots: [{ ...shot, action: shot.action + index }] },
    }), async (endpoint, requests) => {
      const result = await withCreativeBudget(budget(), () => generateCreativeAssessments({
        contract, endpoint, count: 3, assertCurrent: async () => {},
      }));
      expect(requests).toHaveLength(3);
      expect(result.rejected).toHaveLength(1);
      expect(result.selected).toBeNull();
    });
  });

  it.each([
    [{ content: "{", usage: "missing" }, "CREATIVE_USAGE_UNKNOWN"],
    [{ content: "{", finishReason: "length" }, "MODEL_OUTPUT_TRUNCATED"],
  ] as const)("keeps unknown usage and truncated content outside the successor path (%j)", async (fixture, code) => {
    await withFixture(() => fixture, async (endpoint, requests) => {
      await expect(withCreativeBudget(budget(), () => generateCreativeAssessments({
        contract, endpoint, count: 3, assertCurrent: async () => {},
      }))).rejects.toMatchObject({ code });
      expect(requests).toHaveLength(1);
    });
  });

  it.each([
    [{ content: "{", usage: "missing" }, "CREATIVE_USAGE_UNKNOWN"],
    [{ content: "{", finishReason: "length" }, "MODEL_OUTPUT_TRUNCATED"],
  ] as const)("stops after the first independent review when its usage or completion is unavailable (%j)", async (fixture, code) => {
    await withFixture(user => user.candidateHash ? fixture : { value: { shots: [shot] } }, async (endpoint, requests) => {
      await expect(withCreativeBudget(budget(), () => generateCreativeAssessments({
        contract, endpoint, count: 3, assertCurrent: async () => {},
      }))).rejects.toMatchObject({ code });
      expect(requests).toHaveLength(2);
    });
  });

  it("keeps review correction behind the first review's journal settlement", async () => {
    await withFixture(user => user.candidateHash ? { content: "{" } : { value: { shots: [shot] } }, async (endpoint, requests) => {
      const hooks = { ...budget(), afterModelCall: async (_reservation: unknown, outcome: CreativeModelOutcome) => {
        if (!outcome.success) throw new Error("fixture settlement failure");
      } };
      await expect(withCreativeBudget(hooks, () => generateCreativeAssessments({
        contract, endpoint, count: 3, assertCurrent: async () => {},
      }))).rejects.toMatchObject({ code: "CREATIVE_RECEIPT_UNKNOWN" });
      expect(requests).toHaveLength(2);
    });
  });

  it("does not start a successor if recording the known failure's usage fails", async () => {
    await withFixture(() => ({ content: "   " }), async (endpoint, requests) => {
      const failedJournal = { ...budget(), afterModelCall: async () => { throw new Error("fixture settlement failure"); } };
      await expect(withCreativeBudget(failedJournal, () => generateCreativeAssessments({
        contract, endpoint, count: 3, assertCurrent: async () => {},
      }))).rejects.toMatchObject({ code: "CREATIVE_RECEIPT_UNKNOWN" });
      expect(requests).toHaveLength(1);
    });
  });

  it("rejects malformed independent review without accepting the underlying candidate", async () => {
    await withFixture(user => ({
      value: user.candidateHash ? { ...goodReview(user), findings: [{ targetId: "S1", blocking: "false" }] } : { shots: [shot] },
    }), async (endpoint, requests, hashes) => {
      const result = await withCreativeBudget(budget(), () => generateCreativeAssessments({ contract, endpoint, count: 1, assertCurrent: async () => {} }));
      expect(requests).toHaveLength(2);
      expect(result.selected).toBeNull();
      expect(result.rejected[0]).toMatchObject({ code: "CREATIVE_ART_REVIEW_UNVERIFIED", response: {
        phase: "review", requestId: "fixture-response-2", responseHash: hashes[1],
        issues: expect.arrayContaining([{ path: ["findings", 0, "blocking"], code: "invalid_type" }]),
      } });
    });
  });
});

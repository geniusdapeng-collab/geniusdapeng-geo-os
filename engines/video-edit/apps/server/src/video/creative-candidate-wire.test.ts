import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { compileCreativeContract, CREATIVE_ART_DIMENSIONS, withCreativeBudget, type CreativeModelOutcome } from "@hyperreality/video-studio";
import { describe, expect, it } from "vitest";
import { generateCreativeAssessments } from "./creative-api-service.js";

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
type Fixtures = (user: Record<string, any>, index: number) => { value: unknown; usage?: "missing" };
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
    const { value, usage } = fixture(JSON.parse(body.messages.at(-1)!.content), requests.length);
    const raw = JSON.stringify({ id: `fixture-response-${requests.length}`, model,
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify(value) } }],
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

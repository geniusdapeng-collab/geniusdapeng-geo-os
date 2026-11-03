import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { CreativeContractError, ProductVisualAuthorityError } from "@hyperreality/video-studio";
import { loadPipelineFeatureFlags } from "@workloom/pipeline-control";
import { scopeOf, writeProcedure } from "../trpc/context.js";
import { applyRepair, compileIntent, creativeCandidates, repairPreview } from "./creative-api-service.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().min(1).max(2_147_483_647);
const command = { projectId: id, idempotencyKey: z.string().min(8).max(200) };
const stringArray = z.array(z.string().max(8000)).max(100);
const patch = z.object({
  schemaVersion: z.literal("workloom.creative-shot/v1"), id, sceneId: z.string().min(1).max(200), revision,
  contractHash: hash, sourceHash: hash, parentHash: hash.nullable(), duration: z.number().positive(),
  purpose: z.string().max(8000), informationTask: stringArray, claimIds: stringArray,
  subject: z.string().max(8000), action: z.string().max(8000), visual: z.string().max(100_000),
  sound: z.string().max(8000), textLayers: stringArray, assetRefs: stringArray, constraintIds: stringArray,
  fields: z.record(z.string().regex(/^[\p{L}\p{N}_ -]{1,80}$/u), z.json()), fieldOrder: stringArray, prompt: z.string().max(100_000),
}).strict().refine(value => Buffer.byteLength(JSON.stringify(value)) <= 512 * 1024, "镜头补丁超过 512 KiB");

function actorOf(identity: Parameters<typeof scopeOf>[0], projectId: string) {
  return { scope: { ...scopeOf(identity), projectId }, actorId: identity.memberNo };
}

async function mapped<T>(execute: () => Promise<T>): Promise<T> {
  try { return await execute(); }
  catch (error) {
    if (error instanceof CreativeContractError || error instanceof ProductVisualAuthorityError) {
      const code = error.code === "CREATIVE_PROJECT_NOT_FOUND" ? "NOT_FOUND"
        : /CONFLICT|BUSY|STALE|IN_PROGRESS/.test(error.code) ? "CONFLICT"
        : /BUDGET|LIMIT|USAGE|SOURCE|REQUIRED|DISABLED/.test(error.code) ? "PRECONDITION_FAILED" : "BAD_REQUEST";
      throw new TRPCError({ code, message: error.message, cause: error });
    }
    throw error;
  }
}

export const creativeStudioProcedures = {
  compileIntent: writeProcedure.input(z.object({
    ...command, rawIntent: z.string().min(1).max(200_000),
    metadata: z.record(z.string(), z.json()).refine(value => Buffer.byteLength(JSON.stringify(value)) <= 512 * 1024).optional(),
    expectedRevision: z.number().int().min(0).max(2_147_483_646),
  }).strict()).mutation(({ ctx, input: { projectId, ...input } }) =>
    mapped(() => compileIntent(actorOf(ctx.identity, projectId), input))),

  creativeCandidates: writeProcedure.input(z.object({
    ...command, contractHash: hash, count: z.number().int().min(1).max(3),
  }).strict()).mutation(({ ctx, input: { projectId, ...input } }) =>
    mapped(() => creativeCandidates(actorOf(ctx.identity, projectId), input, route => {
      const flags = loadPipelineFeatureFlags();
      return flags.coordinator === "enforce" && (flags.scope === "all" || flags.scope === route);
    }))),

  repairPreview: writeProcedure.input(z.object({
    ...command, decisionId: id, targetId: id, expectedStageRevision: revision,
  }).strict()).mutation(({ ctx, input: { projectId, ...input } }) =>
    mapped(() => repairPreview(actorOf(ctx.identity, projectId), input))),

  applyRepair: writeProcedure.input(z.object({
    ...command, repairPlanId: id, planHash: hash, expectedStageRevision: revision, patch,
  }).strict()).mutation(({ ctx, input: { projectId, ...input } }) =>
    mapped(() => applyRepair(actorOf(ctx.identity, projectId), input))),
};

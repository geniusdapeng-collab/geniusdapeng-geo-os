import { compareCreativeShadow, compileCreativeContract, creativeHash,
  type CompileCreativeInput, type CreativeShadowComparison } from "@hyperreality/video-studio";

/** A pure observation of the one actual legacy run; never authorize, mutate or dispatch. */
export function observeCreativeShadow(args: {
  input: CompileCreativeInput;
  baseline: { ready: boolean; hardFindings: string[]; output: unknown };
}) {
  const outputHash = () => args.baseline.output == null ? null
    : creativeHash(JSON.parse(JSON.stringify(args.baseline.output)));
  const originalOutputBefore = outputHash();
  const contract = compileCreativeContract(args.input);
  const inputHash = creativeHash({ scope: contract.scope, raw: contract.rawIntentHash,
    metadata: contract.sourceMetadataHash, facts: contract.facts?.hash ?? null });
  const baseline = { ready: args.baseline.ready, hardFindings: [...new Set(args.baseline.hardFindings)].sort() };
  const shadow = { feasibility: contract.feasibility.status,
    hardFindings: [...new Set(contract.feasibility.findings.filter(item => item.blocking).map(item => item.code))].sort() };
  const observation: CreativeShadowComparison = {
    inputHash,
    baseline: { ...baseline, receiptHash: creativeHash({ observer: "legacy", inputHash, outputHash: originalOutputBefore, ...baseline }) },
    shadow: { ...shadow, receiptHash: creativeHash({ observer: "creative", contractHash: contract.hash, ...shadow }) },
    shadowOutboundRequests: 0,
    originalOutputBefore,
    originalOutputAfter: outputHash(),
  };
  return { contractHash: contract.hash, observation, comparison: compareCreativeShadow(observation) };
}

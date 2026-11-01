# T-2026-1030-0002 Pipeline Control Hardening State

Updated: 2026-11-01 Asia/Shanghai

## Goal

Deeply validate the new video pipeline architecture without submitting rendering, fix all discovered general defects, stress test, publish a PR, pass CI, merge to `main`, and read back the final SHA.

## Audit Baseline

- Commit: `3951b7d3e13eeba315e599ad50c17486d112a6bc`
- Branch: `task/T-2026-1030-0002-real-case`
- Ledger: `outputs/mine-clear/T-2026-1030-0002/ledger.json`
- Cards: `MC-001` (P0 gate/catalog), `MC-002` (P0 artifact closure), `MC-003` (P0 execution/operation), `MC-004` (P1 feature flag), `MC-101` (fix card covering all).

## Already Fixed Before This Audit

- Missing G6/G7 policy coverage.
- Narrative micromotion/portrait/G7 wait cycle.
- Lease release after artifact commit.
- `markInterrupted` unused PostgreSQL parameter.
- Real case M01/N01 run succeeded without render jobs or provider callbacks.

## Implemented In Current Working Tree

- Canonical catalog validator: `packages/video-pipeline/src/catalog.ts`.
- Added G-GEO1, G-GEO2, G-VIS1 to registry and policy; policy version `2026-11-01.1`.
- Compiler now rejects mixed gate/action nodes and detects wait cycles.
- Split authored gate/action mixes into pure gate + action stage in AI Video and GEO pipelines.
- Added call adapter identity (`pipeline.child`) and catalog child-plan resolution.
- Artifact commit now requires every required output slot.
- Recursive ancestor input closure is enforced in claim/commit/gate decisions.
- Added `0061_video_pipeline_operations.sql` with reserved → dispatched → accepted/failed/unknown states.
- Added repository APIs reserveOperation/dispatchOperation/settleOperation.
- Provider/public action commit requires an accepted operation receipt.
- Unified coordinator flag loading; `PIPELINE_COORDINATOR` canonical, legacy alias accepted only when equal.
- Added stress harness:
  - `scripts/tools/pipeline-plan-stress.mts`
  - `scripts/tools/pipeline-control-stress.sh`
  - `apps/server/src/video/pipeline/pipeline-control-stress.pg.test.ts`
- Added hardening documentation: `docs/pipeline-control-hardening.md`.

## Current Green Evidence

- Stress command passed:
  `zsh scripts/tools/pipeline-control-stress.sh --mode all --plans 13 --cases 64`
- 13/13 pipelines compile.
- 0 gate registry gaps, 0 policy gaps, 0 wait/call cycles.
- 64 synthetic DAGs / 762 nodes pass.
- 50 runs × 8 competing workers: one winner per run.
- 50 unknown operations persisted and enter reconcile.
- Typechecks for video-pipeline, pipeline-control, and apps/server pass in the stress wrapper.
- Real case evidence after prior changes:
  `var/pipeline-real-case-20261101/result.json`
  Marketing stops with frontier `["render"]`; narrative should stop before provider portrait at G6 boundary; 0 render jobs and 0 outbound calls.
- Root Node tests: 487/487 passed.
- Engine server suite: 1374 passed, 193 environment/platform skips.
- Vendor real-media regression: 74/74 passed.
- GEO/integrated engine: 14/14 passed.
- Smoke: health/dashboard/GEO/media all 200.
- Security scan: 3999 files, 0 findings.
- Snapshot/pin regenerated from upstream `a544ab8b068790bfb14b7977efc81b33897fc9de`:
  3650 files / 336,706,560 bytes; snapshot SHA-256 `32f43c0d14aa22125fa39b33459e8949fbae3e67fdd60acac23e84b9f249a3d3`.
- MCD repair and independent acceptance: MC-001/002/003/004/101 all passed at
  `50e232cb41cedb9bb9c13c795b7695d890ebf47b`; five verified, no P0/P1 open.

## Final Local Gate

- Complete source commit: `50e232cb41cedb9bb9c13c795b7695d890ebf47b`.
- MCD gate: green; handoff/report/gate receipt generated.
- Remaining: stage and commit MCD outputs, push, open PR, pass CI, merge to `main`,
  then read back final `main` SHA/tree.

## Critical Files

- `engines/video-edit/packages/video-pipeline/src/catalog.ts`
- `engines/video-edit/packages/video-pipeline/src/compiled-plan.ts`
- `engines/video-edit/packages/video-pipeline/src/adapters.ts`
- `engines/video-edit/packages/video-pipeline/src/auto-approval.ts`
- `engines/video-edit/apps/server/src/video/pipeline/pipeline-repository.ts`
- `engines/video-edit/packages/db/migrations/0061_video_pipeline_operations.sql`
- `engines/video-edit/scripts/tools/pipeline-control-stress.sh`
- `engines/video-edit/packages/video-pipeline/src/test/catalog.test.ts`
- `engines/video-edit/apps/server/src/video/pipeline/pipeline-control-stress.pg.test.ts`

## Next Actions

1. Commit generated MCD ledger/report/handoff/gate and assertion evidence.
2. Push `task/T-2026-1030-0002-real-case`.
3. Open PR against `main` with test and MCD receipt summary.
4. Wait for required CI, rerun/repair only actionable failures.
5. Merge serially, read back final `main` SHA/tree and verify issue/PR state.

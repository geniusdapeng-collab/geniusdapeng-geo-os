---
name: pengmanager-standard-video
description: Use for one-line requests to make, generate, edit, or deliver an AI video with PengManager (鹏经理). Route general and marketing video through native Studio, qualified render and the repository post workflow; never replace a standard job with manual production.
---

1. Read the root [AGENTS.md](../../../AGENTS.md), complete [AI Agent guide](../../../docs/AI-AGENT-GUIDE.md) and current [video quickstart](../../../docs/CODEX-VIDEO-QUICKSTART.md). In a projectless chat, read these explicitly after cloning. Use this repository's actual GitHub default-branch checkout.
2. Keep the user's exact sentence. Call `pengmanager_video_workflow` or `node scripts/video-standard.mjs plan --input-file -` with `{"intent":"原话"}`. Only supply `durationSec` to disambiguate the total from other numbers in the original. The native service selects general or marketing and retains its normal ambiguity handling.
3. Complete the read-only local preflight. For an authorized new request, use `video-standard.mjs start` with the same input and the [private owner policy](../../../docs/PENGMANAGER-VIDEO-MAKE.md). Preserve the returned job and project. Read the same job using `status` and follow the receipt for recovery. Unknown submit outcomes require reconciliation through the original project.
4. Use same-run Studio/archive and current production shots, native per-shot qualification and render, real asset readback, then repository post. Do not accept a draft, handwrite shots, use a manual bridge, substitute another system/provider, or make an ad hoc cut when a required step fails. Follow the repository's normal checks for rights, approvals and quotas.
5. Report the exact blocked step when evidence is absent. A finished preproduction, an estimate, or a readable local file alone cannot prove delivery. Only report completion after the real task/source IDs, current file bytes, official delivery manifest, post quality and media decode agree.

# Repository Instructions

This repository is a private, local-first personal GEO control plane.

## Mandatory first read for every AI agent

After cloning, pulling, switching branches, or beginning a task in this
repository, read this file and the complete
[AI Agent usage guide](docs/AI-AGENT-GUIDE.md) **before planning, making changes,
calling business APIs, starting live scripts, or operating an external
platform**. Do not substitute the README, a summary, or a previous agent's
memory for the guide. Re-read it when these instructions or the guide change.
If the guide is unavailable, report that missing prerequisite rather than
guessing its authorization and receipt rules.

## Video requests in this repository

When a user asks in ordinary language to produce, re-edit, repair or deliver a
video in PengManager, activate this workflow without requiring a special prompt
or skill mention. Keep video questions, plan-only requests and repository
maintenance within their requested scope.

After the required guide, read the
[video setup and production quickstart](docs/CODEX-VIDEO-QUICKSTART.md) and the
complete [embedded workbench guide](engines/video-edit/docs/ai-video-workbench-guide.md).
Start the video workflow with the original intent through the registered
`pengmanager.video.intake` capability. The local invocation is
`node scripts/agent.mjs invoke pengmanager.video.intake --input-file -`, with
an object containing `intent` on stdin. MCP uses `pengmanager_video_intake`.
Preserve the original wording. Supply the current project ID and duration
when the request or an authoritative project contract provides them. Set
`operation` to `repair` or `deliver` for an existing project's task.

Check the intake receipt for the PengManager and embedded Edit identities,
guide hashes and the current native handoff. Use the registered preflight to
check local readiness. Continue through the authorized native project,
qualification, budget, polling, post and delivery checks in the quickstart.
When the handoff is blocked, carry forward the actual missing requirement.
For a handoff to an existing project, recover its authoritative project and
owner receipt before continuing. Keep its identity through repair and delivery.
Use the native service for paid generation and check an unknown result by its
original task ID. Keep generation and publication within their respective
authorizations.

Use the guide's actual distinction between administrator preparation, scoped
HTTP Agent execution, local browser actions, and native video CLI/MCP. In
particular, an Agent bearer token cannot create or approve content or operations.
Read the linked implementation for the specific task before editing code; use
the target service's actual response to distinguish deployed behavior from a
newer checkout. Preserve exact approved text, account identity, real readback
and idempotent receipt recovery. Do not claim Mac Downloads backup unless the
documented browser or local process has actually written and verified it.

## Required boundaries

- Never write tokens, cookies, passwords, private keys, customer data or private contact details into the repository, logs, tests, fixtures or screenshots.
- Never treat a mock, local file, HTTP 200 or fixture as a real platform publication.
- Never add unattended publishing or interaction automation for a platform without a reviewed official interface and explicit authorization.
- Public export must only read approved, unexpired, non-sensitive `approved_public` claims.
- High-risk recruiting, customer, legal, financial, privacy and negative interactions remain human-only.
- Live scripts may spend model tokens or write to external platforms. Run them only when the user authorized that action.
- Store full live evidence under `var/`; commit only sanitized receipts under `docs/evidence/`.

## Before committing

```bash
node --check src/server.mjs
node --check public/app.js
node --test tests/*.test.mjs
node --test engines/geo-evidence/test/*.test.mjs
pnpm test:vendor
node scripts/smoke.mjs
node scripts/security-scan.mjs
```

All tests must pass. If the UI changes, verify desktop at 1440 px and mobile at 390 px with no horizontal overflow or console errors.

Before a live run, verify that `GITHUB_TOKEN`, `DEEPSEEK_API_KEY`, cookies and
other secrets remain process-scoped. Never paste a secret into a receipt.

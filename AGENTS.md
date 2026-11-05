# Repository Instructions

This repository is a private, local-first personal GEO control plane.

## Codex, Qoder and other AI workbenches

The user can stay in the conversation. The Agent performs CLI/MCP operations and reports actual receipts. On first connection or after an update, call MCP `pengmanager_agent_guide` with `{}`, or run `node scripts/agent.mjs guide`, and completely read its current documents. They include this file and the mandatory guide below. Client setup and lifecycle rules are in [AI workbench setup](docs/AI-WORKBENCH-SETUP.md). Generate absolute-path Codex/Qoder settings with `node scripts/ai-workbench.mjs config --client codex` or `--client qoder`; merge only the named server into existing client settings.

Full video production uses this Agent's shell and the existing standard CLI. A pure MCP client without shell cannot execute the full production workflow. Keep the same checkout and private data directory throughout. Before switching from a managed MCP runtime to the owner CLI, verify no local job is active, stop only this MCP session's runtime, and read back its stopped status. Retain a long-running shell session and the original job receipt across client timeouts; do not launch a duplicate job.

## Default entry for a video request

A request such as “用鹏经理做一支 30 秒的赛道视频” already selects the standard video workflow. After the required guide below, follow [the project video skill](.agents/skills/pengmanager-standard-video/SKILL.md) and use `pengmanager.video.workflow` (MCP: `pengmanager_video_workflow`) or `node scripts/video-standard.mjs plan --input-file -` with the original intent. Continue through native Studio routing and the same project's qualified rendering, official post and media checks. A preview or finished Studio preproduction is not a finished video. Do not handcraft shotlists, call a provider directly, use manual bridging, or substitute local media tools for the official workflow on a standard request. If a formal step cannot proceed, preserve its receipt and identify that step.

## Mandatory first read for every AI agent

After cloning, pulling, switching branches, or beginning a task in this
repository, read this file and the complete
[AI Agent usage guide](docs/AI-AGENT-GUIDE.md) **before planning, making changes,
calling business APIs, starting live scripts, or operating an external
platform**. Do not substitute the README, a summary, or a previous agent's
memory for the guide. Re-read it when these instructions or the guide change.
If the guide is unavailable, report that missing prerequisite rather than
guessing its authorization and receipt rules.

For Codex or another local AI client producing a video, follow the
[video setup and production quickstart](docs/CODEX-VIDEO-QUICKSTART.md) after
the required guide. Use the registered preflight to verify local readiness
before any paid work. A plan or configured provider is not a production receipt.

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

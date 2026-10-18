# Live Verification

Verified on 2026-10-18 Asia/Shanghai against the local Mac sandbox.

Aggregate result: `passed` in `docs/evidence/live-suite-2026-10-18.json`.

## Current model and DeepSeek API

- Gateway: `http://127.0.0.1:8788`
- Model: `deepseek-flash`
- Credential source: macOS keychain; no credential written to disk
- Provider search endpoint: `/v1/tools/search`
- Completion surfaces: `/chat/completions` with `/responses` fallback
- Queries: 12
- Successful: 12
- Failed: 0
- Query coverage: 100%
- Entity mention rate: 16.67%
- Owned citation rate: 8.33%
- Negative mention rate: 0%

The full receipt, per-query hashes and source counts are in `docs/evidence/deepseek-live-2026-10-18.json`.

## GeoEvidence Studio

- Upstream: `geniusdapeng-collab/geo-evidence-studio`
- Commit: `06b47a15fd114541bd3147dc5c07b944c36bc8da`
- Adapter path: production HTTP `/api/tool`
- Provider: `deepseek-search`
- Data mode: `real`
- Query: `ffd-brand-001`
- Run status: `completed`
- Successful samples: 1
- Failed samples: 0
- Evidence coverage: 100%
- Upstream sync receipt: `true`

Receipt: `docs/evidence/geoevidence-live-2026-10-18.json`.

## WorkLoom-video-edit

- Upstream: `geniusdapeng-collab/WorkLoom-video-edit`
- Commit: `2d112904dc23e7fde94dab2ec26933abbb51cb31`
- Adapter path: production `cover-kb-bridge/cli.mjs`
- Knowledge-base health: passed
- Topics: 14
- Mapping rows: 161
- Parameter rows: 137
- Platform drifts: 0
- Production enrichment: passed for Xiaohongshu knowledge-science cover planning
- Production feedback triage: passed; local remix layers identified as audio → text → cover with no shot regeneration

Receipt: `docs/evidence/video-edit-live-2026-10-18.json`.

## Model-driven GitHub API publication

- Model: `deepseek-flash`
- Model response: `88e607ad-5dd9-4712-ac3c-2b6ce88d4bf1`
- Content id: `CNT-004`
- Required gates: approved claim, fact check, approval, scheduling, policy-reviewed GitHub account
- Platform API: official GitHub REST API
- Issue: [#1](https://github.com/geniusdapeng-collab/geniusdapeng-geo-os/issues/1)
- Issue state after readback: `open`
- Publication data mode: `real`
- Publication receipt: `PUB-001`

Receipt: `docs/evidence/github-live-2026-10-18.json`.

## Boundaries

- GitHub is the only external write adapter verified in this round.
- No credentials exist for the other 15 platforms, so they remain manual and fail-closed.
- The private GitHub Issue is a real platform receipt, not a public social post.
- A public GEO evidence layer still requires a separate approved-public export and deployment target.

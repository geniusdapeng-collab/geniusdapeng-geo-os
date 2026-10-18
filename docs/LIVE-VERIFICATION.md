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

## Integrated personal GEO engine

- Upstream: `geniusdapeng-collab/geo-evidence-studio`
- Commit: `06b47a15fd114541bd3147dc5c07b944c36bc8da`
- Runtime: in-process `PersonalGeoEngine`
- Case: `pengstack-personal-geo`
- Database: SQLite
- Seeded queries: 100 personal queries plus 12 control-plane P0 queries
- Provider: `deepseek-search`
- Data mode: `real`
- Run status: `completed`
- Successful samples: 12
- Failed samples: 0
- Evidence coverage: 100%
- Entity mention rate: 16.67%
- Citation presence rate: 91.67%
- Owned citation rate: 8.33%
- Personal article drafts generated: 10
- Sync receipt: `true`

Receipt: `docs/evidence/personal-geo-live-2026-10-18.json`.

The earlier external HTTP adapter smoke remains recorded in
`docs/evidence/geoevidence-live-2026-10-18.json`; it is no longer required at
runtime.

## WorkLoom-video-edit

- Upstream: `geniusdapeng-collab/WorkLoom-video-edit`
- Commit: `2412a5b4e49f2d19601752758ce5274d2e88772c`
- Runtime: in-process `VideoMediaEngine`
- Knowledge-base health: passed
- Topics: 14
- Mapping rows: 161
- Parameter rows: 137
- Platform drifts: 0
- Production enrichment: passed for Xiaohongshu knowledge-science cover planning
- Production feedback triage: passed; local remix layers identified as audio → text → cover with no shot regeneration

Receipt: `docs/evidence/video-edit-live-2026-10-18.json`.

### Actual media delivery

- Source clips: 2 locally generated H.264/AAC files
- Output: 2 variants (`clean-tech`, `natural-clean`)
- Resolution: 640×360
- Duration: 6 seconds
- Outputs: 2 MP4 files with H.264 video and AAC audio
- Subtitles: SRT, ASS, soft-sub and burned variants
- Covers: 2 PNG covers
- Color/transition/BGM/quality receipts: present
- Final packaging: passed
- Post-production quality gate: `passed=true`

Receipt: `docs/evidence/media-render-live-2026-10-18.json`.

### Unified model-to-media chain

- Model: `deepseek-flash`
- Model response: `86e2db2f-8f07-4978-9e4b-724a649e7f1d`
- Content id: `CNT-005`
- Claim gate: `C003` and `C005`
- Final state: `scheduled`
- Generated media job: `media-1792339045587-92437d0d`
- Variants: `clean-tech`, `natural-clean`
- Outputs: two 640×360 MP4 files
- Media technical quality: passed
- Unified ledger revision: `13`

Receipt: `docs/evidence/full-system-live-2026-10-18.json`.

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

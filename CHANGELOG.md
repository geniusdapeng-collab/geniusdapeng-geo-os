# Changelog

## 2026-10-24 — PengManager identity update

### Changed

- Rename the product to 鹏经理系统 / PengManager System while retaining the
  existing `geniusdapeng-collab/geniusdapeng-geo-os` repository URL.
- Standardize the main account as 李大鹏 / PengManager, with the Chinese display
  name 李大鹏｜用AI搞经营的产品经理 and English display name Dapeng Li · PengManager.
- Apply the supplied Chinese and English bios to the canonical identity,
  platform profiles, dashboard and relevant content-production defaults.
- Refresh personal GEO query and article defaults for the current identity,
  while retaining recognition aliases and stable case/query IDs.
- Migrate recognized legacy runtime defaults once and append an identity event;
  retain customized queries, approved facts, publication receipts and previous
  event hashes.
- Rewrite the README and current architecture, API, operations and seed guidance
  to describe the product, migration and local/private operating boundaries.

Historical live verification receipts below remain records of their original
dates; this identity update does not imply a new all-platform publication.

## 0.4.1 - 2026-10-19

### Fixed

- Revalidate approved Claim state, expiry, target platform and account policy
  before every external publication.
- Serialize live publication per content item so concurrent requests cannot
  create duplicate GitHub Issues.
- Reject cross-origin browser writes and non-allowlisted Host headers, and add
  a restrictive Content-Security-Policy to the local control plane.
- Keep fixture data out of aggregate GEO metrics and record the exact prompt
  sent to the model.
- Reject unsafe citation schemes, loopback/private citation targets, unsafe
  redirect chains and oversized fetched response bodies.
- Pass the requested cover title and hook through to real media delivery, and
  report the installed `tsx` runtime truthfully.
- Make the default video-edit live check use the vendored engine and record the
  pinned upstream commit.
- Return truthful draft, queued, local and connector-required receipts instead
  of labelling non-real operations as `real`.
- Restore the integrated video-engine TypeScript and rhythm-audio test paths.

### Verified

- 38 root tests, 11 GEO engine tests, 74 Node video-engine tests and 74
  Vitest video-engine tests
- 12/12 real DeepSeek Search queries
- Real model-to-content-to-FFmpeg delivery with two 640x360 MP4 variants
- Google Chrome desktop/mobile interaction and responsive-layout checks
- Model-driven GitHub Issue publication with official API readback

## 0.4.0 - 2026-10-18

### Integrated

- Vendored and personalized GeoEvidence SQLite, collection, metrics,
  incidents, article and publication engine
- Vendored WorkLoom-video-edit post-production, subtitles, color, BGM,
  transitions, cover, delivery package and feedback-triage engine
- Unified server, JSON event ledger and media-job history
- Unified dashboard tabs for GEO engine metrics and media production

### Verified

- 12/12 real personal DeepSeek queries
- 10 personal article drafts
- Two real 640x360 six-second video variants with covers, subtitles and
  technical quality receipts
- Model-driven GitHub Issue publication

## 0.3.0-alpha.1 - 2026-10-18

### Added

- DeepSeek model adapter using the local Responses-compatible gateway
- DeepSeek Search + Chat/Responses real collection with hash evidence
- GeoEvidence Studio production HTTP adapter
- WorkLoom-video-edit cover knowledge-base production CLI adapter
- GitHub official REST API publication adapter
- Model-generated content pipeline with claim, approval and schedule gates
- Live adapter health panel
- Sanitized live receipts under `docs/evidence/`

### Verified

- 12/12 DeepSeek queries completed
- GeoEvidence live run completed with `receipt.synced=true`
- video-edit cover bridge health and enrichment passed
- GitHub issue #1 created and read back through the official API

## 0.1.0 - 2026-10-18

- Initial private GEO control plane
- 16 platform profiles
- Claim, content, publication, interaction and GEO observation models
- Hash-chained append-only local ledger
- 120-topic content bank

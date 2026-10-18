# Changelog

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

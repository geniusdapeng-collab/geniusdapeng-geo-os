# 鹏经理系统 · PengManager System — Roadmap

The system serves 李大鹏 / PengManager. Its current identity and account copy
are documented in the [README](../README.md); the repository slug and historical
evidence URLs remain unchanged.

## 2026-10-24: PengManager identity update

- Unify product naming as 鹏经理系统 / PengManager System.
- Unify Chinese and English account names, display names and bios.
- Refresh dashboard, content-production defaults and personal GEO templates.
- Migrate recognized legacy local defaults while preserving customized records,
  approval decisions, publication receipts and event history.
- Keep platform profile updates and real external publications subject to their
  existing interface, authorization and receipt requirements.

## v0.1: verified local control plane

- Private repository and CI
- Entity, accounts, claims, content, receipts, interactions and observations
- Hash-chained append-only event log
- Responsive dashboard
- 120-topic content bank

## v0.2: real GEO engine adapter — baseline completed 2026-10-18

- [x] Pin and wrap GeoEvidence Studio endpoints
- [x] Import DeepSeek Search and Chat/Responses samples with source-preserving evidence files
- [x] Run 12/12 real DeepSeek baseline queries
- Add query batches, confidence intervals and 7/28-day comparisons
- Add same-name disambiguation review

## v0.3: media factory adapter — first production connector completed 2026-10-18

- [x] Invoke the pinned WorkLoom-video-edit cover bridge CLI
- Define remaining video, edit, talking-head and delivery jobs
- Require a claim or opinion marker for every media job
- Store asset hashes and license sidecars
- Separate private masters from approved public exports

## v0.4: integrated independent system — completed 2026-10-18

- [x] Vendor GeoEvidence production code and personalize its case/query/metrics
- [x] Vendor video-edit production code and run it from the same repository
- [x] Unified HTTP API, event ledger and dashboard
- [x] Real 12-query GEO baseline and 10 article drafts
- [x] Real two-variant FFmpeg delivery with subtitles, covers, BGM and QC
- [x] Real model-driven GitHub Issue publication

## v0.4: manual multi-platform packages

- Generate account-aware article, image-text and video packages
- Add URL, screenshot and timestamp receipt workflow
- Add platform policy review dates and fail-closed expiry
- Keep unauthorized automated interaction out of scope

## v0.5: public evidence layer

- Build a separate public site from `approved_public` data only
- Add JSON-LD, `llms.txt`, sitemap and RSS
- Add PII and secret scan as a release gate
- Verify the private repository never becomes a public build input

## Deferred

- Multi-tenant SaaS
- Public registration and billing
- Unattended platform publishing
- CAPTCHA bypass or unapproved scraping
- Synthetic accounts, comments or endorsements

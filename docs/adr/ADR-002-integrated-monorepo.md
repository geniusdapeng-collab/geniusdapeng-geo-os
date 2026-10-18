# ADR 002: Integrate production engines into one independent repository

Status: accepted

Date: 2026-10-18

## Context

The adapter-only milestone verified external connectivity, but did not make the
personal system independent. Geo runs still depended on a separately running
GeoEvidence service, and video operations depended on a separately checked-out
WorkLoom-video-edit repository.

The user explicitly required a complete code-level integration and an
independent runnable system.

## Decision

Vendor the production code needed by both capabilities:

- GeoEvidence store, providers, analysis, metrics, incidents, articles and
  publication receipts under `engines/geo-evidence`
- WorkLoom-video-edit post-production, subtitles, color, BGM, transitions,
  cover, packaging and feedback triage under `engines/video-edit`

Generalize the GEO case to `pengstack-personal-geo`. Keep the control-plane JSON
ledger and the richer GEO SQLite engine side by side because they serve
different reliability and querying needs.

Do not import the WorkLoom desktop shell, PostgreSQL runtime, authentication
system, platform deployment code or unrelated industry bundles.

## Consequences

- The repository is independently runnable after one dependency install.
- Upstream code is pinned and licensed under `engines/*`.
- Media jobs can be executed and inspected locally without a remote WorkLoom
  installation.
- GEO runs use personal queries and personal entity disambiguation in-process.
- Upstream upgrades require explicit refresh and regression testing.
- The integrated repo is larger and must keep upstream licenses and notices.

# 鹏经理系统 · PengManager System — Architecture

## Decision

鹏经理系统 (PengManager System) is an independent private, local-first system for 李大鹏 / PengManager. It keeps the personal entity, claims, content graph, approvals and receipt ledger in one control plane, and runs a vendored personal GEO engine plus a vendored media-production engine inside the same repository. The repository slug remains `geniusdapeng-geo-os` so existing repository URLs keep working.

The Chinese display name is `李大鹏｜用AI搞经营的产品经理`; the English display name is `Dapeng Li · PengManager`. The canonical bilingual profile also supplies account bios, content ownership defaults and public-preview identity fields. Historical aliases remain available for GEO entity recognition.

The WorkLoom desktop/server shell, PostgreSQL runtime and unrelated industry bundles are not included. Only the production code required by GEO collection and media delivery is integrated. A private repository still does not serve as the public GEO evidence layer.

## Runtime

```text
Local dashboard
      |
      v
HTTP API -> domain policy -> append-only event ledger -> local JSON state
      |                           |
      |                           +-> claims / content / receipts / observations
      |
      +-> DeepSeek Responses/Chat/Search API
      +-> PersonalGeoEngine (in-process GeoEvidence SQLite/collection/metrics/articles)
      +-> VideoMediaEngine (in-process FFmpeg/post/subtitle/color/BGM/cover/package)
      +-> GitHub official REST API
      +-> fail-closed manual adapters for other platforms
```

The control-plane records use local JSON with a hash event chain. Rich GEO runs use the vendored SQLite engine. Media jobs store a separate local delivery directory and receipt with output hashes for each job. The documented runtime uses Node.js 24, SQLite built-ins, FFmpeg/FFprobe and the pinned `tsx` toolchain.

## Trust chain

1. A claim records its source, evidence level, sensitivity, public level and expiry.
2. Non-opinion content must reference at least one claim.
3. Approval checks claim state, expiry and sensitive text.
4. A scheduled content item can only become published through receipt recording, either from the manual endpoint or after the GitHub adapter returns its external receipt.
5. The receipt must contain a public URL, capture time, publisher and a `real` or `imported` data mode.
6. Each state mutation appends a SHA-256 hash event linked to the previous event.

The event chain is tamper-evident. It is not a trusted timestamp, platform signature or replacement for a real external receipt.

## Boundaries

- The server binds to `127.0.0.1` by default.
- Runtime state is local and ignored by Git.
- Public export only reads `approved_public` claims.
- All platform accounts start with `manual_review_required`.
- GitHub issue publication is live and receipt-verified. Other platform writes remain disabled until their official credentials and policies are reviewed.
- The repository contains no credentials.

## Integrated engines and external adapters

- `DeepSeekAdapter` uses the local Responses-compatible gateway and system keychain. It performs real provider search, Chat/Responses completion, evidence hashing and model-driven JSON content generation.
- `PersonalGeoEngine` runs the adapted GeoEvidence SQLite store, providers, analysis, incidents, article generation and publication receipts in-process. Its default case keeps the stable ID `pengstack-personal-geo` for database compatibility while its current display identity is PengManager. Stable `ps-*` query IDs continue to link historical samples to their queries.
- `VideoMediaEngine` builds a validated timeline, invokes the vendored post-production, subtitle, color, BGM, transition, cover and packaging code, and requires the FFmpeg quality gate to pass.
- `VideoEditAdapter` exposes cover knowledge hints and feedback triage from the same vendored engine.
- `GitHubAdapter` creates a real owner/repo Issue through the official REST API and records the issue URL and content hash.

No adapter may convert fixture or mock output into a real publication receipt.

## Identity migration

New state uses the current PengManager profile. After opening an existing JSON store, the server runs the profile migration before constructing services and engines. The migration updates identity and platform profile fields, merges recognition aliases and appends an `identity.updated` event instead of rewriting past events. Repeated starts do not append the same migration again.

Only recognized legacy defaults are replaced in queries and unapproved claims; customized queries, approved claims, published content, publication receipts and event history retain their original values. Draft ownership may move from the previous default to PengManager. The GEO database retains its existing case and query IDs, and refreshes recognized default query templates without renaming historical samples. These are local data migrations; no external platform profile or publication is updated by startup.

## Domain objects

- `EntityProfile`: one person, bilingual account/display names and bios, plus stable recognition aliases
- `Account`: platform profile and publication boundary
- `Claim`: a sourced, versioned fact or expertise statement
- `Query`: a stable GEO question and target surface
- `Content`: a draft or approved content atom
- `Publication`: an external receipt bound to content and account
- `Interaction`: a classified comment, message or recruiting lead
- `Observation`: one AI answer sample with citations and derived metrics
- `Event`: append-only mutation evidence

See [API.md](API.md) for endpoints, [adr/ADR-001-control-plane.md](adr/ADR-001-control-plane.md) for historical context and [adr/ADR-002-integrated-monorepo.md](adr/ADR-002-integrated-monorepo.md) for the current architecture.

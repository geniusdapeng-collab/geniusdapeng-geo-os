# Architecture

## Decision

`geniusdapeng-geo-os` is an independent private system. It keeps the personal entity, claims, content graph, approvals and receipt ledger in one control plane, and runs a vendored personal GEO engine plus a vendored media-production engine inside the same repository.

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

The control-plane records use local JSON with a hash event chain. Rich GEO runs use the vendored SQLite engine. Media jobs store their own immutable local delivery directory and receipt. The runtime uses Node.js 24, SQLite built-ins, FFmpeg/FFprobe and the pinned `tsx` toolchain.

## Trust chain

1. A claim records its source, evidence level, sensitivity, public level and expiry.
2. Non-opinion content must reference at least one claim.
3. Approval checks claim state, expiry and sensitive text.
4. A scheduled content item can only become published through the manual receipt endpoint.
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
- `PersonalGeoEngine` runs the adapted GeoEvidence SQLite store, providers, analysis, incidents, article generation and publication receipts in-process. Its default case is `pengstack-personal-geo`, not the future-frontdesk customer case.
- `VideoMediaEngine` builds a validated timeline, invokes the vendored post-production, subtitle, color, BGM, transition, cover and packaging code, and requires the FFmpeg quality gate to pass.
- `VideoEditAdapter` exposes cover knowledge hints and feedback triage from the same vendored engine.
- `GitHubAdapter` creates a real owner/repo Issue through the official REST API and records the issue URL and content hash.

No adapter may convert fixture or mock output into a real publication receipt.

## Domain objects

- `EntityProfile`: one person and stable aliases
- `Account`: platform profile and publication boundary
- `Claim`: a sourced, versioned fact or expertise statement
- `Query`: a stable GEO question and target surface
- `Content`: a draft or approved content atom
- `Publication`: an external receipt bound to content and account
- `Interaction`: a classified comment, message or recruiting lead
- `Observation`: one AI answer sample with citations and derived metrics
- `Event`: append-only mutation evidence

See [API.md](API.md) for endpoints, [adr/ADR-001-control-plane.md](adr/ADR-001-control-plane.md) for historical context and [adr/ADR-002-integrated-monorepo.md](adr/ADR-002-integrated-monorepo.md) for the current architecture.

# Architecture

## Decision

`geniusdapeng-geo-os` is a lightweight private control plane. It owns the personal entity, claims, content graph, approvals, receipt ledger, interactions and GEO observations. GeoEvidence Studio and WorkLoom-video-edit remain independent engines behind pinned adapter contracts.

This repository does not copy either upstream application shell. A private repository also does not serve as the public GEO evidence layer.

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
      +-> GeoEvidence Studio production HTTP API
      +-> WorkLoom-video-edit cover bridge CLI
      +-> GitHub official REST API
      +-> fail-closed manual adapters for other platforms
```

The base runtime introduced in v0.1 intentionally uses Node.js built-ins only. The small local runtime keeps setup auditable and removes dependency drift from the first milestone. SQLite or PostgreSQL is a later migration after the object model stabilizes.

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

## Live adapters

- `DeepSeekAdapter` uses the local Responses-compatible gateway and system keychain. It performs real provider search, Chat/Responses completion, evidence hashing and model-driven JSON content generation.
- `GeoEvidenceAdapter` calls the upstream production HTTP API and rejects an upstream run without `receipt.synced=true`.
- `VideoEditAdapter` invokes the upstream cover knowledge-base CLI at a pinned commit and records hint/trace hashes and drift checks.
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

See [API.md](API.md) for endpoints and [adr/ADR-001-control-plane.md](adr/ADR-001-control-plane.md) for the architectural tradeoff.

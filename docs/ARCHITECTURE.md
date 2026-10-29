# 鹏经理系统 · PengManager System — Architecture

## Decision

鹏经理系统 (PengManager System) is an independent private, local-first system for 李大鹏 / PengManager. It keeps the personal entity, claims, content graph, approvals and receipt ledger in one control plane, and runs a vendored personal GEO engine plus a vendored media-production engine inside the same repository. The repository slug remains `geniusdapeng-geo-os` so existing repository URLs keep working.

The Chinese display name is `李大鹏｜用AI搞经营的产品经理`; the English display name is `Dapeng Li · PengManager`. The canonical bilingual profile also supplies account bios, content ownership defaults and public-preview identity fields. Historical aliases remain available for GEO entity recognition.

The complete pinned Edit source is contained under `engines/video-edit`, including the native server, web workbench, PostgreSQL schema, model routing, production SDK, digital employees, skills, tools, research and media libraries. PengManager supervises its own separate video database and native services; it does not delegate production to a separately running Edit installation. A private repository still does not serve as the public GEO evidence layer.

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
      |
      +-> owned video supervisor
            +-> private PostgreSQL + native migrations/assembly
            +-> embedded native video backend + real local owner session
            +-> owned loopback-root workbench + authenticated native API proxy
            +-> local tool stations and explicitly configured providers
```

The control-plane records use local JSON with a hash event chain. Rich GEO runs use the vendored SQLite engine. Media jobs store a separate local delivery directory and receipt with output hashes for each job. The documented runtime uses Node.js 24, SQLite built-ins, FFmpeg/FFprobe and the pinned `tsx` toolchain.

The JSON ledger and GEO SQLite remain authoritative for existing personal operations. Native video transactions, budget reservations, approvals and archive recovery remain in the independent video PostgreSQL database. No flattening or destructive data conversion joins these stores. A single root start command starts the dashboard, then launches its own video supervisor; video failure is isolated from the existing control plane. Stop cancels pending video setup/start, waits for owned-service cleanup and active HTTP completion, then closes GEO.

Video credentials and database data live in an owner-only directory outside the repository. PostgreSQL tool installation copies an explicit tool prefix; it never copies another application's database. The runtime checks embedded module realpaths, lock/pin, owned process/port and database identity before use. Only controlled local services are proxied; no arbitrary upstream URL is accepted.

The complete workbench uses an owned loopback root origin rather than a subpath iframe. This preserves its original routing and authentication and keeps the root dashboard CSP and framing restrictions intact. A process-only bootstrap key obtains a genuine native owner session from the scoped local backend. Root `/api/video-runtime/*` routes expose only safe read-only projections; they neither return sessions nor derive native identity from body `actor`/`approvedBy`. Native protected procedures retain active-member, workspace and tenant checks.

`pengmanager-capabilities.json` is generated from the embedded declarations. The root directory includes every role, skill, tool, capability and installer with search and pagination. Declared code, dependency diagnosis and validated production are separate fields. Actual station installed/ready/running results are displayed separately from that source inventory. Neither a catalog row nor a health response proves paid generation, media quality or external publication.

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

- `DeepSeekAdapter` uses the unified `text.primary` Chat dispatcher and the process-scoped credential resolver. The canonical model is `deepseek-flash`; every call records the scene policy, full-window token plan, usage, model identity, finish reason and request/response hashes. Search remains the provider's separate tools endpoint.
- `PersonalGeoEngine` runs the adapted GeoEvidence SQLite store, providers, analysis, incidents, article generation and publication receipts in-process. Its default case keeps the stable ID `pengstack-personal-geo` for database compatibility while its current display identity is PengManager. Stable `ps-*` query IDs continue to link historical samples to their queries.
- `VideoMediaEngine` retains the existing local quick-post workflow: it clips inputs to at most four seconds each, creates synthetic ambient audio and runs FFmpeg post-production, cover and packaging. Its UI states these limits. The complete native workbench owns AI generation, editing and presenter workflows.
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

See [API.md](API.md) for endpoints, [adr/ADR-001-control-plane.md](adr/ADR-001-control-plane.md) and [adr/ADR-002-integrated-monorepo.md](adr/ADR-002-integrated-monorepo.md) for historical context, and [adr/ADR-003-complete-video-runtime.md](adr/ADR-003-complete-video-runtime.md) for the complete independent video architecture.

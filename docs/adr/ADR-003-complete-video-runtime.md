# ADR 003: Complete independent video production inside PengManager

Status: implemented; production capability verification is recorded separately.

Date: 2026-10-24

The user requires all Edit AI generation, editing, presenter/oral video,
Compositor, digital employees, skills and tools inside one independent system.
The earlier post-production subset cannot satisfy that requirement.

The selected design retains the complete pinned Edit source under
`engines/video-edit` and supervises its own PostgreSQL, native backend, tool
stations and root-origin web workbench. `node src/server.mjs` remains the single
product launch command after explicit local setup. Native production
transactions, budget reservations, qualifications, source/character rights,
G1–G8 and recovery remain in their original implementations. PengManager JSON
and GEO SQLite records retain their identity and existing histories.

Two candidates were considered. A same-origin subpath proxy would keep one
browser origin, but requires broad changes to native app base paths, media,
authentication links and root CSP. An owned loopback root-origin workbench
retains the real native application and authentication with fewer compatibility
changes; the root dashboard links to it only after actual readiness. The second
candidate is selected. The cost is a separate local browser origin and explicit
supervision of several processes.

The supervisor uses a private owner-only data root outside the repository,
authenticates to its owned PostgreSQL roles, verifies cluster/process/port and
embedded dependency paths, and obtains a real scoped local owner session through
the native bootstrap endpoint. The browser receives no process bootstrap key.
The root HTTP API exposes only safe status and complete inventory projections;
it does not issue native identity from an `actor`/`approvedBy` request body.

The whole source declaration catalog is searchable and paginated. Declared
code, dependency/process readiness and actual production validation are
different facts. Existing local quick post-production is retained and labeled
with its four-second-per-input and synthetic ambient-audio behavior.

The design does not configure suppliers, waive their usage fees, grant media
rights, auto-approve business gates, expose a public service or publish content.
It does not treat copied source, a catalog row, an HTTP 200 or a test fixture as
production output. Those claims require their own genuine receipts.

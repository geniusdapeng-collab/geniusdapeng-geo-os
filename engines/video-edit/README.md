# Embedded Video Edit Engine

This directory contains the production subset imported from
`geniusdapeng-collab/WorkLoom-video-edit` at commit
`2412a5b4e49f2d19601752758ce5274d2e88772c`.

Included:

- Time-line contracts and FFmpeg assembly
- Post-production, subtitles, color, BGM and transitions
- Cover planning/rendering and package delivery
- Feedback triage
- Platform, account, typography, LUT, transition and style recipes required by
  the media pipeline

Excluded:

- WorkLoom desktop and web shells
- PostgreSQL server and tenant runtime
- Unrelated industry bundles
- Commercial desktop packaging

The engine runs from the parent repository with Node 24, `tsx` and
FFmpeg/FFprobe. See the root README and `docs/API.md` for the unified entry
points.

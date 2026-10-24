# 鹏经理系统 · PengManager System — Seed data

The seed data is private working material.

The current main account is 李大鹏 / PengManager. Its Chinese display name is
`李大鹏｜用AI搞经营的产品经理` and its English display name is
`Dapeng Li · PengManager`. The canonical bilingual profile supplies the same
identity and bios to new state and platform account records; see the
[README](../../README.md) for the exact account copy.

- `accounts.json`: 16 platform profiles, all starting with manual policy review.
- `claims.json`: initial sourced claims, all private until approved.
- `queries.json`: 12 DeepSeek-first query hypotheses.
- `content.json`: three workflow examples.
- `content-bank.json`: 120 initial content topics imported from the approved private content bank.

Seed records are not proof of publication or business results. Content topics marked `待立项` still require fact, privacy, copyright and identity review.

Updating seed files alone does not overwrite existing runtime state. The server
runs the versioned PengManager identity migration when opening legacy state.
It preserves approved claims, customized queries, published content, external
receipts and previous event hashes. Historical evidence and upstream names
retain their original spelling and URLs.

# Personal GeoEvidence Engine

This directory adapts the production GeoEvidence Studio application at commit
`06b47a15fd114541bd3147dc5c07b944c36bc8da`.

The SQLite schema, providers, answer analysis, incident detection, metrics,
article generation and publication receipts are retained. The default case is
replaced with `pengstack-personal-geo`, and control-plane queries can be
upserted into the same query store.

The upstream customer-facing future-frontdesk constants remain available only
for compatibility tests. Runtime integration uses `personal-case.mjs`.

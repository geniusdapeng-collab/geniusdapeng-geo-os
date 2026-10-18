# Repository Instructions

This repository is a private, local-first personal GEO control plane.

## Required boundaries

- Never write tokens, cookies, passwords, private keys, customer data or private contact details into the repository, logs, tests, fixtures or screenshots.
- Never treat a mock, local file, HTTP 200 or fixture as a real platform publication.
- Never add unattended publishing or interaction automation for a platform without a reviewed official interface and explicit authorization.
- Public export must only read approved, unexpired, non-sensitive `approved_public` claims.
- High-risk recruiting, customer, legal, financial, privacy and negative interactions remain human-only.
- Live scripts may spend model tokens or write to external platforms. Run them only when the user authorized that action.
- Store full live evidence under `var/`; commit only sanitized receipts under `docs/evidence/`.

## Before committing

```bash
node --check src/server.mjs
node --check public/app.js
node --test tests/*.test.mjs
node --test engines/geo-evidence/test/*.test.mjs
pnpm test:vendor
node scripts/smoke.mjs
node scripts/security-scan.mjs
```

All tests must pass. If the UI changes, verify desktop at 1440 px and mobile at 390 px with no horizontal overflow or console errors.

Before a live run, verify that `GITHUB_TOKEN`, `DEEPSEEK_API_KEY`, cookies and
other secrets remain process-scoped. Never paste a secret into a receipt.

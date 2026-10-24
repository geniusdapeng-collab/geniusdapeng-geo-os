# 鹏经理系统 · PengManager System — Operations

The product name is 鹏经理系统 / PengManager System. The main account is 李大鹏 /
PengManager, with the canonical bilingual display names and bios in the
[README](../README.md). Platform handles and real account URLs remain the actual
configured identifiers; a local profile update does not rename them remotely.

## Daily

1. Open the dashboard and check the event head and pending queues.
2. Check the current main-account copy before preparing a platform package.
3. Approve only claims with traceable evidence.
4. Move useful drafts through fact check and approval.
5. Record publication only after the external URL exists.
6. Classify new comments and messages, keeping high-risk interactions human-only.

## Weekly

1. Run the approved DeepSeek P0 query set when model usage is authorized.
2. Record `real` or `imported` observations with citations and answer hashes.
3. Review negative mentions, historical aliases and same-name ambiguity.
4. Reconcile account policy review dates and actual external profile copy.
5. Inspect failed or blocked content.

## Monthly

1. Recalculate account baselines and content coverage.
2. Review public claims for expiry and accuracy.
3. Recheck upstream adapter pins.
4. Back up the complete `var/` directory through a protected local backup.
5. Rotate any token that appeared in chat, logs or screenshots.

## Identity update and existing state

New installations use the PengManager profile immediately. For an existing
`var/state.json`, the server opens and verifies the hash event chain, then runs
the versioned identity migration before constructing the control-plane services.

The migration:

- Updates the product and bilingual main-account profile, and refreshes the 16
  local platform profiles while preserving their real handles and URLs.
- Merges the previous brand aliases into the current entity's recognition
  aliases so older AI answers can still be attributed to the same person.
- Updates a seeded query only when its text still matches the recognized legacy
  default. Customized query text is retained.
- Updates recognized legacy claim wording only while the claim is unapproved;
  existing approval decisions and approved fact text are retained.
- Refreshes recognized legacy content-bank titles, hooks and theses while
  preserving edits that differ from the old defaults.
- Changes the previous default owner on draft content to PengManager. Existing
  published content and publication receipts retain their original values.
- Appends an `identity.updated` event. Previous events and their hashes are not
  rewritten; repeated startup does not repeat the migration event.

The GEO engine keeps case ID `pengstack-personal-geo` and stable `ps-*` query IDs
for compatibility. Its current profile version and display name use PengManager.
Recognized default query fields are refreshed while customized fields and
historical samples, articles and publication receipts are retained.

Stop the service and back up all of `var/` before updating. Start normally with
`node src/server.mjs`, then inspect the account profiles and `/api/events` to
verify the current identity and a valid event chain. Do not delete the state file
or manually replace text inside old events to change a display name.

The migration updates local operational data. External profile changes and
content publication still require each platform's reviewed process and a real
receipt.

## Backup and restore

The complete video engine is installed and supervised from this repository:

```bash
node scripts/video-setup.mjs --install --build --postgres-root /path/to/postgresql-17
node scripts/video-doctor.mjs
node src/server.mjs
```

The explicit PostgreSQL prefix must contain a complete PostgreSQL 17 tool
package with pgvector. The installer copies `bin/lib/share` into private
PengManager storage and creates its own authenticated cluster. It does not copy
an existing database or reuse an unrelated service occupying a managed port.
`--install` uses the embedded lockfile; `--build` builds the embedded contract and
web workbench. Use `--help` for the current supported CLI options. Ordinary root
startup uses the prepared environment and never silently installs dependencies.

CLI/MCP operation is the default; the complete web source is retained for later
use. `node scripts/agent.mjs list` shows the reviewed callable catalog,
`node scripts/agent.mjs capabilities` shows all embedded roles, skills and tools,
and `node scripts/agent-mcp.mjs` runs the stdio server. Native operations obtain
the managed owner session and keep the existing server-side guards. One agent
process owns one video supervisor; an existing process-only `WORKLOOM_ACCESS_TOKEN`
can attach to the same configured loopback backend without starting another one.
Use `--with-workbench` on `video-start.mjs` to enable the optional built web UI.

The root command starts JSON/GEO first and starts video in the background. Open
“视频工作台” to see not-installed/stopped/setting-up/starting/ready/stopping/error
and all missing dependencies. Setup or provider failure does not remove the
existing dashboard. SIGINT/SIGTERM stops the owned video backend, web server,
tool stations and PostgreSQL and then closes the original control plane. Do not
kill another application's process to free a port. Run one supervisor per private
video data directory.

The root `test:vendor` and `test:ci` scripts serialize the media-heavy files and
use a single Vitest worker. Assertions and per-test time limits stay unchanged;
run these checks separately from model imports, source builds or other FFmpeg
batches to avoid measuring workstation resource contention as a product error.

The existing CI test job also installs the complete embedded engine with its
own pinned package manager and frozen lockfile, builds the industry contract
and native web workbench, typechecks the native server, and runs the identity,
onboarding, role-preservation and declared-skill regressions. Its tool tests use
explicit local protocol fixtures. Linux CI does not download model weights,
call paid providers or certify macOS-only Compositor binaries or media quality.
The UI installer downloads the pinned original package from the producer's
[official public release](https://github.com/geniusdapeng-collab/workloom-im/releases/tag/ui-v0.1.19)
without a release credential. It checks the immutable release ID, source commit,
asset ID, size, SHA-256 and SRI before warming the package store. The existing
canonical dependency URL, package version and frozen lock identity stay the
same; package-manager children receive no credential. Only the private runner
temporary directory holds the original archive used by the boundary tests; the
archive is neither checked in nor uploaded. An unavailable release, changed
identity or mismatched bytes fails the installation check visibly. The explicit
legacy CNB interface remains available for compatibility regression tests.

On macOS, video data defaults to
`~/Library/Application Support/PengManager/video-runtime`; Windows uses
`%LOCALAPPDATA%/PengManager/video-runtime`; Linux uses
`$XDG_DATA_HOME/PengManager/video-runtime` or `~/.local/share/PengManager/video-runtime`.
Set `PENGMANAGER_VIDEO_DATA_DIR` to another owner-only directory outside this
repository when needed. `private-state.json` binds the owned database identity
and contains protected local credentials. Preserve it together with
`postgres-data`, `work`, `media`, `post` and setup/workspace receipts. Never
delete or regenerate credential state to bypass a database or assembly error.
Do not publish this directory or copy it into a source checkout.

By default, runtime data spans the JSON control-plane store, GEO SQLite database
and media job directories:

```text
var/state.json
var/geo-engine/
var/media/jobs/
<private-video-data-directory>/
```

If `DATA_FILE` or `GEO_ENGINE_DB` points outside these default locations, include
the configured state file or database directory in the stopped backup and
restore it to the same configured location.

Stop the root service and confirm all owned video processes have stopped before
copying both the complete `var/` directory and the private video data directory.
This keeps JSON, GEO SQLite, video PostgreSQL, task archives and media receipts
at a consistent stopped boundary. Use a protected
backup destination outside the repository; this example assumes that directory
already exists:

```bash
cp -R var /path/to/encrypted-backup/pengmanager-var-2026-10-24
```

Restore only while the service is stopped. If the current `var/` exists, preserve
it as a separate recovery copy before restoring. The recovery path below must
not already exist:

```bash
mv var /path/to/encrypted-backup/pengmanager-before-restore-2026-10-24
cp -R /path/to/encrypted-backup/pengmanager-var-2026-10-24 var
node src/server.mjs
```

The example above restores the original control-plane data only. Restore the
private video directory to its original configured location as a separate
protected step, preserving its credential state and PostgreSQL cluster
together. Keep the current directory as a recovery copy before replacing it.
Do not merge files from two database clusters or copy a live PG data directory.

If there is no current `var/`, omit the `mv` step. After restart, run the video
doctor and inspect the native active bundle, original event chain, GEO history
and video task/archive history before recording new operations. Runtime data may
contain private operations and local source paths; keep it outside Git and
unencrypted cloud storage.

## Incident

If the hash chain fails verification, stop writes and preserve the current file.
Do not edit events in place. Restore a known-good protected backup or open a
migration task that records the recovery reason.

If an identity migration fails, preserve the full stopped `var/` directory and
the error message without secrets. Resolve the failure or restore the backup
before restarting; do not bypass event verification or reset the state.

If a secret leaks:

1. Rotate it before further API work.
2. Do not paste the secret into an incident note.
3. Scan tracked files and runtime logs.
4. Remove the secret from history only after assessing collaborators and deploy
   impact.

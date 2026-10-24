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

By default, runtime data spans the JSON control-plane store, GEO SQLite database
and media job directories:

```text
var/state.json
var/geo-engine/
var/media/jobs/
```

If `DATA_FILE` or `GEO_ENGINE_DB` points outside these default locations, include
the configured state file or database directory in the stopped backup and
restore it to the same configured location.

Stop the service before copying the complete directory so the JSON state, SQLite
files and media receipts represent the same stopped runtime. Use a protected
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

If there is no current `var/`, omit the `mv` step. After restart, inspect the event
chain and GEO/media history before recording new operations. Runtime data may
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

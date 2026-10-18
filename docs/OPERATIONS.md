# Operations

## Daily

1. Open the dashboard and check the event head and pending queues.
2. Approve only claims with traceable evidence.
3. Move useful drafts through fact check and approval.
4. Record publication only after the external URL exists.
5. Classify new comments and messages.

## Weekly

1. Run the DeepSeek P0 query set.
2. Record `real` or `imported` observations with citations and answer hashes.
3. Review negative mentions and same-name ambiguity.
4. Reconcile account policy review dates.
5. Inspect failed or blocked content.

## Monthly

1. Recalculate account baselines and content coverage.
2. Review public claims for expiry and accuracy.
3. Recheck upstream adapter pins.
4. Back up `var/state.json` through an encrypted local backup.
5. Rotate any token that appeared in chat, logs or screenshots.

## Backup and restore

The runtime state is a single JSON file in v0.1.

```bash
cp var/state.json /path/to/encrypted-backup/pengstack-state-$(date +%F).json
```

Restore only while the service is stopped:

```bash
cp /path/to/encrypted-backup/pengstack-state-2026-10-18.json var/state.json
node src/server.mjs
```

The file contains private operation data. Do not put it in this repository or unencrypted cloud storage.

## Incident

If the hash chain fails verification, stop writes and preserve the current file. Do not edit events in place. Restore a known-good encrypted backup or open a migration task that records the recovery reason.

If a secret leaks:

1. Rotate it before further API work.
2. Do not paste the secret into an incident note.
3. Scan tracked files and runtime logs.
4. Remove the secret from history only after assessing collaborators and deploy impact.

# 鹏经理系统 · PengManager System — Operations

The product name is 鹏经理系统 / PengManager System. The main account is 李大鹏 /
PengManager, with the canonical bilingual display names and bios in the
[README](../README.md). Platform handles and real account URLs remain the actual
configured identifiers; a local profile update does not rename them remotely.

## Public website, private workspace and credentials

The cloud deployment serves the public personal website at `/` with
`PUBLIC_WEBSITE=1`. The website reads `/public-api/profile`, which contains the
public bilingual identity and filtered public claims; it cannot retrieve
private account matrices, drafts, interactions or operation queues. `/about`
is also a public introduction page. `/admin` is the private dashboard, and
`/login` is its sign-in page.

Default loopback development remains usable without a password. Public or
production configurations refuse to start without administrator authentication
and an HTTPS `PUBLIC_ORIGIN` matching the allowed Host. Keep the Node listener
on loopback behind the configured HTTPS proxy. Follow
[ALIYUN-DEPLOYMENT.md](ALIYUN-DEPLOYMENT.md) for actual resource checks, packaging,
installation, certificate verification and recovery; a locally working page is
not an online-deployment receipt.

The owner keeps the administrator password. Service configuration stores its
scrypt hash, not plaintext. Sessions use HttpOnly/SameSite=Strict cookies,
Secure in the HTTPS configuration, and expire after the configured lifetime.
Logging out revokes the current session. Restarting the process requires a new
login. Repeated password failures and concurrent verification work are bounded.
Never paste a password or session cookie into an operation, receipt or report.

An optional independent Agent token lets an authorized local Codex session read
the limited operational context, record interactions, and start/complete/fail
already-approved ordinary browser operations. Store only its hash in server
configuration and keep its plaintext process-scoped for the authenticated
request. It cannot create or approve operations, approve facts/content, change
account settings, call live publishing endpoints, or use the legacy manual
publication endpoint to bypass approval. The service derives audit actors from
authentication. An Agent completion always identifies the Agent as capturer and
verifier and uses `browser_readback`; it cannot name the owner as its reviewer.

Social-platform login states stay in the owner's local Chrome. The cloud service
does not receive platform passwords, login cookies or saved browser profiles.
An operation marked `in_progress` is a record of an authorized task, not a
background browser robot or a promise that the platform has accepted a post.

## Prepare, authorize, execute and reconcile one account action

1. In **账号矩阵 → 运营设置**, replace placeholder handles with the actual account,
   check its public profile URL, enable it, and review the platform's applicable
   rules. Record the actual review date and reviewer. These settings update
   the internal ledger; separately confirm that Chrome is logged into the same
   account.
2. For a publication, review and approve the supporting Claims in **内容工厂**,
   inspect the complete body, then move it through `fact_check`, `approved`, and
   `scheduled`. Keep one content object per account/platform publication. To
   distribute a variant elsewhere, create a separate content object and review
   it independently.
3. Create a **运营动作** draft. Publishing binds the scheduled content. Replying
   records a public target post/comment URL and the exact reply text; link a
   stored interaction when available so its original risk classification is
   preserved. Select `browser` for authorized local-browser execution or
   `manual` for execution by the owner. High-risk L0 replies are manual-only;
   L3 interactions cannot be authorized for engagement.
4. Review the precise account and complete text, and record a specific
   `authorizationNote`. Administrator approval binds the content hash and the
   creation-time `accountSnapshot`: account ID, platform, handle and profile
   URL. Changing a handle/profile URL or body after creation invalidates the
   pending action; create and approve a replacement. The original identity
   snapshot remains visible in historical action records.
5. Mark the approved action started. The owner, or Codex carrying that specific
   authorization, now performs the actual action through the ordinary local
   Chrome UI. This dashboard does not directly click a platform's publish
   button. Stop at platform login verification, CAPTCHA or a new binding
   agreement that requires the owner's action; do not automate around them.
6. Open the platform result, verify the account, final text and successful
   publication/reply, then save the real result URL and time. Record
   `capturedBy`, `dataMode`, `verificationMethod`, `verifiedAt`, and `verifiedBy`.
   `real` means this actual execution was captured; `imported` means a genuine
   prior platform result was imported. Neither label can turn a fixture,
   draft, local file or HTTP success into evidence of publication.
7. The operation becomes `completed` only after its receipt is accepted. A
   publication also invokes the existing content/Claim validation and updates
   the publication ledger and content state; a reply retains its own target,
   exact reply body and readback receipt. Check the result and the event chain
   after refresh.

Readback metadata states who actually checked the external page and how. The
server validates receipt structure, dates, safe URLs and hash consistency; it
does not fetch authenticated platform pages or independently prove that a URL
was published. Operations use public HTTPS URLs; platform comment anchors are
allowed, while local/example/numeric hosts and credential-bearing URLs are
rejected. The legacy administrator-only manual publication endpoint retains
public HTTP compatibility, applies the same credential/local/example URL
protections, and does not require the new operation-only readback fields.
New browser work should use the complete operation workflow.

## Failure, retry and concurrency

Operation states are `draft → approved → in_progress → completed`, with a
recorded `failed` outcome possible before completion. Preserve the actual failure
reason when nothing was published. If the platform already accepted the action,
reconcile its original result instead of posting again or labelling it failed.

The same normalized receipt can be submitted again safely: it returns the
existing completion without another publication or completion event. Different
replacement receipts and duplicate platform-result URLs are rejected. If the
publication ledger write succeeded but the subsequent operation write failed,
retry the original receipt to recover the operation state. The system refuses
to overwrite a recorded publication with a failure outcome.

JSON mutations are serialized in one store instance; operation completion also
serializes the two ledger writes, including multiple operation-service instances
sharing that store. This is not a multi-process database lock. Keep exactly one
writable Node process for a given `state.json`; do not run independent local and
cloud writers against copies that will later be merged. After a migration,
choose the authoritative writable instance and retain the stopped source copy
as a protected backup.

## Daily

1. Open `/admin`, sign in when authentication is enabled, and check the event head and pending queues.
2. Check the current main-account copy before preparing a platform package.
3. Approve only claims with traceable evidence.
4. Move useful drafts through fact check, approval and scheduling.
5. Authorize each account operation, execute it in the actual local browser, and record completion only after opening and checking its platform result.
6. Classify new comments and messages, keeping high-risk interactions human-only.
7. Reconcile in-progress or failed operations and verify that finished work has the original account/text snapshot and a complete readback receipt.

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
var/state.json                 # includes accountOperations and its authorization/readback receipts
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

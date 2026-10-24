# 鹏经理系统 · PengManager System — HTTP API

The service listens on `http://127.0.0.1:4318` by default.

AI agents must first read the complete [AI Agent usage guide](AI-AGENT-GUIDE.md)
and root [AGENTS.md](../AGENTS.md). The guide includes production-origin curl
examples, credential handling, administrator versus scoped Agent permissions,
content approval, real browser execution, receipt recovery, GEO and local
video/backup boundaries. A checkout's routes are not proof that the target
running service has deployed the same version.

The product name is `鹏经理系统` / `PengManager System`. The underlying GitHub
repository URL remains `geniusdapeng-collab/geniusdapeng-geo-os`; changing the
display brand does not redirect or rename external account URLs.

All write endpoints accept JSON and return structured errors:

```json
{
  "error": {
    "code": "CONTENT_APPROVAL_BLOCKED",
    "message": "内容未通过事实或安全闸门。",
    "details": {
      "findings": []
    }
  }
}
```

## Public website and authentication

With `PUBLIC_WEBSITE=1`, `GET /` serves the public personal website. `GET /about`
also serves that website. `GET /admin` serves the operational dashboard and is
protected when administrator authentication is enabled. The default local-only
development listener keeps the dashboard at `/` as well.

| Method | Path | Access and response |
|---|---|---|
| GET / HEAD | `/healthz` | Public minimal liveness: `ok`, `service`; no operational counts |
| GET | `/public-api/profile` | Public bilingual identity and filtered public claims |
| GET | `/login` | Public login page; does not grant access to private state |
| GET | `/api/auth/status` | `enabled`, `authenticated`; an authenticated session also identifies its server-derived actor and expiry |
| POST | `/api/auth/login` | JSON `{ "password": "…" }`; returns authentication status and sets an HttpOnly, SameSite=Strict session cookie |
| POST | `/api/auth/logout` | Revokes the current browser session and expires its cookie |

Public/production configurations require a valid `ADMIN_PASSWORD_HASH`, an HTTPS
`PUBLIC_ORIGIN`, and its matching allowed Host. Startup fails closed if the
configuration is incomplete. Production cookies are Secure and host-only.
Passwords are scrypt hashes in service configuration; plaintext passwords are
not stored. The login endpoint bounds failed attempts and concurrent password
verification. Authentication expiry returns 401 for private APIs; opening the
protected dashboard redirects to `/login`.

The optional `ADMIN_AGENT_TOKEN_HASH` enables a separate bearer credential. Its
plaintext value is sent only in an `Authorization: Bearer …` request header,
never in a URL, operation, receipt, repository or screenshot. Server configuration
contains only its hash. Its exact route scope is:

- GET `/api/bootstrap`, `/api/summary`, `/api/events`, `/api/content`,
  `/api/interactions`, `/api/operations`.
- POST `/api/interactions` and `/api/operations/:id/start`, `complete`, `fail`.
- Operation writes additionally require an existing administrator approval,
  `executionMode: "browser"`, and a non-L0/non-L3 interaction.

The Agent cannot create or approve operations, update accounts, approve claims
or content, call live publishing/model routes, or bypass the workflow through
`POST /api/publications/manual`. Supplying a bearer credential never falls back
to a more privileged browser cookie. The server derives mutation actors from
the authenticated principal on account/operation/interaction/receipt routes;
operation approval uses that administrator identity. For Agent completion,
`capturedBy` and `verifiedBy` are set to the Agent identity and
`verificationMethod` is forced to `browser_readback`, even if the request tries
to name a human reviewer.

`/public-api/profile` does not return aliases, account records, private facts,
content, operations, interaction text, media paths or operational counts. Claims
must be `approved_public`, approved, unexpired and free of sensitive text, have
`source.visibility: "public"`, and not declare a sensitivity other than `low`.
Only a safe source `label`, `url`, and `visibility` are exported; arbitrary
source notes are omitted. Credential-bearing source URLs are excluded.

## Private read

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Process and summary health |
| GET | `/api/bootstrap` | Dashboard bootstrap payload |
| GET | `/api/summary` | Counts and event head |
| GET | `/api/events?limit=100` | Recent events plus hash-chain verification |
| GET | `/api/claims` | Claim ledger |
| GET | `/api/content` | Content objects |
| GET | `/api/interactions` | Classified interactions |
| GET | `/api/operations` | Account-operation drafts, authorization snapshots and receipts |
| GET | `/api/geo/queries` | GEO query set |
| GET | `/api/geo/observations` | AI answer samples |
| GET | `/api/geo/metrics` | Mention, citation, negative and coverage metrics |
| GET | `/api/exports/public-preview` | Only exportable public claims |
| GET | `/api/adapters/health` | DeepSeek, GitHub, personal GEO and media engine readiness |
| GET | `/api/geo/engine/summary` | Personal GEO SQLite metrics, incidents and runs |
| GET | `/api/geo/engine/queries` | Personal query set from the integrated engine |
| GET | `/api/geo/engine/samples` | Evidence samples and citation analysis |
| GET | `/api/geo/engine/incidents` | Negative and risk incidents |
| GET | `/api/geo/engine/articles` | Generated personal article drafts |
| GET | `/api/media/jobs` | Completed media jobs and receipt summaries |
| GET | `/api/video-runtime/status` | Safe owned-runtime state, actual readiness and validated loopback workbench entry |
| GET | `/api/video-runtime/capabilities` | Complete embedded role/skill/tool/capability/installer inventory and actual station status |
| GET | `/api/video-edit/library?kind=all` | Embedded character/product/media library catalog |
| GET | `/api/video-edit/products/resolve?selector=...` | Resolve an exact local product selector |

## Identity payload

`GET /api/bootstrap` includes the canonical bilingual entity profile for the
dashboard and platform account records. The current main account is `李大鹏`
in Chinese and `PengManager` in English. Its display names and bios are:

```text
李大鹏｜用AI搞经营的产品经理

全栈 AI 产品专家，把模型能力做成专业领域 Agent 数字员工与自主经营系统。
```

```text
Dapeng Li · PengManager

Turning model capabilities into domain-specific AI employees and autonomous business systems.
```

| Field | Meaning |
|---|---|
| `system.id` | Stable current service identifier: `pengmanager-system` |
| `system.nameZh` / `system.nameEn` | Product names: 鹏经理系统 / PengManager System |
| `entity.nameZh` / `entity.nameEn` | Chinese and English main-account names |
| `entity.displayNameZh` / `entity.displayNameEn` | Exact bilingual display names |
| `entity.bioZh` / `entity.bioEn` | Full bilingual bios, including the blank line |
| `entity.profileVersion` | Identity migration version, currently `2` |
| `entity.aliases` | Current and historical recognition names |

Compatibility fields such as `publicName`, `englishName`, `displayName`,
`englishDisplayName`, `bio` and `englishBio` remain available. Each account also
provides bilingual name/display-name/bio fields; its `language` selects the
default `name`, `displayName` and `bio` for that platform. Real handles and URLs
are preserved.

`GET /api/health` returns `service: "pengmanager-system"` and the same `system`
identity object. Consumers matching the previous service label should update
that comparison; endpoint paths are unchanged.

`GET /api/exports/public-preview` exposes the current public identity alongside
exportable claims. It does not approve a claim or publish an account profile.
Recognized historical aliases support GEO matching; they are not the current
display name. Existing data is upgraded at server startup as described in
[OPERATIONS.md](OPERATIONS.md).

## Write

| Method | Path | Purpose |
|---|---|---|
| PATCH | `/api/accounts/:id` | Update actual handle/profile URL, account status and platform-rule review |
| POST | `/api/operations` | Create one publish or reply operation draft |
| POST | `/api/operations/:id/approve` | Record one administrator authorization for the exact operation |
| POST | `/api/operations/:id/start` | Mark an authorized operation in progress; no external post is sent |
| POST | `/api/operations/:id/complete` | Record actual platform readback and complete; publications also update the content ledger |
| POST | `/api/operations/:id/fail` | Preserve a failure reason and end an incomplete operation |
| POST | `/api/claims/:id/approve` | Approve a claim and choose `private` or `approved_public` |
| POST | `/api/content` | Create a draft |
| POST | `/api/content/:id/transition` | Move through fact check and approval states |
| POST | `/api/publications/manual` | Record a real or imported publication receipt |
| POST | `/api/interactions/classify` | Classify without storing |
| POST | `/api/interactions` | Classify and store |
| POST | `/api/geo/queries` | Add a stable query |
| POST | `/api/geo/observations` | Record an AI answer sample |
| POST | `/api/live/generate-content` | Generate content with the current model |
| POST | `/api/live/deepseek/collect` | Run real DeepSeek Search + Chat/Responses queries |
| POST | `/api/live/geoevidence/run` | Run the in-process personal GEO engine |
| POST | `/api/live/video-edit/cover` | Get cover knowledge and trace hints |
| POST | `/api/live/media/render` | Build timeline, run post/cover/package, and write output receipts |
| POST | `/api/live/github/publish` | Publish an approved scheduled item as a GitHub Issue |
| POST | `/api/geo/engine/articles/generate` | Generate the personal article set |
| POST | `/api/video-edit/characters/resolve` | Resolve embedded character selection and current local authorization state |

Every `/api/live/*` request must include `"confirm": true`. This prevents a
dashboard refresh or accidental form submission from spending model tokens or
writing to an external platform.

`POST /api/live/media/render` also accepts:

- `sources`: non-empty local MP4 path array
- `title`: delivery title
- `coverTitle`: title used in cover/copy artifacts
- `hook`: one-line hook persisted into cover/copy checks
- `platform`: target platform label
- `subtitleText`: subtitle text
- `variants`: one or more of `warm-story`, `clean-tech`, `bold-promo`,
  `natural-clean`

The requested `coverTitle` and `hook` are verified in the generated copy
artifacts, not merely echoed in the API response.

## Request boundary

The video-runtime routes accept only GET and no query parameters. Unknown paths
are rejected; there are no root API start/setup/session endpoints. Status returns
HTTP 200 with `ready:false` for an absent/stopped/starting runtime, so 200 is not
production success. Catalog absence or a runtime read failure returns a safe 503
error. Raw thrown provider errors, bootstrap keys, native tokens, environment
maps and unknown fields are not projected. A clickable workbench entry is only
offered for `ready` and an HTTP loopback root URL with an explicit port and no
credentials, query or fragment.

The complete native workbench has its own owned loopback origin. Its local
session exchange is protected by the browser session cookie, same-origin POST
and a random process-bound CSRF header; the process bootstrap key remains on
the server. Native authorization comes from the real scoped local owner member,
not root JSON body bookkeeping. Paid generation, approvals, cancellation,
recovery and full production APIs remain the embedded native contracts. Merely
reading a catalog or status never submits a supplier request.

Catalog rows keep `declared`, `codePresent`, `dependencyState` and `validated`
separate. Station records separately report `installed`, `ready`, `running`,
`missing`, and `productionVerified`; dependency/process readiness is not media
quality evidence. All catalog arrays are retained, without a first-page-only
server projection.

The default listener accepts only allowlisted loopback Hosts. Public deployment
uses the exact configured HTTPS origin and Host, independently of caller-supplied
forwarded host/protocol headers. Foreign Origins and cross-site API requests are
rejected before route handling. Ordinary cross-site navigation to the public
website/login shell is permitted; it does not authorize access to private APIs.
A CLI client may omit browser Origin headers but must still provide the required
session or scoped Agent authentication.

JSON request bodies must be objects, are limited to 1 MB, and invalid JSON,
arrays or null return a structured client error. Platform cookies, passwords,
access tokens and other login credentials are not operation fields. Sensitive
operation text and nested credential-shaped fields are rejected before writes.


## Content state machine

```text
draft -> fact_check -> approved -> scheduled
  |         |            |            |
  +-> blocked <- +--------+------------+
                               published only via receipt
published -> archived
```

`fixture` and `draft` receipts are rejected. A valid receipt needs:

- `contentId`
- `accountId`
- `receipt.url`
- `receipt.publishedAt`
- `receipt.capturedBy`
- `receipt.dataMode` equal to `real` or `imported`

The administrator-only legacy endpoint retains public HTTP/HTTPS URLs and its
original required fields. New writes reject credentials, local/numeric/example
hosts, and credential-bearing query/fragment values; existing stored receipts
are preserved. Agent execution uses the stricter operation-completion workflow
below.

## Account settings

`PATCH /api/accounts/:id` accepts any of:

```json
{
  "handle": "actual-platform-handle",
  "profileUrl": "https://github.com/geniusdapeng-collab",
  "status": "active",
  "policyStatus": "reviewed",
  "policyCheckedAt": "2026-10-24T00:00:00+08:00"
}
```

`status` is `draft`, `active`, or `paused`; `policyStatus` is `reviewed` or
`manual_review_required`. Reviewed rules require a valid review date and record
the server-derived reviewing actor. `profileUrl` may be empty to clear the URL;
a non-empty value must be a public HTTPS URL without credentials. This updates
the internal account record, not the platform's remote profile or login session.

## Account-operation state machine

```text
draft -> approved -> in_progress -> completed
draft / approved / in_progress -> failed
```

`failed` and `completed` are terminal. A failed operation can be replaced by a
new draft. A second active publish operation for the same content is rejected;
the existing content state machine supports one publication per content object.
Use separately approved content objects for different platform/account posts.

Create a publish draft with `accountId`, `type: "publish"`, `contentId`, and
`executionMode: "browser"` or `"manual"`. The service records an immutable
`contentSnapshot` (`title`, `body`, `version`), `contentHash`, and
`accountSnapshot` (`id`, `platform`, `handle`, `profileUrl`). Creation does not
publish anything. Approval requires content already in `scheduled` and rechecks
account activation, platform rules, target platform and current Claim validity.

Create a reply draft with:

```json
{
  "accountId": "github",
  "type": "reply",
  "executionMode": "browser",
  "targetUrl": "https://github.com/geniusdapeng-collab/geniusdapeng-geo-os/issues/1",
  "replyText": "The exact complete reply authorized for this action.",
  "interactionId": "INT-0001"
}
```

`interactionId` is optional. When present, the original interaction text remains
part of risk classification. L0 is human-only and requires `manual`; L3 cannot
be authorized for a reply. The service hashes the exact reply body.

`POST /api/operations/:id/approve` requires `authorizationNote`; it records
`approvedBy`, `approvedAt`, and the approved `contentHash`. Approval is an
administrator action. `start` marks execution and its actor/time, with no
external-platform request. Content and account identity are rechecked at
approval, start and completion; changing a handle/profile URL returns
`ACCOUNT_IDENTITY_CHANGED`, and changing body text returns
`OPERATION_CONTENT_CHANGED`. Old authorization cannot be reused for the changed
account or text. Historical operation displays retain the original handle.

After actually publishing/replying in the authorized local browser, open the
platform result and compare it with the approved text. Complete the operation
with:

```json
{
  "receipt": {
    "url": "https://github.com/geniusdapeng-collab/geniusdapeng-geo-os/issues/1#issuecomment-123",
    "publishedAt": "2026-10-24T10:00:00.000Z",
    "capturedBy": "PengManager",
    "dataMode": "real",
    "verificationMethod": "browser_readback",
    "verifiedAt": "2026-10-24T10:01:00.000Z",
    "verifiedBy": "PengManager"
  }
}
```

The example is a schema illustration, not evidence that its URL was published.
The actual receipt must identify the real result. `dataMode` is `real` or
`imported`; `verificationMethod` is `browser_readback` or `manual_readback`.
All shown fields are required. `contentHash` is optional in the request, but if
provided must match; the server always records the authorized hash. Dates must
be valid and cannot be more than one minute in the future. Readback cannot
precede publication. Result/target URLs must be public HTTPS and exclude
loopback/numeric/example hosts, userinfo, credential query parameters and
credential-bearing URL fragments, including encoded fragments. Normal platform
comment anchors are retained.

The service records the executor's readback statement; it does not fetch the
platform page or independently prove that a supplied URL was published. For
publishing, completion calls `GeoOsService.recordPublication`, preserving the
content/Claim gates and content hash. For replies, the operation stores the
exact reply, target, readback and receipt hash without fabricating a content
publication record. Both paths append events.

Submitting the same normalized receipt again returns the completed operation
without duplicate ledger/event writes, including concurrent requests sharing
the same store. A different receipt returns `RECEIPT_CONFLICT`. A platform URL
already used by a different operation on that account returns
`DUPLICATE_PLATFORM_RECEIPT`. If publication was persisted but the operation's
second write failed, retry the same receipt to finish recovery; do not republish
or mark the already-recorded publication as failed. Run only one writable
process per JSON data file.

`POST /api/operations/:id/fail` requires `reason`; the authenticated actor and
time are retained. A recorded publication cannot be overwritten by failure.

## Example

Create a draft:

```bash
curl -sS http://127.0.0.1:4318/api/content \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "为什么 Agent 必须有回执",
    "body": "先定义任务和证据，再讨论自动化。",
    "contentType": "article",
    "claimIds": ["C002"],
    "platforms": ["GitHub"],
    "owner": "PengManager"
  }'
```

The default seed claims are private and unapproved. Approve a claim before moving related content into `approved`. The curl example targets local development; protected deployment additionally requires a valid administrator session. Use the operational workflow above for browser execution and readback receipts.

# 鹏经理系统 · PengManager System — HTTP API

The service listens on `http://127.0.0.1:4318` by default.

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

## Read

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Process and summary health |
| GET | `/api/bootstrap` | Dashboard bootstrap payload |
| GET | `/api/summary` | Counts and event head |
| GET | `/api/events?limit=100` | Recent events plus hash-chain verification |
| GET | `/api/claims` | Claim ledger |
| GET | `/api/content` | Content objects |
| GET | `/api/interactions` | Classified interactions |
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

The default listener accepts only loopback Host values listed in
`ALLOWED_HOSTS`. Requests carrying a foreign `Origin`, `Sec-Fetch-Site:
cross-site` or a non-allowlisted Host are rejected before route handling.
Non-browser CLI requests remain possible when they do not claim a foreign
origin.

## State machine

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

The default seed claims are private and unapproved. Approve a claim before moving related content into `approved`.

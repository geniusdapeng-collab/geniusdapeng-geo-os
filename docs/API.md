# HTTP API

The service listens on `http://127.0.0.1:4318` by default.

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
    "owner": "PengStack"
  }'
```

The default seed claims are private and unapproved. Approve a claim before moving related content into `approved`.

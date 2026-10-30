# 鹏经理系统：AI Agent 接入与操作指南

**读者：接手本仓库的 Codex、其他编程 Agent、通过 HTTP 接入的运营 Agent，以及它们的管理员。** 克隆或更新代码后，先完整阅读根目录 [AGENTS.md](../AGENTS.md) 和本指南，再执行任务。API 字段参考 [API.md](API.md)，部署与恢复参考 [ALIYUN-DEPLOYMENT.md](ALIYUN-DEPLOYMENT.md)，完整本机视频运行时参考 [VIDEO-RUNTIME.md](VIDEO-RUNTIME.md)。

本指南依据仓库实现编写。生产入口为 <https://pengmanager.com>，私有后台为 <https://pengmanager.com/admin>。**拉到的代码、当前运行进程、云端部署版本可能不同。** 先检查目标服务和授权范围；接口不存在时核对版本，不要通过改数据库、借用管理员会话或伪造结果绕过。仓库包含完整本机视频能力，不表示小型云服务器已经安装这些依赖。

## 1. 先确定自己要完成哪件事

| 场景 | 正确流程 | 完成依据 |
| --- | --- | --- |
| 为李大鹏准备 GEO 文章并分发到一个平台账号 | 查询与证据 → 草稿 → 事实与正文审核 → 排期 → 单账号动作授权 → 实际平台发布 → 回读入账 | 已审核内容、精确授权、真实平台结果与回执；模型写完不算发布 |
| 接手已批准的帖子发布或读者回复 | 领取现有 `approved`、`browser` 动作 → 核对账号和正文 → `start` → 本机浏览器执行 → 实际回读 → `complete` | 原账号快照、正文哈希、结果 URL、实际发布时间和核验记录 |
| 做每周品牌可见性观察并准备视频 | 固定问题 → 获准采集 → 保存真实回答与引用 → 看指标和风险 → 本机 CLI/MCP 准备视频任务 | 真实样本或明确导入来源；视频还需原生审批、预算、模型与产物证据 |

P0 是证据、审批、单账号授权、执行与真实回执，缺一项就无法证明发布完成。P1 是跨平台独立变体、GEO 复测和定稿备份，分别避免错用同一正文、误读指标和丢失定稿。P2 才是扩展适配器或多人系统；当前不提供任意平台无人值守发布、统一 OAuth、多租户 Agent 凭据或跨进程 JSON 合并。

## 2. 云端、本机浏览器和视频工位各做什么

| 位置／入口 | 做什么 | 凭据与限制 |
| --- | --- | --- |
| `https://pengmanager.com/zh`、`/en` | 完整文章、图文、视频、文稿和已批准公开资料 | 无需登录；不提供账号矩阵、草稿、互动、私有媒体目录和经营统计 |
| 云端 `/admin` 与 `/api/*` | 私有账号资料、Claim、内容状态、操作授权、回执和 GEO 数据 | 管理员会话或明确支持的受限 Agent 令牌；云端不持有社媒 Cookie |
| 本人电脑上的浏览器 | 登录目标平台、检查当前账号、执行具体获准发布／回复、打开结果核对 | 平台登录态留在本人设备；验证码、登录确认及需要本人选择的新协议交给本人 |
| 本机 `scripts/agent.mjs`／`agent-mcp.mjs` | 调用本机完整视频引擎登记的能力 | 使用原生本机身份、围栏、审批、预算和回执；与云端 HTTP Agent 令牌是两套入口 |

`scheduled` 只表示内容进入待执行状态，没有后台定时发布器。`start` 只记状态，不会打开浏览器或向平台发请求。普通社媒浏览器动作由获授权的执行者完成。当前直接外发 HTTP 适配器是单独的 GitHub Issue 发布入口，不能推断其他平台也有官方 API 适配器。

本机与云端不要分别修改同一份 `state.json` 后再尝试合并。每份状态文件只允许一个可写 Node 进程。远端平台结果、云端内容账本、本机视频数据库和本机定稿副本是不同层的数据，需要分别核对。

## 3. 克隆代码后的第一轮检查

已有仓库访问权时，使用自己的既有 Git 登录方式拉取，URL 不带令牌：

```bash
git clone https://github.com/geniusdapeng-collab/geniusdapeng-geo-os.git
cd geniusdapeng-geo-os
cat AGENTS.md
cat docs/AI-AGENT-GUIDE.md
```

已有 checkout 则先检查当前分支和未提交改动，再按任务约定更新；不要为了拉取强制重置他人的改动。每次切分支／更新后，如指南或 `AGENTS.md` 有变化，重新完整阅读。`AGENTS.md` 是供遵循该约定的 Agent 自动读取的仓库入口；不能保证忽略仓库说明的平台自动执行这些规则。其他平台应把“先读这两个文件”同时写入它的项目启动说明。

先做无需秘密的公网检查：

```bash
PM_ORIGIN=https://pengmanager.com
curl --silent --show-error "$PM_ORIGIN/healthz"
curl --silent --show-error "$PM_ORIGIN/public-api/profile"
curl --silent --show-error --write-out '\nHTTP %{http_code}\n' \
  "$PM_ORIGIN/api/bootstrap"
```

最后一条在未登录时应为 `401 AUTH_REQUIRED`。首页／健康返回 200 只说明相应入口工作，不证明 Agent 认证、账号登录、发布、视频生成或备份成功。公开资料只包含获准公开且未过期、低敏感、有公开安全来源的 Claim；私有仓库和未审批 Claim 不能当公开 GEO 信源。

## 4. 其他平台 Agent 如何取得权限

### 4.1 权限矩阵

| 身份 | 可以做 | 不可以做 |
| --- | --- | --- |
| 匿名访客 | 读公开主页、公开资料与最小健康信息 | 读私有运营数据或写入 |
| 受限 HTTP Agent bearer | GET `bootstrap`、`summary`、`events`、`content`、`interactions`、`operations`；POST `interactions`；对已批准普通 `browser` 动作 `start`／`complete`／`fail` | 创建／审批内容或动作、改账号、批 Claim、调用 GEO 私有专用路由／实时模型／外发接口、使用旧手工发布接口 |
| 管理员会话 | 在本人实际授权下使用私有管理 API，包括内容准备、审核、账号设置与动作批准 | 把拥有会话当作任意外发／付费调用授权；伪造审批或回读 |
| 本机视频 CLI/MCP | 按登记工具的 schema 和原生身份调用本机视频能力 | 把 HTTP Agent bearer 当视频原生令牌；任意调用未登记 RPC；自动批准围栏与预算 |
| 独立内容 worker／checker | 在云端配对与本机 owner 范围内领取准确准备任务、逐请求预留预算、提交真实产物与独立报告 | 借管理员 Cookie、批准内容／公开发布、自行扩大权限、清空未知费用或签自己的最终检查 |

受限 bearer 是**路由权限**，没有按 token 细分的 `accountIds`、OAuth scope、JWT 角色或自动过期配置。能读的 bootstrap 包含私有账号和内容资料；不要把它交给不应读取这些数据的平台。动作写入还会检查管理员批准、`executionMode: "browser"` 及互动风险，不能借手工动作接手 L0。需要更细账号隔离时先提出权限功能修改，不能在文档或调用参数里假装隔离已经存在。

### 4.2 管理员配置与秘密交接

仓库权限不等于网站权限；网站密码也不等于平台登录权。管理员通过受保护的部署流程配置 `ADMIN_AGENT_TOKEN_HASH`，服务只保存 `sha256$…` 哈希。令牌明文要求 43–128 位 base64url 字符。哈希工具只从标准输入读入：

```bash
# 只由管理员在受保护进程中执行；变量内容来自安全交接，不写在命令行。
printf '%s' "$PENGMANAGER_AGENT_TOKEN" | \
  node src/security/admin-auth.mjs hash-agent-token
```

将输出哈希写入受保护服务配置属于部署管理员操作，详见部署文档；不要提交配置、哈希生成输入、服务秘密或 Cookie。配置令牌会涉及服务重启时，按运维流程安排，重启后浏览器需要重新登录。不要由接入 Agent 自建后门或从服务器读取令牌明文；服务没有向 Agent 返回明文令牌的接口。

在其他平台的秘密管理器中提供进程变量 `PENGMANAGER_AGENT_TOKEN`，只传给需要访问该服务的进程。交互终端可在 **Bash** 中隐藏读取；不要把真实值替换进示例、聊天或配置仓库。关闭 `set -x`，不要输出 `env`、请求头或 `curl -v/--trace`。

```bash
IFS= read -r -s -p 'Agent token: ' PENGMANAGER_AGENT_TOKEN
printf '\n'
export PENGMANAGER_AGENT_TOKEN
PM_ORIGIN=https://pengmanager.com

# 校验令牌字符后，通过标准输入提供 curl 配置，明文不出现在 argv。
pm_agent() {
  if [[ ! ${PENGMANAGER_AGENT_TOKEN:-} =~ ^[A-Za-z0-9_-]{43,128}$ ]]; then
    printf '%s\n' 'Agent token missing or invalid.' >&2
    return 1
  fi
  printf 'header = "Authorization: Bearer %s"\n' "$PENGMANAGER_AGENT_TOKEN" |
    curl --disable --silent --show-error --config - "$@"
}

pm_agent --write-out '\nHTTP %{http_code}\n' "$PM_ORIGIN/api/summary"
pm_agent "$PM_ORIGIN/api/operations"
```

用 `/api/summary` 验证 bearer；`/api/auth/status` 反映浏览器会话／本地认证，不是 bearer 验证接口。明确发送 bearer 后不会回退到权限更高的 Cookie；`403` 不能靠同时附管理员 Cookie 绕过。输出本身可能是私有经营信息，应留在受保护会话，任务完成后 `unset PENGMANAGER_AGENT_TOKEN`。

### 4.3 管理员 API 会话示例

本节只给本人或获得明确管理授权的进程使用。普通执行 Agent 应使用前一节的受限令牌。推荐本人通过 `/login` 页面操作；需要 API 时，可用受保护的临时 Cookie 文件，不把密码放进参数：

```bash
# Bash；PM_AUTH_DIR 不在仓库，整个目录仅当前用户可访问。
umask 077
PM_AUTH_DIR=$(mktemp -d "${TMPDIR:-/tmp}/pengmanager-auth.XXXXXX")
PM_COOKIE_JAR="$PM_AUTH_DIR/cookies.txt"
touch "$PM_COOKIE_JAR"
chmod 600 "$PM_COOKIE_JAR"
IFS= read -r -s -p 'Administrator password: ' PM_ADMIN_PASSWORD
printf '\n'
export PM_ADMIN_PASSWORD
python3 -c 'import json,os; print(json.dumps({"password":os.environ["PM_ADMIN_PASSWORD"]}))' |
  curl --disable --silent --show-error --cookie-jar "$PM_COOKIE_JAR" \
    -H 'Content-Type: application/json' --data-binary @- \
    https://pengmanager.com/api/auth/login
unset PM_ADMIN_PASSWORD

pm_admin() {
  curl --disable --silent --show-error --cookie "$PM_COOKIE_JAR" "$@"
}
pm_admin https://pengmanager.com/api/auth/status
```

核对 `authenticated: true` 后再继续。Cookie 是秘密；只保留到任务结束，不上传、不截图、不提交。结束时先撤销会话，再清理本次专用文件：

```bash
pm_admin -X POST https://pengmanager.com/api/auth/logout \
  -H 'Content-Type: application/json' --data '{}'
rm -- "$PM_COOKIE_JAR"
rmdir -- "$PM_AUTH_DIR"
unset PM_COOKIE_JAR PM_AUTH_DIR
```

此处只删除刚才创建的专用 Cookie 文件和空目录；不要把变量改成其他路径。退出一个会话不撤销其他会话或 Agent 令牌；令牌泄漏需管理员轮换其配置哈希。

## 5. GEO 内容生产：事实、草稿与最终审批

### 5.1 先找证据和真实目标账号

管理员读取 `GET /api/claims`、`GET /api/bootstrap`，核对 Claim 的来源、有效期、敏感度和真实文本；核对账号 `id`、`platform`、真实 `handle`、`profileUrl`、状态与规则审阅。平台名称与账号 ID 不同，例如内容的平台通常为 `GitHub`，账号 ID 通常为 `github`，以返回数据为准。

账号设置示例只改内部资料，不会修改平台主页或替你登录。新应用必须先 GET 取得 ETag，并保留本次请求的幂等键：

```bash
PM_ACCOUNT_ETAG=$(pm_admin "$PM_ORIGIN/api/accounts/github" | python3 -c 'import json,sys; print(json.load(sys.stdin)["etag"])')
pm_admin -X PATCH "$PM_ORIGIN/api/accounts/github" \
  -H 'Content-Type: application/json' \
  -H "If-Match: $PM_ACCOUNT_ETAG" -H 'Idempotency-Key: actual-review-attempt-0001' \
  --data '{"handle":"geniusdapeng-collab","profileUrl":"https://github.com/geniusdapeng-collab","status":"active","identityConfirmed":true,"policyStatus":"reviewed","policyCheckedAt":"2026-10-25T00:00:00+08:00","reviewNote":"填写本次实际身份与规则核对依据"}'
```

只有实际核对过这个账号和规则后才使用该请求，日期改为真实审阅时间。已有 Claim 可通过管理员 `POST /api/claims/:id/approve` 审批，body 为 `{"approvedBy":"真实审核人","publicLevel":"private"}` 或 `approved_public`。**目前没有通用 HTTP 新增／修改 Claim 的端点**；缺证据时先走受控事实维护流程，不得编 Claim、修改历史事件或为过闸门随意使用 `opinion`。

新内容优先使用“编辑出版”的选题、不可变原文修订和独立渠道稿，完整新接口见[双语内容站与平台编辑流程](CONTENT-PUBLISHING.md)。这些管理员接口统一要求幂等键；修改／引用已有父版本还要求精确 `If-Match`。v2 批准必须 `reviewed:true` 并提供完整 `snapshotHash`，不能套用下节旧 v1 文本审批示例。官网稿走独立的公开快照批准、真实全媒体备份、激活与服务端真实回读；`live_unverified` 不能称发布验收完成。媒体上传／审核与素材可匿名读取也是不同状态，审核通过本身不会公开媒体。

目录中的个人官网与 27 个外部平台表示可登记的阵地范围，账号已登记、平台已登录、官方接口可用、正文已获批准与发布已回读须分别核对。受限 HTTP Agent 仍不能创建或审批这些新对象。每个外部渠道稿绑定具体目的地与原账号快照，不能为了给另一账号发同主题而复用旧稿。

批准为 `approved_public` 也不保证一定导出：公开预览还检查来源 `visibility: "public"`、安全公开 URL、低敏感度及有效期。不公开的已批准 Claim 可以用于获准的私有准备流程；是否对外使用其事实仍须本人审核。

**创作前的操作者义务：** 无论采用下节哪条既有草稿路线，都先核对具体目的地规则、允许的 AI 参与范围及真实作者材料。服务接口有权限，不代表目标平台允许 AI 起草整稿；人工最终批准不豁免被规则禁止的创作方式。第 13 节与三组研究列出公众号作者主导、DEV／Kaggle 评论、脉脉和 Medium 等边界。新的内容运营计划会取岗位、目的地规则与授权的共同范围，缺规则／作者贡献时阻断；旧草稿入口不会因此自动取得这些新门禁或平台权限，实际规则核对责任仍在操作者。

### 5.2 两条草稿来源

**Agent 已在当前任务中写好正文：** 管理员以 `POST /api/content` 录入，body 至少为 `title`、`body`、`claimIds`、`platforms`。非观点内容至少绑定一条存在的 Claim，正文不能含个人敏感信息或凭据。先把下面 JSON 中的 Claim ID 和正文替换为实际已核对资料，保存到受保护文件，再请求：

```json
{
  "title": "实际审核主题",
  "body": "完整草稿正文，不是摘要或待补充占位。",
  "contentType": "article",
  "claimIds": ["C002"],
  "platforms": ["GitHub"],
  "owner": "PengManager"
}
```

```bash
pm_admin https://pengmanager.com/api/content \
  -H 'Content-Type: application/json' --data-binary @"$PM_CONTENT_JSON"
```

`PM_CONTENT_JSON` 是实际文件的绝对路径。成功返回新内容 ID，后续使用这个 ID，不猜测 `CNT-001`。此请求不具备通用幂等键，超时后先 GET `/api/content` 对照标题、正文、时间，避免重复创建。

**要求服务调用模型写稿：** 管理员使用 `POST /api/live/generate-content`，例如 `{"confirm":true,"brief":"实际需求与边界","claimIds":["C002"],"platform":"GitHub","contentType":"social_post"}`。仅使用已批准 Claim；调用依赖服务当前有效的模型配置，可能花费模型额度。响应包含 `content` 草稿和 `model` 回执，仍需审核。受限 Agent bearer 不能调用这个入口。

另一条 `POST /api/geo/engine/articles/generate` 是 GEO 引擎的文章草案生成，需 `confirm:true`，支持 `topicIds`、`force`，默认 `dataMode:"draft"`。它按内置选题构建 SQLite 文章草案，**不是调用模型的同义接口，也不自动成为控制面的已审批内容**。读取 `/api/geo/engine/articles` 后审查完整 Markdown，结合真实 Claim 另建控制面内容；`force:true` 会允许同选题再生成，不能当幂等重试。

### 5.3 审核、定稿和排期

控制面内容状态依次为：

```text
draft → fact_check → approved → scheduled → published → archived
```

`approved` 是正文通过最终事实／安全审核的定稿点，`scheduled` 是待发布。审核不是模型自己给自己盖章；操作者必须确有本人授予的审核权限，填写真实审批人。以下命令在已经获准并核对全文后逐条执行，每一步检查返回状态：

```bash
# PM_CONTENT_ID 来自实际创建响应；下面展示本人实际审核的请求。
pm_admin -X POST "$PM_ORIGIN/api/content/$PM_CONTENT_ID/transition" \
  -H 'Content-Type: application/json' \
  --data '{"target":"fact_check","actor":"PengManager","note":"已提交事实核验"}'
pm_admin -X POST "$PM_ORIGIN/api/content/$PM_CONTENT_ID/transition" \
  -H 'Content-Type: application/json' \
  --data '{"target":"approved","actor":"PengManager","approvedBy":"PengManager","note":"本人已核对完整正文与事实"}'
pm_admin -X POST "$PM_ORIGIN/api/content/$PM_CONTENT_ID/transition" \
  -H 'Content-Type: application/json' --data '{"target":"scheduled","actor":"PengManager"}'
```

这些请求示范本人审核；不是本人时按真实授权填写 `actor`／`approvedBy`，不能冒名。当前 Claim 与内容接口保留这些审核字段，并不会把填写人自动变成已核实的人类审核。受限 bearer 不能调用它们。不存在 `FINAL` 状态，也不能直接 transition 到 `published`；必须有真实发布回执。草稿被阻断时查看 `details.findings`，补齐证据和正文后按允许的 `blocked → draft` 流程重做，不删除历史。

当前 HTTP API 没有通用正文 PATCH 接口。需要改文时建立新的完整草稿并重新审核；不要直接改 `state.json`。同一内容对象只对应一次平台发布；跨平台／跨账号分发须分别创建并审批内容对象，不能复用一个对象登记多个平台。

## 6. 出站发布与回复：精确授权后再执行

### 6.1 管理员创建并批准一个动作

发布草稿请求为管理员 `POST /api/operations`：

```json
{
  "accountId": "github",
  "type": "publish",
  "contentId": "从实际响应取得的内容ID",
  "executionMode": "browser"
}
```

正文和账号在创建时保存快照及哈希。批准需要内容已 `scheduled`、账号 `active`、规则 `reviewed`、平台匹配、Claim 仍有效。管理员再 POST `/api/operations/:id/approve`，body 为 `{"authorizationNote":"本人批准此账号发布该完整正文一次，按实际结果回读"}`。仅创建内容或动作不构成发布授权。

把实际动作 JSON 保存在 `PM_OPERATION_JSON` 指向的受保护文件后：

```bash
pm_admin -X POST "$PM_ORIGIN/api/operations" \
  -H 'Content-Type: application/json' --data-binary @"$PM_OPERATION_JSON"
# 读上一步返回的真实 ID 设置 PM_OPERATION_ID，再按本人实际授权批准。
pm_admin -X POST "$PM_ORIGIN/api/operations/$PM_OPERATION_ID/approve" \
  -H 'Content-Type: application/json' \
  --data '{"authorizationNote":"本人批准此账号发布该完整正文一次，按实际结果回读"}'
```

回复动作同样由管理员创建，字段为 `accountId`、`type:"reply"`、`executionMode`、真实公开 `targetUrl` 和完整 `replyText`；有原互动时附实际 `interactionId`。高风险 L0（招聘、客户、法律、财务、隐私、负面等）只可本人 `manual` 处理；L3 垃圾诱导不回复；L1 需确认正文，L2 也只能走已批准渠道。不能删除原问题的风险内容以降低分类。

```json
{
  "accountId": "实际账号ID",
  "type": "reply",
  "executionMode": "browser",
  "targetUrl": "实际要回复的公开HTTPS帖子或评论地址",
  "replyText": "本次获准发送的完整回复原文",
  "interactionId": "实际已存互动ID，没有时省略此字段"
}
```

### 6.2 Agent 领取并开始

```bash
pm_agent "$PM_ORIGIN/api/operations"
# PM_OPERATION_ID 是管理员交付的实际 approved/browser 动作 ID。
pm_agent -X POST "$PM_ORIGIN/api/operations/$PM_OPERATION_ID/start" \
  -H 'Content-Type: application/json' --data '{}'
```

执行前逐项比对 `accountSnapshot`、`contentSnapshot` 或完整 `replyText`、`contentHash`、批准说明和当前平台账号。不得把账号矩阵里一个类似的 handle 当同一登录账号。当前账号／主页或正文变化会使旧授权失效，返回 `ACCOUNT_IDENTITY_CHANGED`／`OPERATION_CONTENT_CHANGED`，应重新创建并批准动作。

成功 `start` 后，才在获准的本机浏览器中执行一次。检查当前账号与目标页面，粘贴获准的完整正文，核对附件与可见范围，再点击实际发送／发布。平台未确认时不要重复点击；先查页面及平台草稿／历史结果。遇到验证码、陌生账号、登录失效、额外付费或未授权的新协议时，保留动作状态及非敏感说明，等待必需的本人操作。

### 6.3 实际回读与完成

发布或回复后打开平台结果，确认账号、正文、目标、公开可见结果与实际时间。将真实回执保存到受保护 JSON 文件；下面是**字段模板，必须替换所有说明值，不代表已经发布**：

```json
{
  "receipt": {
    "url": "实际结果的公开HTTPS地址",
    "publishedAt": "实际发布时间的ISO8601值",
    "capturedBy": "实际采集者",
    "dataMode": "real",
    "verificationMethod": "browser_readback",
    "verifiedAt": "实际回读时间的ISO8601值",
    "verifiedBy": "实际回读核验者"
  }
}
```

```bash
pm_agent -X POST "$PM_ORIGIN/api/operations/$PM_OPERATION_ID/complete" \
  -H 'Content-Type: application/json' --data-binary @"$PM_RECEIPT_JSON"
pm_agent "$PM_ORIGIN/api/operations"
pm_agent "$PM_ORIGIN/api/events?limit=20"
```

`PM_RECEIPT_JSON` 是实际完整回执文件绝对路径。完成需要 `in_progress`；所有示例回执字段必填。`dataMode` 仅 `real`／`imported`，核验方式仅 `browser_readback`／`manual_readback`；发布时间和回读时间有效、最多允许当前时间后一分，且回读不早于发布。可选 `contentHash` 必须与授权一致。公开 HTTPS URL 不接受本机、数字 IP、示例域名、用户密码、非标准端口或凭据型 query／fragment，普通评论锚点可用。

Agent 回写时，服务会把 `capturedBy`、`verifiedBy` 设为 Agent 身份，核验方式固定为 `browser_readback`，防止冒充本人；**这不代表服务器替你打开过平台页面**。服务器只校验结构和一致性，实际回读责任仍在执行者。发布完成还更新内容发布账本；回复只保存自己的回复回执，不伪造内容发布记录。

### 6.4 失败、网络超时与幂等

| 情况 | 应怎么处理 |
| --- | --- |
| 尚未发到平台，确定失败 | POST `/api/operations/:id/fail`，body `{"reason":"真实失败原因，不含凭据"}`；保留记录，需重做时建立新动作 |
| 平台已成功，后台回写超时／失败 | 保留原结果和**原始回执文件**，GET 动作状态，再重试同一 `complete`；绝不重新发布 |
| 同一已完成动作＋相同规范化回执 | 返回原完成记录，不追加发布／完成事件；时间和核验字段也必须沿用原值 |
| 已完成动作收到不同回执 | `409 RECEIPT_CONFLICT`，不能覆盖；先人工核对真实结果 |
| 同一账号的结果 URL 已被另一动作占用 | `409 DUPLICATE_PLATFORM_RECEIPT`，找到原动作，不编新 URL |
| 发布账本已成功、动作第二次写入失败 | 重试原回执恢复动作；`PUBLICATION_ALREADY_RECORDED` 表示不能再标失败 |
| `start`、`approve`、创建草稿超时 | 它们没有同一套重试保证；先 GET 当前状态再决定下一步 |

管理员另有窄范围 `POST /api/operations/:id/reconcile`，用于已有原授权和实际执行、但旧身份／正文等变化使通常 `complete` 无法准确恢复的既有结果。它要求原批准快照哈希、明确账号与内容核对、原始真实回执、原因及新的 ETag／幂等合同，不会重新发送平台请求，也不会把当前已修改的正文误标为当时发布。普通 Agent 不可调用；不能编造原审批、原结果或发生时间来“清掉”执行中动作。

不要添加未经实现支持的 `Idempotency-Key` 来假装所有接口幂等。旧动作完成的幂等依赖同一动作 ID 和规范化回执哈希；本机视频原生执行工具的 `idempotencyKey` 是另一套合同。“编辑出版”、新账号／目的地、媒体与上述 reconcile 已实现明确的 `Idempotency-Key` 和 ETag 合同，按其文档执行，不能互相推断。

## 7. 已在平台发布的内容如何导入

有两种不同入口，先判断是否已经存在获准动作。

1. **已有相应的获准动作：** 保留该动作，以实际结果完成它；对真实既有结果可使用 `dataMode:"imported"`，仍须先核对账号、正文、状态、授权和实际回读，不回填虚假发生时间。
2. **没有原动作，需要管理员登记既有真实发布：** 仅旧 v1 内容可使用下面的手工入口；v2 渠道稿必须走独立已批准的运营动作。使用管理员专用 `POST /api/publications/manual`，body 至少含真实 `contentId`、`accountId`、`receipt.url`、`receipt.publishedAt`、`receipt.capturedBy`、`receipt.dataMode:"imported"`。该内容仍需 `scheduled`，账号／平台／Claim 闸门仍生效。此旧接口兼容公开 HTTP/HTTPS，不要求新动作的全部核验字段，也不具备动作完成的重复回执恢复合同；先检查现有 publications，避免重复录入。

受限 Agent 不能使用手工发布入口。不能先导入一条手工回执，再试图用内容已变 `published` 的状态跳过新动作批准。`imported` 是来源说明，不是放松真实性要求。`fixture`、`draft`、本地 Markdown、截图路径、上传成功或任意 HTTP 200 都不是外部平台的发布证据。

GitHub 官方直接发布仅用于旧 v1 内容；v2 渠道稿在任何外发前即拒绝，须走独立已批准的单账号动作。旧入口是另一条管理员入口 `/api/live/github/publish`，需 `confirm:true`、已批准并 `scheduled` 的内容、GitHub 目标账号、服务进程中有效的 GitHub 凭据及本次真实外发授权。它会实际创建 Issue，并可能创建指定 label。不要在仅核对指南、健康检查或演示时调用。超时可能已创建 Issue，必须先查真实仓库和现有账本，不能盲重试。

## 8. GEO 采集、导入与指标

管理员可用这些入口，受限 HTTP Agent bearer 无权调用专用 GEO 路由：

| 目的 | 路径与关键参数 | 结果边界 |
| --- | --- | --- |
| 管理问题 | GET／POST `/api/geo/queries`；新增至少 `text`，可含 `locale`、`intent`、`priority`、`surfaces` | 新增控制面问题也同步到内置引擎查询集合；保留返回的真实 ID |
| 登记平台真实回答 | POST `/api/geo/observations`：`queryId`、`surface`、完整 `answer`、`citations`、`dataMode`、实际 `collectedAt` | `imported` 需真实原回答与引用；没有证据不填 `real`，不发明引用 |
| 看控制面指标 | GET `/api/geo/metrics` | 只计控制面 `real`／`imported` observations；无合格样本时指标为 `null`，不是 0% |
| 实际 DeepSeek 采集并入账 | POST `/api/live/deepseek/collect`：`confirm:true`、实际 `queryIds`、小范围 `limit` | 依赖当前模型／搜索供应商凭据，返回每题成功／失败、证据与运行 ID；可能消耗额度 |
| 运行内置 GEO 引擎 | POST `/api/live/geoevidence/run`：`confirm:true`、provider 和查询范围 | 查看实际 `dataMode`、成功／失败；fixture provider 仍是模拟样本 |
| 查引擎证据与风险 | GET `/api/geo/engine/summary`、`queries`、`samples`、`incidents`、`articles` | 样本／指标来自 SQLite 引擎；与控制面 JSON observation 不是同一个集合 |

`deepseek/collect` 把成功引擎样本同步成控制面 observation；直接 `geoevidence/run` 与手工 `POST /api/geo/observations` 的入账范围不同，所以两组指标不一定相同。比较时固定问题集合、provider、时间范围与数据模式，保存真实原回答、引用和证据哈希。用户未授权付费采集时，只读取已有数据并报告缺项，不能自行把全部问题重跑。

新增人工观察请求示例的字段形状：

```json
{
  "queryId": "实际已有查询ID",
  "surface": "实际AI平台与模型",
  "answer": "从该平台取得的完整回答原文",
  "citations": [{"url":"实际回答引用的公开URL"}],
  "dataMode": "imported",
  "collectedAt": "真实采集时间的ISO8601值",
  "actor": "真实采集者"
}
```

这是待填写的字段模板；不能原样作为真实样本写入。无引用时用空数组，指标会如实反映，不补造出处。引用、回答和供应商错误可能含私有信息，公开报告只放经人工脱敏的必要摘要。

## 9. 本机完整视频 CLI／MCP

在具备依赖的本机 checkout 中先发现能力，不要从云端是否 200 推断本机工位可用：

```bash
node scripts/agent.mjs status
node scripts/agent.mjs capabilities
node scripts/agent.mjs list
node scripts/agent.mjs describe growth.video.production.shots
node scripts/agent.mjs describe growth.video.manual_bridge.eligibility
node scripts/agent.mjs describe growth.video.manual_bridge.record
node scripts/agent.mjs invoke growth.video.manual_bridge.list --input-file <项目输入JSON>
node scripts/agent.mjs invoke core.workspace.profile
node scripts/agent-mcp.mjs
```

`list` 是已登记可调用入口；完整员工／技能／工具目录比该列表广。先 `describe` 查看当前 `inputSchema`、风险、数据模式和启用状态，再 `invoke <实际ID> --input-file <绝对JSON路径>`；`--input-file -` 支持标准输入。`execute` 类工具要求至少 8 字符的 `idempotencyKey`，同一个业务尝试沿用原值；不要给不同任务复用同一值。

其他支持 stdio MCP 的平台，把本机 `node` 与仓库绝对路径 `scripts/agent-mcp.mjs` 注册为服务器进程，工作环境指向同一受保护数据目录。具体配置界面取决于宿主平台；不要注册为公网 HTTP 服务，不把 token 写入项目设置。可用工具名由该进程的 `tools/list` 返回，不猜名称或任意 tRPC 路径。

CLI/MCP 在首次需要原生后端时管理自己的运行时，退出时停止自己启动的服务；同一私有目录只运行一个监督进程。已拥有本机原生 `WORKLOOM_ACCESS_TOKEN` 且后端端口相同时可附着现有会话；它不是 `ADMIN_AGENT_TOKEN_HASH` 对应的云端令牌。模型密钥仅在当前进程环境生效；原生围栏、预算、资格和审批照常执行。目录中 `declared`、`codePresent`、依赖 `ready`、`productionVerified` 含义不同；不能把目录存在、数据库健康或工具返回 envelope 当作视频产物验收。

本机 owner 集成需要明确选用既有合成角色时，可用程序构造参数 `createVideoRuntime({ dataDir, portraitReuseManifestPath })` 选择复用 manifest；默认关闭，HTTP／metadata、继承的 `HR_PORTRAIT_REUSE_MANIFEST` 及媒体工具环境不能代替这个选择。manifest 必须是 `dataDir` 内既有的规范绝对路径、无软链普通文件，大小为 1–8,000,000 字节；在本 Mac 上，私有根、途中目录与文件都须由当前用户所有且无组／其他用户权限。构造时记录完整字节 hash，每次构建原生环境时重核，改变或失效即报 `PORTRAIT_REUSE_MANIFEST_CHANGED`／`PORTRAIT_REUSE_MANIFEST_INVALID`。后端只收到通过检查的路径；Studio 在任务首次读取时另验 schema、合成身份、明确版本与源字节，并用该次 manifest hash 绑定后续验收。同 UID owner 在后端启动后改文件仍可能影响下一任务选择，因此本参数不承诺整个运行期文件不可变，也不代替原生模型配置、审批、预算或产物验收。

安装／模型／素材许可／工位缺项时依 [VIDEO-RUNTIME.md](VIDEO-RUNTIME.md) 和实际诊断处理，不下载到其他项目、不共用外部数据库、不杀别人的进程。小型云端禁用媒体渲染时返回 `503 MEDIA_RENDER_DISABLED`，应转到本机执行，云端只留实际运营回执，不为了过检查打开重型任务。

### 9.1 连续失败的人工搭桥兜底

通用视频或营销视频的同一 `projectId + stageId + subtaskKey` 至少失败 3 次（首次失败后再完成 2 次重试）且没有未知付费结果时，Codex 可以按该环节当前正式 schema、事实边界和下游接口人工补齐一份准入接缝产物。未达到门槛、外部结果未知、审批/权利未决或根因未定位时不得使用。

人工搭桥不代表模型调用、供应商任务或外部发布成功；不得用占位文、静帧或手写回执冒充真实媒体/平台结果，也不得跳过门禁、事实核对、预算或审批。每份搭桥必须写入项目归档的 `manual-bridges/` 独立路径，记录失败 attempt、输入、schema、输出、SHA-256、校验器与交叉字段结果、事实是否失实、未解决项、外部副作用和下游交接回执，并使用 [视频人工搭桥清单](video-manual-bridge.schema.json) 与 `scripts/validate-video-manual-bridge.mjs` 核验。

运行时先调用 `video.studio.manualBridgeEligibility({projectId,stageId,failureCode})`；服务端从当前制片档案的 `stage.failed` 事件独立统计同一细分环节，少于 3 次直接拒绝。产物和证据准备完成后调用 `video.studio.recordManualBridge`，服务端再核验文件字节、schema/交叉字段校验日志、下游接受回执、零付费/外发/不可逆副作用及每个细分环节最多一份搭桥。`video.studio.manualBridges` 与 `video.studio.archive` 返回的 `manualBridges` 是最终交付说明的权威数据源。

对应 Agent 能力为 `growth.video.manual_bridge.eligibility`（只读）、`growth.video.manual_bridge.record`（执行，必须携带至少 8 字符 `idempotencyKey`）和 `growth.video.manual_bridge.list`（只读）。Codex 应先 `describe` 当前 schema，不得凭记忆拼字段。

最终交付说明必须逐项披露每个使用人工搭桥的环节、失败次数、产物 hash、规范校验、数据真实性、未解决事实和剩余风险；未使用也必须明确写“未使用”。完整规则见 [AI 视频细分环节人工搭桥兜底](VIDEO-MANUAL-BRIDGE-FALLBACK.md)。

## 10. 定稿自动备份到这台 Mac

定稿条件是控制面内容状态进入 `approved`；也会补齐 `scheduled`、`published`。草稿、事实核验中、阻断和归档状态不作为新定稿备份。正文保持原样，不做脱敏替换或压缩摘要；不要在批准内容中混入登录信息。备份内容固定为：

```text
下载 / pengmanager 备份 /
  <内容ID>--<ID、标题、正文的SHA256> /
    final.md       原始完整正文，不额外添加标题、前缀或结尾
    metadata.json  定稿元数据白名单
```

标题保存在 `metadata.json`。白名单仅含 `schemaVersion`、`contentId`、`title`、`version`、`status`、`contentHash`、`bodySha256`、`backedUpAt`，不会复制账号、Cookie、令牌、Claim 来源备注或整个 bootstrap。这里 `contentHash` 是 ID、标题、正文组成的 JSON 数组哈希，和出站动作的标题换行加正文哈希用途不同，不能混用。

同一 ID、标题和正文只保存一个目录；`approved → scheduled → published` 不重复保存同一正文，已有元数据保留首次备份时的版本、状态与时间。正文或标题变化才形成新目录。每次复查已有版本会核对实际正文与摘要，不打开旧文件覆盖。冲突文件保留并报错；网页遇到不完整目录也会停止，本机写入器可补齐与原文一致的中断文件对，均不会覆盖不同正文。不能把不完整或冲突目录称为成功备份，也不要直接删除它来消除错误。

### 10.1 云端内容自动落到本机：管理页面方式

1. 在**这台 Mac 的 Chrome** 打开 <https://pengmanager.com/admin>，用本人已有会话登录。网站必须已经部署包含“终稿自动备份”面板的版本。
2. 在 Mac 的“下载”中找到 **`pengmanager 备份`** 文件夹；有本机仓库时，优先按下一节 `--prepare` 创建为本人私有目录。点击面板的“启用本机终稿备份”，在系统文件夹选择器中选中这个文件夹并允许写入。
3. 等面板显示已核对终稿数／本次新增数／最近检查时间；再在 Finder 打开该目录，核对实际文件。没有终稿时会如实显示空状态。
4. 保持页面打开、登录有效、网络可用及文件夹权限有效。页面每 30 秒读取既有 `/api/content`；本页内容审批／动作刷新后也会立即检查。此方式使用已有网站会话，**不需要创建新 Agent 令牌**。
5. 浏览器记住目录句柄；下次打开页面且权限仍有效时自动补齐当前已定稿内容。权限失效时点击按钮重新选择授权；取消选择、拒绝权限、不支持的浏览器、网络或磁盘问题都会显示未完成状态。

选择器以下载目录为起点，并要求文件夹名为 `pengmanager 备份`，但浏览器不向网页提供可验证的完整绝对路径。因此**同名文件夹不证明位于“下载”**，本人须在选择器中实际核对位置。网页不能无授权读写 Mac 任意路径，也不会通过 Linux 云主机的 `~/Downloads` 冒充这台 Mac。

关闭／离开页面、退出登录、断网或机器休眠后不保证持续检查；没有常驻后台下载守护进程。再次打开并恢复授权后会补齐仍处于定稿状态的内容。页内状态和真实 Finder 文件回读才是本机落盘依据；云端 `approved`、网页 200 或“已记住目录”都不等于文件已经写成。

### 10.2 本机服务与 CLI：无需浏览器令牌的本地流程

在这台 Mac 运行**本仓库根服务**时，启动会补查已有定稿；内容成功转入 `approved`／`scheduled`、发布回执入账后，也会尝试备份。备份失败不会撤销已经成功的内容状态或外部发布。内容 transition 响应、直接发布入账返回对象的 `finalBackup` 给出单独结果；完整动作 `complete` 返回动作对象，另看 bootstrap 的写入器状态和实际文件。看到 `ready` 只表示目录就绪；单条 `saved`／`already_saved` 并核对实际文件，才证明那条正文已保存。

本机 AI 进程也可执行一次性 CLI，不必把管理员密码或社媒登录态交给它：

```bash
# 在本机仓库执行；先建立/核对本机 Downloads/pengmanager 备份。
node scripts/backup-final-content.mjs --prepare

# 默认只读本仓库 var/state.json；不修改状态文件或调用外部平台。
node scripts/backup-final-content.mjs

# 自定义 DATA_FILE 时，用实际状态文件绝对路径。
node scripts/backup-final-content.mjs --state-file /absolute/private/state.json

# 也可读取本人已授权导出的内容数组、{ "content": [...] } 或单条内容对象。
node scripts/backup-final-content.mjs --input-file /absolute/private/content.json
```

输入可包含整个只读状态，但 CLI 只向写入器传 `id`、`title`、`body`、`version`、`status`，不复制其他字段。`--prepare` 只建／检查目录，**不会备份正文**。CLI 是一次性运行，不是 watcher，也不会自行从云端登录、申请令牌或下载数据；云端自动同步优先使用上一节已登录页面方式。仅有本机旧状态文件时，不能称当前云端定稿已同步。

写入目录按 `os.homedir()/Downloads/pengmanager 备份` 定位，要求 macOS、普通无软链路径、当前用户所有且备份根目录 0700；本机新建内容子目录为 0700，正文／元数据新文件为 0600。受私有根目录保护、同用户的浏览器既有版本会保留并核验，不为了统一权限重写它。备份根目录权限不符会返回 `FINAL_BACKUP_PRIVATE_DIRECTORY_REQUIRED`，不会擅自更改。本人核对实际目录确属此用途后才能修正该目录权限，再重试；不删除旧备份。Linux 返回 `pending_local_sync`，不在服务器创建假的 Mac 下载目录。这个云端进程状态与浏览器实际落盘是两套状态：在 Mac 页面中备份成功，不会把 Linux 进程变成 macOS。

CLI 输出状态和非正文元数据，逐项检查 `saved`、`already_saved`、`skipped_not_final`、`pending_local_sync` 或 `error`。退出码 0 表示目录就绪且所有本轮内容已保存／已存在／无需备份，1 表示参数、输入或读取失败，2 表示本轮存在未同步／备份错误；`--prepare` 的 0 只表示目录就绪。参数／输入错误与磁盘／权限／冲突均应保留失败信息；**不能因内容审批成功就忽略备份失败**。修复后重新运行 CLI 或在下次本机根服务启动时补查；不要重复执行已经成功的审批／发布来“触发”备份。

### 10.3 备份的范围

这是**定稿正文副本**，便于本人取用和保留版本；不是整个 JSON/GEO 数据库、账号动作／审批账本、视频 PostgreSQL、平台登录态或服务器配置备份。不能用这两个文件还原整个服务。完整服务仍按 [运维说明](OPERATIONS.md) 与 [部署备份恢复](ALIYUN-DEPLOYMENT.md#更新备份与恢复) 执行受控停服、完整归档及隔离恢复验证。

## 11. 常见错误与停止条件

| HTTP／代码 | 含义与处理 |
| --- | --- |
| `400 INVALID_JSON`／`INVALID_INPUT` | 请求体必须是 JSON 对象，不能是 null／数组，最大 1 MB；检查实际字段 |
| `413 BODY_TOO_LARGE` | 请求体超限；缩减真实请求，不通过分拆凭据或绕过代理来继续 |
| `400 CREDENTIALS_NOT_ALLOWED`／`INVALID_PUBLIC_URL` | 去掉凭据与不安全 URL，不改编码绕过检查 |
| `401 AUTH_REQUIRED` | 未登录／会话过期／令牌无效；经安全渠道检查授权，不打印秘密 |
| `403 AGENT_SCOPE_DENIED`／`AGENT_OPERATION_SCOPE_DENIED` | 路由不属于 Agent，或动作不是允许接手的已批准普通浏览器任务；交还管理员准备，不提升自己权限 |
| Host／Origin 检查 `403` | 使用目标 HTTPS origin；不要伪造 forwarded headers、关闭来源检查或在异站网页中硬调私有 API |
| `404` | 检查 ID、路径和目标实际部署版本；不要猜新 ID／制造本地替代成功 |
| `409 CONTENT_APPROVAL_BLOCKED`／`PUBLICATION_BLOCKED` | 读 `details.findings`，处理每个事实、状态、账号和敏感信息闸门 |
| `409 INVALID_OPERATION_TRANSITION` | 先读当前状态；不能把重复 `start` 当幂等成功 |
| `409 ACCOUNT_IDENTITY_CHANGED`／`OPERATION_CONTENT_CHANGED` | 原授权不再适用，重新建立并审批 |
| `409 RECEIPT_CONFLICT`／`DUPLICATE_PLATFORM_RECEIPT` | 对照原结果与原动作，禁止覆盖或换 URL 凑成功 |
| `429 LOGIN_RATE_LIMITED` | 登录尝试受限，按返回信息等待并核对凭据；不要换身份绕过 |
| `503` 适配器／GEO／媒体／视频未就绪 | 报实际缺项；200 且 `ready:false` 同样不是可执行证明 |
| `500`／网络中断 | 保留非敏感请求目的、时间、状态；涉及外发先查实际平台是否已接受，再决定恢复 |

API 错误统一读取 `error.code`、`message`、可能存在的 `details.findings`。不把未知错误当成功，不用空 catch 吞掉，不将含令牌、Cookie、客户内容或供应商私密信息的原始错误粘到报告。

## 12. 完成任务前必须交代什么

每次向本人交付都说明：目标服务／源码版本、实际完成到哪个状态、哪些动作真正发到外部平台、每个平台结果及实际回读、失败或未执行项、使用了哪种数据模式、是否有付费调用、备份具体覆盖什么。没有外部发布就明确写“未发布”；只有草稿就交付草稿，不能称运营完成。

- 内容：全文、真实 Claim、审核与定稿／排期状态，不只给摘要。
- 平台动作：账号快照、完整授权正文、动作 ID、状态、实际结果 URL、发布及回读时间，不含登录态。
- GEO：真实／导入样本与原引用；模拟样本单列；分母为空不写 0%。
- 视频：原生任务／审批／预算／产物与当前字节证据；缺依赖或模型未调通写明。
- 恢复：明确是定稿副本还是完整服务备份；未实际恢复验证的不称“可恢复已验收”。

## 13. 内容岗位与二次生产

本仓已实现 28 个岗位、严格 AdaptationPlan 导入与编译、真实源文件、独立本机工位、任务租约、逐请求预算、有限返修、原生包 v3、独立终检及人审衔接。**准备成功、独立终检、内容批准、单次外发授权与真实平台回读是分别完成的状态。** 旧受限 bearer 权限不变；新工位使用独立凭据和双端范围。当前源码、运行进程与生产部署仍须分别核对。完整可操作流程见[内容运营说明](CONTENT-OPS.md)。

先阅读[岗位产品方案](CONTENT-OPERATORS-DESIGN.md)、[二次生产集成方案](PLATFORM-SECONDARY-PRODUCTION.md)，再按目标查看[A 组](platform-research/group-a.md)、[B 组](platform-research/group-b.md)、[C 组](platform-research/group-c.md)完整研究。研究均保留官方来源、取得日期、实际读取范围和样本缺口；内容语气与受众建议为设计，不能当平台推荐算法、账号权限或经营效果。原研究的 JSON／缓存取证标识未随正文入库，不能假装已从仓库读取这些证据文件。

### 13.1 实施前需要的输入与权限

准备任务需要准确 Story／母版 Edition ID 与 hash、已批准且可用于本次范围的 Claim 指纹、真实源媒体及权利／隐私资料、真实作者贡献、账号／目的地身份、目标语言与原生形式、岗位／规则／风格版本，以及明确工具范围和预算。管理员可先上传真实源文件，无需先建工单；源文件与工位产物有不同来源标记。缺真实视频、模型、数据、notebook 或作者材料时，保留具体 needs_input／skip／blocked，不用说明文字补成“已制作”。

平台规则先于生成：公众号保留真实作者主导；Medium 区分作者贡献、AI 披露与分发资格；DEV／Kaggle 评论与讨论按其明确规则限制；脉脉不得由 AI 接管或模板批量运营。具体社区／频道另读当次规则与权限。人工最终审批不自动允许此前被规则禁止的 AI 起草方式。归档目的地不会因为研究齐全自动恢复。

云端管理员的准备授权与本机 owner 的执行授权必须同时满足。现有 HTTP Agent bearer 仍不能写编辑稿、审核媒体权利、批准内容或代替本机原生身份。worker 使用独立的最小 scope，云端不接收本机供应商密钥或社交平台登录态；worker 不接收管理员 Cookie。平台岗位只交策略数据，不传 shell、argv、任意路径或工具执行命令。工位诊断、配置及配对流程见[本机工位说明](CONTENT-OPS.md#本机工位与双端权限)。

### 13.2 每一步由谁交给谁

下表描述五类责任交接，名称帮助理解分工，不表示同名对象都作为独立 API schema 持久保存。实际管理员与 worker 路由、字段、幂等和异常路径以[当前使用说明](CONTENT-OPS.md)与[HTTP API](API.md#content-operators-and-private-worker)为准；设计文档保留原始论证。

| 交接 | 谁交给谁 | 必须交出的准确材料 | 后一步何时可以继续 |
| --- | --- | --- | --- |
| StrategyHandoff | 平台岗位 → 鹏经理导入／compiler | 冻结母版／研究／规则与目标 hash、适配理由、原生结构、真实输入和缺口；可有 skip | 服务端校验来源、创作／外发两个权限轴、预算与引用；计划只是数据 |
| ExecutionHandoff | compiler／scheduler → 本机 worker | 不可变 blueprint／task、attempt／epoch、解析后的输入 hash、固定 adapter 版本、本机与云端 scope、预算授权 | 固定适配器真正 ready，双端权限及原生围栏有效，逐底层请求已预留 |
| ArtifactHandoff | worker → 私有产物存储／编辑域 | 真实文件及 manifest／hash、执行回执、实际或未知用量、源文件保留依据 | 服务器重算字节并验证类型；管理员完成真实权利／隐私审核；失败、dryRun、unknown 单列 |
| ReviewHandoff | 平台编辑／独立 checker → 人工审核者 | 最终 candidate／packageHash、终检 checkedPackageHash／reportHash、覆盖与问题、reviewSnapshotHash | checker 重读润色后的同一完整包和真实附件，必需维度通过、无未解 blocker／major |
| PublishHandoff | 审核者 → 单次授权发布执行者 → 账本 | 准确账号／目的地、运营授权、完整包与报告绑定、实际 URL／平台对象及回读证据 | 内容审核和单次外发分别完成；实际结果与授权正文／文件一致后才入账 |

现有 `growth.video.production.plan` 是预览，`list`／`describe` 是发现；它们不等于真实制作。工具目录的 declared、codePresent、ready、productionVerified 分别展示。视频 CLI／MCP 按第 9 节使用；内容运营 compiler 只允许固定适配器任务，不自动执行 plan 返回的命令，也不为“补齐能力”逐个调用完整工具目录。固定视频工位剪辑已授权源片；AI 视频生成仍保留原生视频围栏和生产合同。

### 13.3 最终质量、预算与恢复的交付条件

最终流程为策划 → 深改与真实二次制作 → 独立核验 → 有限返修 → 最终润色 → 再次冻结 → 独立终检 → 人工完整审核 → 排期 → 单目标外发授权 → 真实回读。独立终检分别报告确定性合同、事实／语义、实际媒体覆盖、表达／艺术质量；技术质检或起草者自评分不能代替其他维度。标题、正文、页／帖子／图片顺序、视频、字幕、文件、原生设置或目标变化都会使旧报告过期；不允许只重算 hash 继续批准。

预算按实际底层请求逐次预留：策划、起草、翻译、检查、润色、最终检查、每次重试及 TTS 分段都计入。金额／币种／价格未知时可保存待配置草稿，不能启动付费步骤；actual 无法核实则为 null，unknown_usage 保留最坏预留。超时、取消、到期、归档或重启均不清零未知费用；新尝试仍需剩余额度。取消／到期后停止新的收费或有副作用调用，迟到结果只保留审计，不自动继续终检或外发。

本机 worker 的产物成功与平台发送成功分开；已成功的源片不为评分重复生成。不确定的平台结果先核对原对象与原回执，再走受控调和，不能重发整个任务。Discord 受限频道在专用对象／可见范围回执合同实现前，不冒充公开 URL 发布。新增原生附件、v3 工单、终检报告、未知预算、幂等与租约都须进入完整备份及隔离恢复，旧 v1／v2 历史 hash 不变。

交付须分别报告岗位 28／28、本次目标 N／N、实际产物 K／K、最终检查维度与覆盖、真实发布 M／M，以及预算已结算／预留／未知；skip 不计发布成功。隔离模型服务、测试账号和本机媒体测试不代表真实供应商或社媒发布。源码中的测试覆盖当前实现边界；生产部署和真实付费／外发仍以对应现场回执为准。

## 源码导航与证据边界

本指南中的实现行为来自精读下列入口与实现（A 级），不是对所有第三方依赖的全量语义审计。在线是否已部署相同行为仍需现场回执（B 级）；未运行的平台发布、付费模型和完整恢复不因读过代码变成已验证。

| 主题 | 实现 |
| --- | --- |
| HTTP 路由、确认参数、Agent 动作约束 | [src/http/server.mjs](../src/http/server.mjs) |
| 管理员会话、bearer 格式、路由白名单、哈希 CLI | [src/security/admin-auth.mjs](../src/security/admin-auth.mjs) |
| Claim、内容、手工发布、观察与指标 | [src/services/geo-os-service.mjs](../src/services/geo-os-service.mjs) |
| 账号快照、审批、执行、回执与重试 | [src/services/account-operations.mjs](../src/services/account-operations.mjs) |
| 模型草稿、DeepSeek 统一 Chat 调度与计量、GitHub 外发 | [src/services/live-pipeline.mjs](../src/services/live-pipeline.mjs)、[模型调度器](../src/model-routing/dispatcher.mjs)、[GitHub 适配器](../src/adapters/github.mjs) |
| 事实／敏感信息／发布闸门与状态 | [policy.mjs](../src/domain/policy.mjs)、[state-machine.mjs](../src/domain/state-machine.mjs)、[public-url.mjs](../src/domain/public-url.mjs) |
| JSON 单进程序列化与事件链 | [json-store.mjs](../src/storage/json-store.mjs) |
| GEO 引擎与文章草案 | [根引擎包装](../src/engines/geo-evidence.mjs)、[引擎 service](../engines/geo-evidence/lib/service.mjs) |
| 本机 CLI／MCP 与能力 schema | [src/agent.mjs](../src/agent.mjs)、[CLI](../scripts/agent.mjs)、[MCP](../scripts/agent-mcp.mjs)、[登记调用实现](../engines/video-edit/scripts/agent-capabilities.mjs) |
| 本机 owner 既有定妆照复用选择 | [构造与文件核验](../src/video-runtime/config.mjs)、[原生环境](../src/video-runtime/environment.mjs)、[Studio 既有验证器](../engines/video-edit/apps/server/src/video/portrait-reuse-acceptance.ts) |
| 网页本机定稿备份与精确正文格式 | [final-backup-browser.js](../public/final-backup-browser.js)、[final-backup-format.js](../public/final-backup-format.js)、[app.js](../public/app.js) |
| 本机定稿落盘、触发点与只读 CLI | [final-content-backup.mjs](../src/services/final-content-backup.mjs)、[application.mjs](../src/application.mjs)、[backup-final-content.mjs](../scripts/backup-final-content.mjs) |
| 内容岗位、严格计划、预算、租约、真实附件与最终检查 | [content-ops-service.mjs](../src/services/content-ops-service.mjs)、[content-ops-routes.mjs](../src/http/content-ops-routes.mjs)、[production-artifacts.mjs](../src/services/production-artifacts.mjs)、[领域模块](../src/domain/content-ops.mjs) |
| 固定本机工位与独立日志 | [worker](../src/content-ops-worker/worker.mjs)、[固定适配器](../src/content-ops-worker/adapters.mjs)、[CLI](../scripts/content-ops-worker.mjs) |

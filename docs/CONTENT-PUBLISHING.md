# 双语内容站与平台编辑流程

这份说明面向本人和获得授权的管理员。访客在 `/zh`、`/en` 阅读完整文章、图文和视频；管理员在 `/admin` 的“编辑出版”管理原文、各渠道稿、媒体、目的地与官网修订。平台目录表示可登记和适配的阵地，不表示这些平台已经登录、绑定官方 API 或授权自动发布。

## 使用场景与边界

1. 写好一份中文文章，为同一选题另建英文修订，两种语言分别审阅、更新并保留原文关系。没有译文时页面明确提示，不跳去另一主题冒充译文。
2. 将一个选题制作成图文或视频，逐项绑定真实图片、视频、封面与字幕。管理员可先在素材库播放实际上传的原文件，再审核权利与隐私。
3. 为一个具体平台、具体账号和具体目的地建立独立渠道稿，核对完整正文、结构、附件和目标，再按原有单账号授权流程执行一次发布并登记真实回执。

P0 是完整正文、不可变修订、独立渠道稿、精确审核、真实媒体、官网激活与真实回读、撤回和完整恢复。缺少这些环节会造成错稿、串号、误公开或丢失媒体。P1 是公开译文更新提示、账号与目的地历史、明确的历史结果核对和可扩展的平台目录，帮助持续维护内容。P2 才是平台官方适配器与后续编辑员工协作；当前没有通用 OAuth、全平台登录器或无人值守批量发布器。

公开站点使用服务端 HTML 与浏览器共用的纯渲染模块，正文、canonical 和可用的语言链接在初始响应中存在。与单独维护浏览器页面或只在客户端请求正文相比，这种实现便于直接阅读、索引和精确回读；代价是模板变更也必须一起验收。公开页面的 404 与 410 有真实 HTTP 状态。

## 对象、版本与存储

所有新业务对象仍存放在同一 `state.json`，由单一可写进程序列化，不新增业务 SQL 表。列表当前按 JSON 数组查询，适合单人运营和当前规模；它不是多进程写入或大规模检索数据库。

| 对象／集合 | 关键字段与用途 |
|---|---|
| `stories` | `id,workingTitle,claimIds,topicIds,status,revision`；组织同一主题 |
| `editions` | `storyId,familyId,locale,format,editorialRevision,sourceEditionId,supersedesEditionId,title,summary,body,blocks,claimIds,assetRefs,snapshotHash`；不可变原文修订 |
| `content` 中的 v2 渠道稿 | `snapshotSchema,storyId,editionId,editionHash,destinationId,destinationSnapshot,accountSnapshot,assetRefs,snapshotHash,status,approval`；按平台目的地独立审批 |
| `destinations` | `platformId,accountId,kind,locator,visibility,status,identityVersion,identityReview,policyStatus,revision`；区分主页、仓库、社区与频道 |
| `websiteReleases` | `contentId,canonicalPath,publicSnapshot,snapshotHash,status,publicApproval,activationBackup,receipt,previousReleaseId,withdrawal`；固定地址下的公开快照与历史 |
| `websiteRoutes` | `locale,format,slug,storyId,activeReleaseId,revision`；以当前正式地址的旧修订 ID 做比较并交换 |
| `mediaAssets` | 不透明 ID、MIME、字节数、SHA-256、格式元数据、暂存／审核／撤销状态和权利审核 |
| `editorialRequests`、`mediaAssetRequests` | 请求指纹和原结果；支持安全重试，不重复追加事件 |

`locale` 只接受 `zh-CN`、`en-US`；`format` 为 `article`、`image_text`、`video`。同一选题、语言和形式构成一个修订系列。改正文须创建新修订并明确替代的最新修订，不能在旧审批对象上覆盖正文。翻译绑定具体原文修订，不自动批准新译文。

`assetRefs` 的顺序就是审核快照的一部分，每项为 `{assetId,sha256,role,alt,caption,locale?}`。`role` 为 `cover`、`image`、`video`、`poster` 或 `subtitle`。`blocks` 接受 paragraph、heading、list、quote、code、image、video 结构，不接受任意 HTML、iframe、style 或执行型链接。图片／视频块必须引用实际声明的媒体。

## 新接口的写入合同

本节所有编辑、账号、目的地和媒体接口仅允许管理员。受限 HTTP Agent 的既有路由权限保持独立。

每次新写入必须发送 `Idempotency-Key`，使用 8–128 位英文字母、数字、下划线或连字符。同一业务尝试重试时保留相同键和完整请求。修改已有对象或基于已有父对象创建修订时，还须先 GET 并发送响应中的精确 `If-Match`，包括双引号。

- 缺少有效幂等键：400；缺少前置版本：428；版本已变化：412。
- 相同键和相同请求返回原结果，不因原操作已经改变 ETag 而重复写入。
- 同一键改了请求内容：409，须重新读取并核对，不能覆盖旧结果。
- 响应实体有 `etag`，同时在 HTTP `ETag` 返回；列表使用 `{items}`。
- 审核人和执行人由服务端登录身份取得，不从请求体冒名。

| 方法 | 路径 | 作用／请求 |
|---|---|---|
| GET | `/api/editorial/bootstrap` | 目录、账号、目的地、选题、修订、渠道稿、官网历史与 Claim |
| GET | `/api/platforms` | 平台定位与当前账号登记情况 |
| GET／POST | `/api/accounts` | 列出账号；新建 `{platformId,handle,profileUrl,language?,displayName?}`，初始未核实 |
| GET／PATCH | `/api/accounts/:id` | 读取或修改账号；启用须实际确认身份与规则，暂停／归档须原因 |
| GET | `/api/accounts/:id/history` | 实际变更历史及显式迁移基线；旧记录无字段历史时如实标记 |
| GET／POST | `/api/destinations` | 目的地列表；新建 `{platformId,accountId?,kind,name,locator,visibility}` |
| GET／PATCH | `/api/destinations/:id` | 读取或修改；核对定位、身份、可见范围与规则 |
| GET／POST | `/api/stories` | 列表或新建 `{workingTitle,claimIds?,topicIds?}` |
| GET／PATCH | `/api/stories/:id` | 读取；改工作标题或状态，归档保留正文与历史 |
| POST | `/api/stories/:id/editions` | 新建完整不可变修订；`If-Match` 使用选题 ETag |
| GET | `/api/editions/:id` | 完整原文与修订／翻译关系 |
| POST | `/api/editions/:id/variants` | 新建 `{destinationId,title?,summary?,body?,blocks?,assetRefs?,adaptationNote?,supersedesContentId?}`；使用原文 ETag |
| GET | `/api/editorial/variants/:id` | 完整独立渠道稿及 ETag |
| POST | `/api/content/:id/transition` | v2 稿按 `draft→fact_check→approved→scheduled`；批准另需 `reviewed:true,snapshotHash` |
| GET／POST | `/api/website/releases` | 历史列表；创建 `{contentId,slug}`，使用内容 ETag |
| GET | `/api/website/releases/:id` | 私有候选、审批和回执 |
| POST | `/api/website/releases/:id/approve` | `{reviewed:true,snapshotHash,authorizationNote}`；绑定完整公开快照 |
| POST | `/api/website/releases/:id/publish` | `{confirm:true,expectedPreviousReleaseId:null或原ID}`；执行真实备份与字节核对后激活 |
| POST | `/api/website/releases/:id/verify` | `{confirm:true}`；触发服务端真实回读，不能提供客户端 proof |
| POST | `/api/website/releases/:id/withdraw` | `{reason}`；保留历史，停用当前路由 |
| GET | `/admin/preview/:releaseId` | 管理员私有预览，`noindex,no-store`；媒体仍走认证字节地址 |

目的地 `locator` 为结构化对象：官网 `{origin}`；主页／页面／仓库／社区使用 `{url}`；Discord 使用 `{serverId,channelId,threadId?}`；技术作品目的地还需要 `artifactKind`。目录中的目的地类型必须与实际平台匹配，不能仅填一个平台名称就代替具体发布位置。

账号或目的地换身份会使原稿的快照与新身份不再匹配，须重新创建并审批。结果尚未确定的执行中动作会阻止改身份、暂停或归档；先核对原平台结果，避免把不确定状态抹去。

管理员 `POST /api/operations/:id/reconcile` 的请求为 `{approvedSnapshotHash,accountConfirmed:true,contentConfirmed:true,receipt,reason}`，并发送该动作的 `If-Match` 与本次 `Idempotency-Key`。`approvedSnapshotHash` 使用原动作显示的完整批准哈希；`receipt` 使用原有真实结果、实际发生与核验时间、采集／核验者及 `real`／`imported` 来源，不能预填假结果。v2 正常完成与调和还须 `editorialSnapshotHash` 和逐项实际回读的 `assetHashes:[{assetId,sha256}]`。该入口只对已有批准和执行记录的未确定结果进行核对，没有外发调用；当前身份、正文或事实偏差单独保留，不重写原授权。首次实际调和的同键同请求安全重试，异请求为 409。已完成动作与原规范回执完全相同时是纯读取，不新登记请求键或增加事件；不同回执不能覆盖历史。

## 实际媒体上传与播放

`POST /api/media/assets` 的请求体是原始二进制，不是 JSON、multipart 或本地路径。发送实际 `Content-Type`、`Idempotency-Key`，可附 `X-Content-Sha256` 和一次 URI 编码的 `X-Media-Name`。不要把凭据、联系信息或私密备注放进名称与审核文字。

默认单文件上限 **50 MiB**（WebVTT 字幕另限 **1 MiB**），整个素材目录上限 **500 MiB**，包括暂存与中断遗留文件占用。允许实际 PNG、JPEG、静态 WebP、MP4 和纯文本 WebVTT；服务检查真实格式、长度和 SHA-256，拒绝 HTML、SVG、错误声明、损坏结构与不安全文件路径。上传中断会返回明确错误并清理本次未完成文件，使用同一键可安全重试；相同键可恢复已经落盘但尚未提交元数据的那次上传。

| 方法／路径 | 行为 |
|---|---|
| GET `/api/media/assets`、`/:id` | 私有列表和素材元数据 |
| GET／HEAD `/api/media/assets/:id/bytes` | 实际私有字节；支持播放器所需的单段 Range |
| POST `/api/media/assets/:id/approve` | `{sha256,rightsConfirmed:true,privacyConfirmed:true,rightsNote}`；同时提供素材 ETag 与幂等键；`/review` 为同义入口 |
| POST `/api/media/assets/:id/revoke` | `{reason}`；保留字节与审核历史，停止公开使用 |
| GET／HEAD `/public-media/:id/:sha256` | 只有当前合格的公开修订引用这一准确哈希时才可匿名读取 |

素材库中的播放器读取真实认证字节，公开视频页使用原生 `<video controls playsinline>`、封面、字幕、可用章节与完整文稿。原文件是否可解码仍须用真实浏览器播放验收；格式校验不等同于完整视觉质量或自动隐私识别。

“审核通过”本身不会公开素材。每次公开 GET、HEAD、Range 和条件请求都重新检查资格；撤销素材、撤回稿件或相关事实失效后，旧 ETag 也不能换来公开 304。已被访客下载的副本无法通过撤稿远程收回。

## 官网激活与真实回读

公开地址为 `/:lang/articles|visuals|videos/:slug`，`lang` 为 `zh` 或 `en`。slug 为不超过 100 字符的小写英文、数字与单连字符。同一语言形式的后续修订沿用正式 URL。

1. 核对真实官网目的地、公开可用 Claim 和实际媒体，建立原文与独立官网稿。
2. 对完整稿件事实核验、批准、排期，再创建私有官网修订。
3. 对完整公开快照另行批准，核对正式 URL 与替代的旧修订 ID。
4. `publish` 实际验证引用字节，并备份完整状态与所有已登记媒体；成功后仅为 `live_unverified`。
5. `verify` 从受保护配置中的固定本站 origin 实际 GET 公开 DTO、初始 HTML、公开作者资料和每个媒体文件。它核对完整 DTO、模板、浏览器载入数据和媒体字节 SHA-256，不发送秘密头、不跟随跳转、不访问请求体传来的 URL。
6. 全部一致才记 `published` 和独立官网回执。超时、内容变化、隐藏正文、错误载入数据、媒体不符均保留未验证状态，核对后安全重试；不能凭一次 200 或手填哈希入账。

公开读取：`GET /public-api/content?locale=zh-CN&format=article&limit=20&cursor=...` 返回 `{items,nextCursor,total}`；详情为 `/public-api/content/:locale/:format/:slug`。只输出当前合格快照、公开来源白名单与公开媒体描述，不返回账号、审批备注、存储路径或私有修订。未存在地址为 404，已撤回或不再合格的地址为 410。没有替代译文时不生成虚假的 hreflang。

## 迁移、备份与隔离恢复

部署更新前继续使用既有停服完整备份。首次启动将 schema 1 一次升级到 2，添加编辑集合、平台 ID、显式账号迁移基线和未核实官网目的地；旧内容、Claim、回执和事件链前缀不变。身份资料版本与状态 schema 分别管理。未知 schema 或缺失迁移标记会停止，不能回退到宽松旧逻辑。

只读预检不启动应用、模型、视频或外部平台，也不取得可写锁：

```bash
node scripts/editorial-data.mjs plan --state-file /absolute/private/state.json --origin https://pengmanager.com
```

应用取得独占写入锁，正常停服会等待变更提交并释放锁；HTTP 排空有期限。已有活跃锁时第二个进程拒绝启动。强制杀进程后遇到 stale lock 时，先停止并核对所有写入者，保留状态与锁证据再受控恢复；不要无条件删除锁或用另一进程绕开。

公开激活前的备份位于 `DATA_FILE` 同目录的 `backups/editorial/EDB-…`，包含完整 `state.json`、每个已登记媒体的实际字节和 SHA 清单，受私有目录与文件权限保护。它标记为 `pre_activation`，准确记录尚未激活的候选；不能把这份备份当成最终发布回执已经保存。

最终回读后，再取得 `current` 快照并实际隔离恢复。以下命令需先停本服务，并以实际数据所有者身份运行，不能让 root 的 UID 检查冒充服务用户：

```bash
node scripts/editorial-data.mjs backup --state-file /absolute/private/state.json
node scripts/editorial-data.mjs verify-backup --state-file /absolute/private/state.json --backup-id EDB_ID --manifest-sha256 SAVED_MANIFEST_SHA256
node scripts/editorial-data.mjs restore --state-file /absolute/private/state.json --backup-id EDB_ID --manifest-sha256 SAVED_MANIFEST_SHA256 --target /absolute/private/new-isolated-directory
```

将 `EDB_ID` 和摘要换成实际备份响应。管理命令拒绝活跃写入锁；恢复目标必须尚不存在，并在在线数据目录及其祖先之外。实际恢复后重新检查状态、事件链、双语修订、回执、幂等记录和全部媒体字节，再重新打开隔离实例。它不能恢复 GEO SQLite、服务配置或完整视频数据库；这些仍使用[部署完整备份](ALIYUN-DEPLOYMENT.md#更新备份与恢复)。Mac `final.md` 定稿副本也不能替代这两类完整备份。

只在尚未接受新写入时，才允许从迁移前一致快照回退。接受 v2 编辑写入后，保留这些数据并做向前修复或无损迁移；禁止仅切旧二进制后继续操作 v2 状态。完整恢复演练不覆盖在线目录。

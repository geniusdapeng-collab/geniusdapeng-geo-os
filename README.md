# 鹏经理系统 · PengManager System

鹏经理系统是李大鹏（PengManager）的个人网站与私有经营后台。公开主页展示中英文介绍和已经批准公开的事实；登录后的后台管理账号矩阵、内容准备、授权、发布与回复回执，以及 AI 搜索观察。系统保留本地优先的数据方式，也提供阿里云单机部署、HTTPS、登录、停服备份和更新恢复支持。

系统内置个人 GEO 证据引擎与完整视频生产引擎，覆盖 AI 视频生成、AI 剪辑、AI 口播、Compositor 作图，以及对应的数字员工、技能、工具和素材库。视频引擎保留原生 PostgreSQL 事务、身份、预算、授权、审批和生产档案；根服务统一管理独立数据库、视频后端与工作台，无需运行另一个 Edit 项目。

仓库地址继续使用 [`geniusdapeng-collab/geniusdapeng-geo-os`](https://github.com/geniusdapeng-collab/geniusdapeng-geo-os)。项目展示名称与主账号资料已统一为 PengManager；GitHub 仓库路径与既有证据地址保持兼容。

## 主账号资料

| 资料 | 中文 | English |
|---|---|---|
| 主账号名 | 李大鹏 | PengManager |
| 展示名 | 李大鹏｜用AI搞经营的产品经理 | Dapeng Li · PengManager |

中文简介：

> 李大鹏｜用AI搞经营的产品经理
>
> 全栈 AI 产品专家，把模型能力做成专业领域 Agent 数字员工与自主经营系统。

English bio:

> Dapeng Li · PengManager
>
> Turning model capabilities into domain-specific AI employees and autonomous business systems.

以上资料用于系统身份、账号档案和内容生产的统一口径。平台账号档案是本地运营资料；更新资料并不代表已经修改外部平台主页或取得公开发布回执。

## 系统能完成什么

| 模块 | 可执行行为 | 完成依据 |
|---|---|---|
| 个人主页与私有后台 | 向访客展示公开介绍，管理员登录后查看运营数据 | 公开资料过滤与私有 API 认证边界 |
| 主账号与平台档案 | 管理中英文身份、16 个平台账号及实际 handle、主页、启用和规则审阅状态 | 账号档案、审阅人、审阅日期 |
| Claim 事实库 | 记录事实来源、证据等级、公开范围、有效期和审核人 | 通过审核的事实记录 |
| 内容工作台 | 从选题创建草稿，绑定事实，经过事实核验、审批和排期 | 内容状态、版本与审批记录 |
| 运营动作与回执 | 为每次发布或回复建立草稿、记录具体授权、执行状态与实际结果；完成发布时同步既有内容账本 | 账号身份快照、正文哈希、真实 URL、发布与回读时间、核验人 |
| 互动分流 | 将评论、私信和线索分为 L0–L3，识别需人工处理的场景 | 分类记录与人工处理边界 |
| 个人 GEO | 管理查询、采集 AI 回答、保存引用、计算提及率和引用指标 | 真实或导入样本、证据哈希与采集时间 |
| 完整视频工作台 | 从创作意图进入事实情报、策划分镜、素材授权、预算资格、AI 生成、剪辑、口播、后期、返修和交付 | 原生项目、围栏审批、预算账本、生产档案与当前字节回执 |
| 能力与数字员工目录 | 检索完整角色、技能、工具、能力和安装项，查看来源、绑定和验证状态 | 本地受控清单与独立工位诊断，声明不冒充产出 |
| 本地快捷后期 | 对已有本地片段执行字幕、调色、合成环境音、封面、风格变体和打包；默认每段最多 4 秒 | 本地任务与技术质检，不替代完整 AI 生产流程 |
| 事件账本 | 为数据变更追加前后相连的 SHA-256 事件 | 可验证的哈希事件链 |

种子数据包含 120 条内容选题和工作流示例，初始事实仍需审核。系统不会把草稿、演示数据、本地产物或一次 HTTP 成功响应当成外部发布完成。

## 典型工作流程

1. **统一个人账号资料**：核对主账号与各平台档案，使用同一套中英文展示名和简介，再按各平台实际规则人工更新外部主页。
2. **交付内容并回复读者**：选题 → 批准 Claim → 事实核验 → 内容审批与排期 → 建立单账号发布动作 → 本次授权 → 本人在浏览器操作，或由获授权的 Codex 使用本机已登录浏览器执行 → 打开平台结果核对 → 回写 URL 与回执。回复同样记录目标帖子、精确正文、授权与回读；高风险互动由本人手工处理。
3. **检验 AI 是否正确识别个人品牌**：固定查询 → 采集 AI 回答与引用 → 对比实体提及、同名歧义及负面样本 → 根据证据补充内容 → 下一轮复测。
4. **生产 AI 视频、口播或作图**：视频工作台 → 原生项目与数字员工 → 事实和素材核验 → 所需人工审批与预算资格 → 配置的模型/本机工位 → 剪辑后期 → 质量证据与交付。供应商和依赖未就绪时明确显示缺项；付费调用与发布需相应授权。

## 本地启动

使用 Node.js 24 或更高版本、pnpm，以及可执行的 FFmpeg / FFprobe。依赖版本与脚本以仓库 [`package.json`](package.json) 和锁文件为准；以下沿用仓库已有运行命令。

```bash
pnpm install --ignore-scripts
node scripts/video-setup.mjs --install --build --postgres-root /path/to/postgresql-17
node src/server.mjs
```

首次安装需要完整的 PostgreSQL 17 工具包及 pgvector，`--postgres-root` 指向其安装前缀（含 `bin/lib/share`）；安装器把工具复制到鹏经理私有存储，不复制已有数据库。依赖安装与构建使用内置引擎的锁文件。已有完整依赖和构建时可省略 `--install --build`；诊断命令为 `node scripts/video-doctor.mjs`。实际选项与依赖缺项以命令输出为准。

当前以 CLI/MCP 调用为主，默认不启动视频网页。查看完整员工、技能、工具目录与已审定的 Agent 调用入口：

```bash
node scripts/agent.mjs status
node scripts/agent.mjs capabilities
node scripts/agent.mjs list
node scripts/agent.mjs describe growth.video.production.shots
node scripts/agent.mjs invoke core.workspace.profile
node scripts/agent-mcp.mjs
```

`invoke` 接受 `--input-file <JSON文件或->`，`-` 从标准输入读取。MCP 使用 stdio，提供与 CLI 相同的已登记工具和 `pengmanager_video_status`、`pengmanager_video_capabilities`。完整目录包括全部内置角色、技能、工具；可直接调用的 Agent 工具以 `list` 的登记项为准，其他完整引擎能力保留原生 CLI/SDK 入口。原生调用通过真实本机身份进入原有权限、租户、审批、预算与回执流程，不提供任意 RPC 路径或自动审批。

独立 Agent 进程在首次需要原生服务时管理自己的服务生命周期，退出时清理；同一私有数据目录一次运行一个监督进程。已有会话可通过当前进程的 `WORKLOOM_ACCESS_TOKEN` 和相同的 `PENGMANAGER_VIDEO_BACKEND_PORT` 附着正在运行的本机后端，不会另起或停止它，令牌不写入文件或命令参数。网页可后续选择启用：`node scripts/video-start.mjs --with-workbench`，或设置 `PENGMANAGER_VIDEO_WORKBENCH=1`。根控制台仍位于 <http://127.0.0.1:4318>；查看状态和目录不会调用模型或提交生成任务。

打开 <http://127.0.0.1:4318> 或 <http://127.0.0.1:4318/admin>。默认开发模式只监听本机回环地址；未启用密码时仅供本机使用。未配置模型或平台凭据时，对应实时适配器会报告不可用；账号、事实、草稿与运营记录仍可使用。

启用 `PUBLIC_WEBSITE=1` 后，`/` 提供公开个人主页，`/admin` 提供管理后台。公网部署强制要求 `ADMIN_PASSWORD_HASH`、HTTPS `PUBLIC_ORIGIN` 与匹配的 Host 白名单；缺少配置时拒绝启动。管理员通过 `/login` 登录，退出后当前会话立即失效。阿里云的已有资源复用、低成本方案、安装、域名、证书、备份及真实上线验收见 [阿里云部署与运维](docs/ALIYUN-DEPLOYMENT.md)。具备部署代码不等于网站已在公网完成验收。

Codex 回写可使用独立、受限的 Agent 令牌：它只能读取允许的工作台资料，更新已由管理员授权的普通浏览器动作，或登记互动；不能自行批准事实或内容、启用账号、授权新动作、调用实时外发接口，亦不能使用旧手工发布接口绕过动作授权。令牌仅通过当前请求的 Authorization 头传入，服务配置保存其哈希。社媒账号密码与 Cookie 继续留在本人本机浏览器。

默认运行时数据保存在已被 Git 忽略的 `var/` 下：

- `var/state.json`：账号、事实、内容、运营动作、回执、观察记录与事件账本。
- `var/geo-engine/personal-geo.sqlite`：个人 GEO 查询、采集、指标、事故和文章数据。
- `var/media/jobs/`：媒体任务、过程文件、最终产物与任务回执。

如通过 `DATA_FILE` 或 `GEO_ENGINE_DB` 改过存储位置，备份时也要包含对应路径。

完整视频数据库、凭据和产物另保存在仓库外的私有目录。macOS 默认为 `~/Library/Application Support/PengManager/video-runtime`；其他系统默认目录由 `src/video-runtime/config.mjs` 定义，也可设置 `PENGMANAGER_VIDEO_DATA_DIR`。该目录含受保护凭据与 PostgreSQL 数据，不能提交、复制进仓库或放入公开证据。备份与恢复必须同时覆盖这两组数据，见运维说明。

## 现有数据与名称兼容

更新代码前请先停止服务，并把整个 `var/` 目录备份到受保护的本地位置。不要删除 `var/state.json` 来更新名称，否则会丢失现有运营记录。

新安装直接使用 PengManager 资料；已有状态在服务启动时执行一次可重复运行的身份迁移，更新系统与主账号资料，并追加 `identity.updated` 事件。自定义查询、已审批事实、已发布内容、发布回执和既有事件保持原样；仅符合旧默认模板的未审批资料与查询更新为新口径。迁移不会重新发布内容或修改外部平台主页。

GitHub 仓库 URL、平台真实 URL、记录 ID、历史运行证据和上游名称不以文本替换方式重写。个人 GEO 引擎保留既有数据库 case ID 与查询 ID，旧品牌别名用于识别历史 AI 回答与同名消歧。详细规则见 [运维说明](docs/OPERATIONS.md)。

## 验证与可选实时运行

本地检查：

```bash
node --check src/server.mjs
node --check public/app.js
node --test tests/*.test.mjs
node --test engines/geo-evidence/test/*.test.mjs
pnpm test:vendor
node scripts/smoke.mjs
node scripts/security-scan.mjs
```

以下命令会调用外部模型、生成媒体或写入 GitHub。仅在已授权、凭据就绪并理解调用成本时执行：

```bash
node scripts/live-geo-integrated.mjs
node scripts/live-media-render.mjs
node scripts/live-github-publish.mjs
```

GitHub 适配器从当前进程的 `GITHUB_TOKEN` 读取令牌；模型适配器使用其现有进程环境或本机凭据配置。真实凭据不得进入仓库、脚本、日志、截图或回执。配置与确认要求见 [HTTP API](docs/API.md)。

## 数据模式与发布边界

- `real`：真实采集或真实外部操作，必须保留对应来源与证据。
- `imported`：从平台导出或人工导入，必须保留来源。
- `fixture`：演示与测试，只证明流程可以运行。
- `draft`：尚未完成事实核验或审核，不允许作为发布回执。

只有 `real` 和 `imported` 观察记录进入运营指标。运营动作完成还必须记录公开 HTTPS 结果、发布时间、采集人、回读方式、回读时间与核验人；URL 本身不能证明动作成功，后台保存的是执行者的实际回读记录。重复提交相同回执会返回原记录，不重复入账。动作绑定创建时的账号 handle／主页与正文哈希，审批后换账号或换文需要重新建立动作。

公开导出仅允许经过审核、未过期且不敏感的 `approved_public` 事实，并要求公开来源及低敏感度；只输出经过筛选的来源标签与 URL，不公开私有来源备注。私有仓库本身不是公开 GEO 信源。

本地服务实施 Host 白名单、跨站请求检查与 CSP。令牌、密码、Cookie、验证码和个人敏感信息不得写入仓库或事件账本。招聘、客户、法律、金融、隐私与负面互动保留人工处理。没有审核过的官方接口与明确授权时，不启用无人值守的平台发布或互动。

## 文档与历史验证

- [架构与边界](docs/ARCHITECTURE.md)
- [HTTP API 与确认参数](docs/API.md)
- [账号运营、登录、迁移、备份与恢复](docs/OPERATIONS.md)
- [阿里云低成本部署、HTTPS 与上线验收](docs/ALIYUN-DEPLOYMENT.md)
- [路线图](docs/ROADMAP.md)
- [更新记录](CHANGELOG.md)
- [2026-10-18 / 19 历史真实运行记录](docs/LIVE-VERIFICATION.md)
- [2026-10-19 审计与验收记录](docs/AUDIT-2026-10-19.md)

历史真实运行记录描述相应日期的环境和结果，不代表本次修改已经重新执行所有外部调用，也不代表全平台已经发布。

## 目录与上游来源

```text
src/                  领域规则、状态机、存储与 HTTP 服务
engines/geo-evidence/  个人 GEO SQLite 与采集、指标、文章引擎
engines/video-edit/    完整锁定 Edit 引擎、原生服务/UI/数据库/数字员工/技能/工具/素材
src/video-runtime/    独立数据库、原生身份、受管服务与工作台生命周期
public/               公开个人主页、登录页与响应式私有后台
deploy/aliyun/        阿里云单机预检、安装、更新、备份与恢复
data/seed/            账号、事实、查询、示例与 120 条选题
docs/                 架构、API、运维、路线图与历史证据
upstreams/            上游锁定版本与来源边界
tests/                单元与 HTTP 集成测试
var/                  已忽略的私有运行数据与本地产物
```

GeoEvidence Studio 与 WorkLoom-video-edit 的上游版本、许可证和来源保留在 `upstreams/` 与相应引擎目录。完整 Edit 源码按受控快照保留，PengManager 用自己的私有数据库和真实本机工作区启动；不连接另一套运行中的 Edit 服务，不导入上游经营样本或自动批准队列。目录声明、依赖就绪和实际产出分别记录；完整目录不代表所有供应商已经配置或所有能力完成生产验收。

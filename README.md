# 鹏经理系统 · PengManager System

鹏经理系统是李大鹏（PengManager）的私有、本地优先个人 GEO 与内容运营系统。它把账号资料、事实核验、内容生产、人工审批、发布回执和 AI 搜索观察放在同一个控制台中，让每次内容交付有来源、每次外发有记录、每轮复测有依据。

系统内置个人 GEO 证据引擎和视频后期引擎，可在同一仓库内完成查询采集、引用与提及分析、文章草稿、字幕、调色、BGM、封面和视频打包。GeoEvidence Studio 与 WorkLoom-video-edit 的相关代码已纳入 `engines/`，无需另外启动这两个上游项目。

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
| 主账号与平台档案 | 管理中英文身份及 16 个平台账号的定位、资料和发布边界 | 本地档案及平台策略审核状态 |
| Claim 事实库 | 记录事实来源、证据等级、公开范围、有效期和审核人 | 通过审核的事实记录 |
| 内容工作台 | 从选题创建草稿，绑定事实，经过事实核验、审批和排期 | 内容状态、版本与审批记录 |
| 发布与回执 | 记录人工发布 URL；对经过审核的内容调用 GitHub Issue 适配器 | `real` / `imported` 回执与内容哈希 |
| 互动分流 | 将评论、私信和线索分为 L0–L3，识别需人工处理的场景 | 分类记录与人工处理边界 |
| 个人 GEO | 管理查询、采集 AI 回答、保存引用、计算提及率和引用指标 | 真实或导入样本、证据哈希与采集时间 |
| 视频生产 | 基于本地视频素材生成后期、字幕、封面、风格变体和交付包 | 媒体任务、产物哈希与技术质检回执 |
| 事件账本 | 为数据变更追加前后相连的 SHA-256 事件 | 可验证的哈希事件链 |

种子数据包含 120 条内容选题和工作流示例，初始事实仍需审核。系统不会把草稿、演示数据、本地产物或一次 HTTP 成功响应当成外部发布完成。

## 三个典型工作流程

1. **统一个人账号资料**：核对主账号与各平台档案，使用同一套中英文展示名和简介，再按各平台实际规则人工更新外部主页。
2. **交付一条有依据的内容**：选题 → 绑定 Claim → 事实核验 → 人工审批 → 排期 → 平台发布 → 记录真实 URL 与回执。GitHub 以外的平台默认保留人工发布边界。
3. **检验 AI 是否正确识别个人品牌**：固定查询 → 采集 AI 回答与引用 → 对比实体提及、同名歧义及负面样本 → 根据证据补充内容 → 下一轮复测。

## 本地启动

使用 Node.js 24 或更高版本、pnpm，以及可执行的 FFmpeg / FFprobe。依赖版本与脚本以仓库 [`package.json`](package.json) 和锁文件为准；以下沿用仓库已有运行命令。

```bash
pnpm install --ignore-scripts
node src/server.mjs
```

打开 <http://127.0.0.1:4318>。服务默认只监听本机回环地址，控制台和 HTTP API 共用同一个本地进程。未配置模型或平台凭据时，对应实时适配器会报告不可用；账号、事实、草稿等本地工作流仍可使用。

默认运行时数据保存在已被 Git 忽略的 `var/` 下：

- `var/state.json`：账号、事实、内容、回执、观察记录与事件账本。
- `var/geo-engine/personal-geo.sqlite`：个人 GEO 查询、采集、指标、事故和文章数据。
- `var/media/jobs/`：媒体任务、过程文件、最终产物与任务回执。

如通过 `DATA_FILE` 或 `GEO_ENGINE_DB` 改过存储位置，备份时也要包含对应路径。

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

只有 `real` 和 `imported` 观察记录进入运营指标。公开导出仅允许经过审核、未过期且不敏感的 `approved_public` 事实；私有仓库本身不是公开 GEO 信源。

本地服务实施 Host 白名单、跨站请求检查与 CSP。令牌、密码、Cookie、验证码和个人敏感信息不得写入仓库或事件账本。招聘、客户、法律、金融、隐私与负面互动保留人工处理。没有审核过的官方接口与明确授权时，不启用无人值守的平台发布或互动。

## 文档与历史验证

- [架构与边界](docs/ARCHITECTURE.md)
- [HTTP API 与确认参数](docs/API.md)
- [运行、迁移、备份与恢复](docs/OPERATIONS.md)
- [路线图](docs/ROADMAP.md)
- [更新记录](CHANGELOG.md)
- [2026-10-18 / 19 历史真实运行记录](docs/LIVE-VERIFICATION.md)
- [2026-10-19 审计与验收记录](docs/AUDIT-2026-10-19.md)

历史真实运行记录描述相应日期的环境和结果，不代表本次修改已经重新执行所有外部调用，也不代表全平台已经发布。

## 目录与上游来源

```text
src/                  领域规则、状态机、存储与 HTTP 服务
engines/geo-evidence/  个人 GEO SQLite 与采集、指标、文章引擎
engines/video-edit/    后期、字幕、调色、封面与打包代码
public/               响应式本地控制台
data/seed/            账号、事实、查询、示例与 120 条选题
docs/                 架构、API、运维、路线图与历史证据
upstreams/            上游锁定版本与来源边界
tests/                单元与 HTTP 集成测试
var/                  已忽略的私有运行数据与本地产物
```

GeoEvidence Studio 与 WorkLoom-video-edit 的上游版本、许可证和来源保留在 `upstreams/` 与相应引擎目录。WorkLoom 桌面壳、PostgreSQL、租户系统与无关行业包未纳入本系统。

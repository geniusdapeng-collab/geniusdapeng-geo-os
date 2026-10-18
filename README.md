# 天才大鹏

`geniusdapeng-geo-os` 是李大鹏的个人 GEO 与全网社媒运营系统，公开品牌为“鹏栈 / PengStack”。GeoEvidence Studio 的采集、SQLite、指标、事故和文章能力，以及 WorkLoom-video-edit 的后期、字幕、调色、BGM、封面、打包和反馈分诊代码，已作为仓库内引擎整合，不再依赖两个外部项目在本机运行。

第一版不是“一键全网发布器”。它把无法省略的步骤显式化：事实先于内容，审批先于外发，回执先于完成，测量先于下一轮。没有真实平台回执的内容不会被标记为已发布。

## 当前能力

- 16 个平台的账号档案与发布边界
- Claim 事实库与公开级别
- 内容草稿、证据状态机和人工审批
- 手工发布回执与 URL 回读字段
- L0-L3 评论、私信和招聘线索分流
- GEO 查询、观察记录、提及与引用指标
- 只增不改的哈希事件链
- 120 条初始内容选题库
- 响应式本地控制台
- 当前模型 `deepseek-flash` 的真实 Responses 兼容接口
- 12 条 DeepSeek Search + Chat/Responses 真实基线样本
- 进程内个人 GEO SQLite 引擎：查询、样本、指标、事故、10 类文章和发布回执
- 进程内 video-edit 媒体引擎：FFmpeg 后期、字幕、调色、BGM、转场、封面、双风格和最终打包
- 媒体任务真实出片与技术质检回执
- 经模型生成、事实审批和 GitHub 官方 REST API 完成的真实 Issue 回执

## 启动

需要 Node.js 24 或更高版本，以及 FFmpeg/FFprobe。

```bash
pnpm install --ignore-scripts
node src/server.mjs
```

打开 <http://127.0.0.1:4318>。服务默认只监听本机回环地址，运行时数据写入 `var/state.json`。

运行测试：

```bash
node --test tests/*.test.mjs
node --test engines/geo-evidence/test/*.test.mjs
pnpm test:vendor
node --check src/server.mjs
node --check public/app.js
```

实时适配器验收：

```bash
node scripts/live-geo-integrated.mjs
node scripts/live-media-render.mjs
GITHUB_TOKEN=... node scripts/live-github-publish.mjs
```

令牌只在当前进程环境中使用。不要把真实值写进 `.env` 后提交。

## 数据模式

- `real`：真实采集或真实外部操作，可用于效果结论
- `imported`：从平台导出或人工导入，必须保留来源
- `fixture`：演示与测试，只证明流程可跑
- `draft`：未完成事实或审核，不允许发布

## 安全边界

- 不把令牌、密码、Cookie、验证码或个人敏感信息写入仓库、日志或事件账本。
- 本地控制面只接受 `ALLOWED_HOSTS` 中的 Host，并拒绝跨站浏览器写请求。
- 页面启用 CSP、禁止被框架嵌入，并使用同源连接。
- 不在未安装依赖的情况下自动发布到外部平台。
- 平台规则未确认时按人工内容包处理。
- 公开导出只允许 `approved_public` 且未过期的事实。
- 招聘、客户、法律、金融、负面和隐私对话必须人工处理。
- 当前真实写接口只验证了 GitHub Issue；其他平台没有凭据时继续 fail-closed。

最近一次真实运行结果见 [docs/LIVE-VERIFICATION.md](docs/LIVE-VERIFICATION.md)。

2026-10-19 深度审计、修复台账、覆盖率声明和真机测试结果见
[docs/AUDIT-2026-10-19.md](docs/AUDIT-2026-10-19.md)。

## 目录

```text
src/                 领域规则、状态机、存储与 HTTP 服务
engines/geo-evidence/ 个人化 GeoEvidence SQLite 与采集/指标/文章引擎
engines/video-edit/   仓库内 video-edit 后期、字幕、调色、封面和打包代码
public/              本地控制台
data/seed/           账号、事实、查询和 120 条内容选题
docs/                架构、API、运营和 ADR
upstreams/           两个上游项目的锁定版本与来源边界
tests/               单元与 HTTP 集成测试
var/                 本地运行时数据，已忽略
```

## 上游边界

GeoEvidence Studio 的 `06b47a1` 版本与 WorkLoom-video-edit 的 `2412a5b` 版本已按 Apache-2.0 将相关生产代码纳入 `engines/`，许可证保留在各引擎目录。上游 WorkLoom 桌面壳、PostgreSQL、租户系统和无关行业包没有进入本系统。私有 GitHub 仓库不是公开 GEO 信源；公开证据页仍必须从 `approved_public` 数据单独构建。

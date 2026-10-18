# 天才大鹏

`geniusdapeng-geo-os` 是李大鹏的个人 GEO 与全网社媒运营控制面，公开品牌为“鹏栈 / PengStack”。它是私有的本地优先系统，负责事实、内容、审批、发布回执、互动分流和 AI 可见性复测。

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
- 响应式本地控制台，无第三方运行时依赖
- 当前模型 `deepseek-flash` 的真实 Responses 兼容接口
- 12 条 DeepSeek Search + Chat/Responses 真实基线样本
- GeoEvidence Studio 生产 HTTP 适配器
- WorkLoom-video-edit 封面知识库生产 CLI 适配器
- 经模型生成、事实审批和 GitHub 官方 REST API 完成的真实 Issue 回执

## 启动

需要 Node.js 22 或更高版本。

```bash
node src/server.mjs
```

打开 <http://127.0.0.1:4318>。服务默认只监听本机回环地址，运行时数据写入 `var/state.json`。

运行测试：

```bash
node --test
node --check src/server.mjs
node --check public/app.js
```

实时适配器验收：

```bash
node scripts/live-deepseek-collect.mjs
node scripts/live-geoevidence.mjs
VIDEO_EDIT_ROOT=../upstreams/WorkLoom-video-edit node scripts/live-video-edit.mjs
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
- 不在未安装依赖的情况下自动发布到外部平台。
- 平台规则未确认时按人工内容包处理。
- 公开导出只允许 `approved_public` 且未过期的事实。
- 招聘、客户、法律、金融、负面和隐私对话必须人工处理。
- 当前真实写接口只验证了 GitHub Issue；其他平台没有凭据时继续 fail-closed。

最近一次真实运行结果见 [docs/LIVE-VERIFICATION.md](docs/LIVE-VERIFICATION.md)。

## 目录

```text
src/                 领域规则、状态机、存储与 HTTP 服务
public/              本地控制台
data/seed/           账号、事实、查询和 120 条内容选题
docs/                架构、API、运营和 ADR
upstreams/           两个上游项目的锁定版本与适配器边界
tests/               单元与 HTTP 集成测试
var/                 本地运行时数据，已忽略
```

## 上游边界

GeoEvidence Studio 与 WorkLoom-video-edit 继续独立演进。本项目首版只固定适配器契约，不复制两个上游仓库的完整应用壳。私有 GitHub 仓库不是公开 GEO 信源；后续公开证据页必须从 `approved_public` 数据单独构建。

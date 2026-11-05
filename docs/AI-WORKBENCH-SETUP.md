# 在 Codex 和 Qoder 中对话使用鹏经理

本指南面向在自己电脑上使用 Codex 或 Qoder 的鹏经理 owner。用户说明目标、素材和交付要求，Agent 负责找到当前入口、检查权限与工位、执行命令并读回结果。已获得的同一任务授权继续有效，缺少必要输入或实际审批时按对应业务规则处理。

例如，用户说“用鹏经理做一支三十秒的雨夜赛道短片”，Agent 应保留这句原话并使用现有标准视频流程。用户无需自己拼接 CLI 参数。本文的命令供 Agent 完成接入和执行时使用。

## 已有入口与本次补齐

| 项目 | 当前实现与使用方式 |
| --- | --- |
| CLI 与 stdio MCP | 两者复用同一登记目录和原生权限。`scripts/agent.mjs` 提供发现与调用，`scripts/agent-mcp.mjs` 提供 MCP。 |
| 视频生产 | `scripts/video-standard.mjs` 已提供 `plan`、`start`、`status`、`resume`、`deliver`，沿用 owner 授权、原生审批、预算和项目回执。 |
| 接入指南发现 | `pengmanager_agent_guide` 返回当前 checkout 的完整指南、文件 SHA-256、绝对路径和实际支持范围。MCP 初始化指引要求先读取它。 |
| 客户端配置 | `scripts/ai-workbench.mjs config` 根据本机实际 Node、checkout 和私有目录生成配置，结果只输出到 stdout。 |
| Qoder 项目 Agent | `.qoder/agents/pengmanager.md` 保存本项目的接手规则、工具范围与 MCP 关联。具体配置和客户端连接仍需完成。 |

支持范围以当前 `tools/list` 和 CLI `describe` 为准。完整视频生产需要宿主允许 Agent 使用 shell 调用标准 CLI。仅有 MCP 的客户端可使用指南、目录、计划、预检和已登记工具，当前没有完整生产的纯 MCP 入口。

| 候选方案 | 优点 | 成本、风险与适用条件 |
| --- | --- | --- |
| 复用标准 CLI，MCP 提供指南与发现，生成客户端配置 | 使用已有项目、授权、预算、恢复与媒体交付规则，Codex 和 Qoder 共用一套业务实现 | Agent 需要 shell，并协调同一私有目录的监督进程。现有本机客户端可采用。 |
| 新增一个涵盖生产全过程的 MCP 执行器 | 仅有 MCP 的宿主也可发起完整作业 | 需另外实现异步任务、取消、重连、恢复和授权交接，并验证与既有账本一致。属于后续产品改造。 |

本次采用第一种方案，把对话连接到现有执行路径。配置和指南验收不需要重新提交付费模型任务。

## 三个对话场景

| 用户说的话 | Agent 执行的流程 | 权限和完成依据 |
| --- | --- | --- |
| “用鹏经理做一支三十秒的赛道短片” | 读取当前指南，保留原话，用 `pengmanager_video_workflow` 或标准 CLI `plan` 核对总时长，检查本机工位后使用标准 CLI `start` | 读取本次 owner 授权、素材权利和预算要求。交付依据是同一项目的当前媒体、清单、技术检查与实际播放。 |
| “继续上次那个视频，看看卡在哪并完成它” | 找到原 `jobId`、私有目录和原话，先 `status`。按实际状态使用同一请求的 `resume` 或 `deliver` | 未知用量或供应商结果先沿原项目对账。保留旧任务与新尝试，成功素材按当前字节核验后复用。 |
| “查看那篇内容有没有发布成功，把结果告诉我” | 按 AI Agent 指南核对目标站点和当前可用身份，读取内容、运营动作与原始回执，必要时查看获准平台的真实结果 | 受限 HTTP Agent bearer 只能访问其允许的路由。新的内容审批、单账号外发和平台登录仍按实际权限执行。目录发现本身不授予云站管理权。 |

第三个场景使用现有云端 HTTP 或浏览器流程。MCP 的已登记视频工具没有自动获得这些内容管理权限。创建内容、准备渠道稿或执行获准发布时，继续阅读 [AI Agent 指南](AI-AGENT-GUIDE.md) 的具体接口与授权规则。

## 准备同一份本机安装

先在实际 checkout 完整阅读根 `AGENTS.md` 和 [AI Agent 指南](AI-AGENT-GUIDE.md)。Node、固定依赖、PostgreSQL 工具和私有视频目录按 [视频快速指南](CODEX-VIDEO-QUICKSTART.md) 准备。已有安装先诊断当前实例，保留原数据库、项目和授权。

以下命令在仓库根执行。默认输出采用启动生成器的真实 Node 可执行文件、当前 checkout 的绝对路径及该运行时解析出的私有目录。已有项目使用自定义目录时显式传入 `--data-dir`，并在 MCP、CLI 和后续状态查询中继续使用它。配置中的 `env` 仅携带私有目录和生成器当前进程显式提供且校验通过的服务端口，避免用默认端口覆盖模型环境文件中的实例设置。生成器不会读取该文件内容，Node 启动 MCP 后再按实际环境解析坐标。默认不传 `--client` 时输出包含三种格式及说明字段的 JSON 合集。

```sh
node scripts/ai-workbench.mjs config --client codex
node scripts/ai-workbench.mjs config --client qoder
node scripts/ai-workbench.mjs config --client generic
```

需要指定已有私有目录或模型环境文件时使用实际绝对路径。

```sh
node scripts/ai-workbench.mjs config --client codex \
  --data-dir /absolute/private/video-runtime \
  --model-env-file /absolute/private/model.env
```

`--client qoder` 和 `--client generic` 使用相同的可选参数。环境文件由 owner 的秘密管理方式提供，配置仅引用其路径。文件必须已经存在于本 checkout 之外，使用规范绝对路径，文件与祖先路径均无软链，是单一硬链接的普通文件，大小为 1 字节到 1 MiB。在 macOS/Linux 上还需由当前用户所有、owner 可读，并禁止组和其他用户访问，通常设为 0600。校验只读文件元数据，失败返回 `MODEL_ENV_FILE_INVALID`。密钥值、Cookie 和私有授权内容都不应复制进配置片段、仓库或对话。无需模型的目录发现可省略环境文件。

生成器输出后，由 Agent 检查并合并配置。它不会写入宿主设置。应保留其他 server 与无关配置，遇到同名 `pengmanager-video` 项先核对其 checkout 和私有目录，再更新这一项。不要把完整 stdout 直接重定向覆盖已有配置文件。

## Codex 接入

`--client codex` 输出 `pengmanager-video` 的 TOML 配置片段。将该表合并到所选主机的 `~/.codex/config.toml`，或受信任项目的 `.codex/config.toml`。同一 Codex 主机上的桌面客户端、CLI 和 IDE 扩展共享 MCP 配置。客户端重启连接后检查实际服务器状态和 `tools/list`。官方说明列出了配置位置、`command`、`args`、`env` 和 MCP 初始化指引的含义。 [Codex MCP 官方说明](https://learn.chatgpt.com/docs/extend/mcp)

配置使用本机 stdio。Agent 仍通过宿主已有的 shell 权限执行标准视频 CLI，执行审批遵循当前会话规则。配置服务器本身不会完成视频生产，也不会自动授予模型费用权限。

## Qoder 接入

`--client qoder` 输出带 `mcpServers` 的 JSON，使用同一份片段按实际客户端接入。

在 Qoder IDE 中打开 **Settings → MCP → My Servers → Add**，在出现的 JSON 中合并 `pengmanager-video` 一项，保留其他服务器，保存后核对连接图标并展开工具列表。在 Chat 中使用 Agent 模式，按宿主的实际调用确认继续任务。IDE 的 MCP 设置与连接检查流程见官方说明。 [Qoder IDE MCP](https://docs.qoder.com/user-guide/chat/model-context-protocol)

在 Qoder CLI 中，按范围选择用户级 `~/.qoder/settings.json`，或项目级 `.qoder/settings.json`、`.mcp.json`，本机项目私有设置也支持 `.qoder/settings.local.json`。合并 `pengmanager-video` 一项后遵循对应信任与审批，用 `/mcp` 检查，修改后可用 `/mcp reload` 重新发现。CLI 官方文档说明了各层覆盖顺序及 stdio 的 `command`、`args`、`env`、`cwd`。 [Qoder CLI MCP reference](https://docs.qoder.com/cli/mcp-reference)

仓库提供的 `.qoder/agents/pengmanager.md` 是项目级自定义 Agent。它关联名为 `pengmanager-video` 的 MCP，允许 `Read`、`Grep`、`Glob`、`Bash`，模型沿用当前会话。用户可在对话中说明鹏经理任务，或使用 `/pengmanager` 选择该 Agent。实际是否自动选中取决于宿主的 Agent 加载和调度结果。 [Qoder Custom Agent 官方说明](https://docs.qoder.com/extensions/subagent)

`--client generic` 提供相同启动信息的通用 JSON，其他 stdio 客户端按自己的配置结构接入。远端宿主需要能在持有该私有运行时的受控主机上启动对应进程。

## 首次连接与每次更新后的检查

1. MCP 握手后先调用 `pengmanager_agent_guide`，参数为 `{}`。完整阅读 `documents[].markdown`，记录每份文档的 `path` 与 `sha256`，核对 `rootDir`、`dataDir` 和 `cli` 的绝对入口。输出被宿主截断时，通过其返回的固定 `absolutePath` 用文件读取工具继续读完。
2. 查看 `support`。当前 `shellRequiredForProduction:true`、`pureMcpProductionSupported:false`。宿主没有 shell 时，完成可用的发现与只读检查，按当前支持范围报告完整生产缺项。
3. 调用 `tools/list` 或 CLI `list`，具体调用前用 `describe` 核对 schema。`pengmanager_video_status` 是被动状态读取。`pengmanager_video_preflight` 默认检查安装，显式 `startNative:true` 可以启动本 MCP 管理的已准备工位，预检本身不会提交生成。
4. 使用 [快速指南](CODEX-VIDEO-QUICKSTART.md) 的安装验收条件，区分依赖安装、当前模型配置、真实供应商响应与最终产物。配置生成和指南读取均不调用供应商，指南返回 `providerCallsPerformed:false`，不能据此报告生产完成。

`pengmanager_agent_guide` 的返回 schema 为 `pengmanager.ai-agent-guide/v1`。固定指南不可读、被重定向或无效时返回 `AGENT_GUIDE_UNAVAILABLE`，应修复对应 checkout 后重试。

## Agent 如何执行与恢复

Agent 从指南返回的 `cli.standardVideo` 取得 Node、脚本和私有目录，使用原始意图建立输入。MCP 进程的环境不会反向传给宿主 shell，指南的 `modelEnvironment.inheritedByHostShell` 为 false。启动 MCP 时提供的合格 `--env-file` 路径会按原顺序放入 `cli.standardVideo.argsPrefix`，Agent 应使用返回的 `command`、完整 `argsPrefix` 和 `dataArgs` 执行 CLI，并将该条目的 `env` 合并进子进程环境，以继续使用同一私有目录和自定义端口。该 `env` 只含非秘密实例坐标，模型密钥与会话令牌不在其中。

没有显式环境文件时，`modelEnvironment.source` 为 `current-process-only`，owner CLI 需另由已有授权的 shell 环境取得当前模型配置。不得把 MCP 预检的配置结果当成 shell 已继承配置。`--env-file-if-exists` 不用于这项交接，文件缺失需明确处理。多个显式环境文件会按顺序交给 CLI，配置生成器只接受一个 `--model-env-file`，需为新的客户端配置明确选择合格文件。下例只展示计划，原句应替换为用户本次完整原话。

```sh
printf '%s\n' '{"intent":"用鹏经理做一支三十秒的雨夜赛道短片"}' | \
  "$PM_NODE" "$PM_REPO/scripts/video-standard.mjs" plan --input-file -
```

`PM_NODE`、`PM_REPO` 和 `PM_DATA` 由 Agent 根据当前指南填写。原话有多个秒数时，`durationSec` 只用来明确用户要求的全片总长。正式执行使用相同输入和同一私有目录，并按当前 owner 策略核验权限。

| 命令 | 用途与后续处理 |
| --- | --- |
| `start --input-file <原输入> --data-dir <原目录>` | 发起获准请求，保存返回的 `jobId` 与原生项目。 |
| `status --job <原jobId> --data-dir <原目录>` | 读取原回执及当前原生状态。当前 owner 作业路径会启动其受管原生服务进行读取，行为与 MCP 的被动 `pengmanager_video_status` 不同。旧作业按兼容回执处理。 |
| `resume --input-file <原输入> --data-dir <原目录>` | 接续符合恢复条件的原请求。先核对失败、中断、审批和费用状态。 |
| `deliver --input-file <原输入> --data-dir <原目录>` | 接续原项目的渲染与正式后期，按原任务与已有素材回读。 |

同一个私有目录同时由一个监督进程管理。如果 MCP 已通过预检启动工位，先核查没有活跃本地作业，再在原 MCP 会话调用 `pengmanager_video_stop`，读回已停止状态后启动 owner CLI。遇到其他进程占用时核对原会话与任务，禁止抢锁或终止其他进程。MCP 停止服务不会取消已发送的供应商任务。

宿主 shell 超时后保留原进程 session，并查询该进程及原作业状态。不要仅因 shell 暂未返回再次执行 `start`。收到 `NATIVE_MUTATION_OUTCOME_UNKNOWN`、未知用量或待对账状态时，沿原项目保存和核对账本。具体授权格式与恢复状态见 [本机视频制作入口](PENGMANAGER-VIDEO-MAKE.md)。

只有同项目当前文件、SHA-256、正式交付清单、媒体技术检查和实际播放结果一致时才能交付成片。内容发布另需精确账号、完整获准正文、实际平台结果与回读回执。

## 本次交付优先级

| 优先级 | 行为 | 缺少时的影响 |
| --- | --- | --- |
| P0 | 当前完整指南可发现，准确 CLI/MCP 配置可生成，Agent 使用标准 CLI 并沿原作业恢复 | 接入易指向错误 checkout，或把发现和计划误当执行，重复派发还会影响费用。 |
| P0 | 本机 owner、云站 HTTP、平台账号和发布授权分别核验 | 仓库或工具访问权可能被误用成业务审批与外发权限。 |
| P1 | 记录每次会话的指南 hash、客户端连接和只读预检结果 | 更新后难以判断实际使用的文档与运行实例。 |
| P2 | 评估完整生产的纯 MCP 异步执行协议 | 仅有 MCP 的宿主仍需移交给具备 shell 的获准本机 Agent。 |

## 本次不做的工作

- 新建生产执行器、后台轮询守护进程或通用任意 RPC。
- 自动生成 owner 审批、扩大账号权限、轮换秘密或启用真实模式。
- 为接入验收重新调用付费模型，或把演示与测试回执视作真实生产。
- 把本机私有运行时迁入云端，或在现有小型 ECS 上启用视频渲染。

接入配置与指南随 GitHub 实际主干集成后，由本机客户端使用同一 checkout 即可生效；这部分能力不需要重启云站。根云站的 systemd 服务运行 `src/server.mjs`。本次回归还修复了合法 `ART-` 素材 ID 被误报为手机号、导致运营回执拒绝的问题；该后端修复需要把同一主干版本按 [阿里云部署说明](ALIYUN-DEPLOYMENT.md) 构建、更新到网站并完成现场回读。

## 可复核依据

客户端配置行为于 2026-11-05 读取官方正文核对。Codex 来源为 [Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp)，Qoder 来源为 [CLI MCP reference](https://docs.qoder.com/cli/mcp-reference)、[IDE MCP](https://docs.qoder.com/user-guide/chat/model-context-protocol) 与 [Custom Agent](https://docs.qoder.com/extensions/subagent)。当前仓库实现位于 `src/agent.mjs`、`src/ai-agent-guide.mjs`、`scripts/agent.mjs`、`scripts/agent-mcp.mjs`、`scripts/ai-workbench.mjs`、`scripts/video-standard.mjs` 和 `src/video-runtime/config.mjs`。版本与实际产物以本次源码和回执为准。

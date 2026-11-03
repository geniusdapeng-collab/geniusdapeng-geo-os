# 从 GitHub 克隆到真实视频交付

适用于在同一台电脑上使用 Codex、其他编程 Agent 或本地 stdio MCP 客户端的人。先完成不调用供应商的本机验收，再按当前项目授权进行预生产、渲染和后期。网站控制台、GitHub 仓库权限与本机视频运行时分别验证。

## 1. 克隆并准备本机依赖

用已获授权的 Git 身份克隆。令牌由 Git 凭据机制提供，不放进仓库 URL。已有 checkout 先检查当前分支和未提交改动。

```bash
git clone https://github.com/geniusdapeng-collab/geniusdapeng-geo-os.git
cd geniusdapeng-geo-os
cat AGENTS.md
cat docs/AI-AGENT-GUIDE.md
git rev-parse HEAD

PM_REPO="$(pwd -P)"
PM_NODE="$(command -v node)"
PM_PNPM="$(command -v pnpm)"
PM_DATA="$HOME/.local/share/pengmanager/video-runtime"
PM_PG_ROOT="/absolute/path/to/postgresql17-with-pgvector"
"$PM_NODE" --version
"$PM_PNPM" --version
"$PM_NODE" -p 'require("./engines/video-edit/package.json").packageManager'
```

- Node.js 需 24 或以上。用 `engines/video-edit/package.json` 中的确切 pnpm 版本，当前内置引擎声明 `pnpm@10.14.0`。若本机只有其他版本，先安装清单所写的版本，再将 `PM_NODE` 与 `PM_PNPM` 设为真实绝对路径。安装器可通过 `PENGMANAGER_PNPM_BIN` 选择该版本的二进制或 JavaScript 入口。根仓的 pnpm 版本用于根仓开发。 [pnpm 安装与版本选择](https://pnpm.io/installation#installing-a-specific-version)
- 准备与本机架构匹配、含 pgvector 的 PostgreSQL 17 工具安装目录。将 `PM_PG_ROOT` 设为真实绝对路径。目录含 `bin`、`lib`、`share`，并且该安装自身没有指向目录外的符号链接。准备的是程序工具，运行时会复制工具、初始化本机私有数据库。
- `PM_DATA` 可改成任一源码仓库外的私有绝对路径。后续命令及 MCP 统一使用同一目录。已有目录需保持仅当前用户可访问，已有数据库和凭据随该目录一起保留。默认位置和端口见[视频运行时](VIDEO-RUNTIME.md)。

先安装无界面的核心运行时。安装使用仓库快照固定的 UI 包及锁文件，在私有依赖 store 里预热，初始化完成后停止本次启动的 PostgreSQL。安装需要访问依赖来源。无需把视频供应商密钥传给安装命令。

```bash
PENGMANAGER_PNPM_BIN="$PM_PNPM" "$PM_NODE" scripts/video-setup.mjs --core-only --install \
  --postgres-root "$PM_PG_ROOT" --data-dir "$PM_DATA"
"$PM_NODE" scripts/video-doctor.mjs --data-dir "$PM_DATA"
"$PM_NODE" scripts/agent.mjs invoke pengmanager.video.preflight --data-dir "$PM_DATA"
```

**首次安装验收**要求 core setup 退出码 0，doctor 的 `ok` 和 `workspaceInitialized` 为 true，且预检返回 `localInstalled:true`。core setup 只准备固定依赖、行业合同构建、私有数据库和工作区。正式字幕、调色、配乐、后期、封面等操作按本次合同准备对应媒体工具。需使用仓库的媒体工具安装流程时，去掉 `--core-only`，在相同私有目录用相同 pnpm 运行 `video-setup.mjs --install --postgres-root "$PM_PG_ROOT" --data-dir "$PM_DATA"`，再核对诊断和实际工具回执。某项可选依赖缺失只影响使用它的路径。

## 2. 连接 Codex 或其他本机客户端

在 Codex 打开实际 checkout，从仓库根开始工作。项目级配置依赖 Codex 的项目受信任状态。其他 Agent 若不自动发现 `AGENTS.md`，将“先完整读取 `AGENTS.md` 与 `docs/AI-AGENT-GUIDE.md`”写入该项目的启动说明。 [Codex 项目说明发现规则](https://learn.chatgpt.com/docs/agent-configuration/agents-md) · [Codex 项目配置与信任](https://learn.chatgpt.com/docs/config-file/config-advanced#project-config-files-codexconfigtoml)

仅做目录发现时，可以登记一个无供应商凭据的 stdio 服务器：

```bash
codex mcp add pengmanager-video --env PENGMANAGER_VIDEO_DATA_DIR="$PM_DATA" \
  -- "$PM_NODE" "$PM_REPO/scripts/agent-mcp.mjs"
codex mcp list
```

需要连接真实供应商时，由当前用户通过本机秘密管理器交接。如使用 Node 的环境文件，将 `PM_MODEL_ENV` 设为现有的仓库外、当前用户独占（macOS/Linux 通常为 0600）的绝对路径。仅在配置中保存路径。模型配置进入本次子进程，运行时以 `process-only` 消费。下次启动应再次提供当前配置。避免把密钥值放入 `codex mcp add --env`、TOML、聊天、命令参数或日志。GitHub 凭据、云端 HTTP Agent bearer 和视频原生身份各自适用。 [Node.js 环境文件参数](https://nodejs.org/api/cli.html#--env-filefile)

本机预检从当前进程读取文本供应商、端点和密钥（例如 `LLM_PROVIDER=deepseek`、`LLM_BASE_URL`、`LLM_API_KEY`），以及本次实际视频和图像供应商配置（方舟使用 `VOLCENGINE_ARK_API_KEY`，兼容 `ARK_API_KEY`）。检查返回的具体缺项。供应商配置与当前工作区的付费权限、套餐和价格上限分别准备。

首次登记时也可直接使用下面的真实模型环境方式。如果已登记前一个同名配置，先用 `codex mcp get pengmanager-video` 核对它，再移除本次创建的该条并重新登记。登记本身不会启动付费任务。

```bash
codex mcp add pengmanager-video --env PENGMANAGER_VIDEO_DATA_DIR="$PM_DATA" \
  -- "$PM_NODE" "--env-file=$PM_MODEL_ENV" "$PM_REPO/scripts/agent-mcp.mjs"
codex mcp list
```

其他本机 stdio MCP 客户端使用同一套启动信息。在宿主自己的配置结构中填入以下 `command`、`args`、`env`，把示例路径换成实际绝对路径。只需要发现工具时省略环境文件参数。远端 Agent 需能在持有这份私有运行时的同一受控主机上启动 stdio 进程，否则使用本机 CLI 并回传最少必要的脱敏结果。

```json
{
  "command": "/absolute/path/to/node",
  "args": [
    "--env-file=/absolute/private/path/model.env",
    "/absolute/checkout/scripts/agent-mcp.mjs"
  ],
  "env": {
    "PENGMANAGER_VIDEO_DATA_DIR": "/absolute/private/video-runtime"
  }
}
```

打开新会话或重启客户端连接后，用 `tools/list` 检查实际工具名称及 schema。Codex TUI 可用 `/mcp` 查看已连接服务器。CLI 和 MCP 使用同一私有运行时，一个数据目录同时只由一个监督进程管理。若 MCP 已启动原生服务，在工作完成、没有活跃本地作业后，先在**同一 MCP 会话**调用 `pengmanager_video_stop`，核对返回的 `status.state:stopped`，再关闭客户端或另起工作台。此操作只停止本进程拥有的服务，不能取消已派发供应商任务。客户端强制终止时，先检查本次私有实例的进程与任务状态；不要删除数据目录或终止其他服务。 [Codex MCP 的 stdio 配置和检查](https://learn.chatgpt.com/docs/extend/mcp)

也可以直接检查这个本机进程的握手和目录。下列命令无需启动原生后端。输出应包含 `pengmanager-system` 和 `pengmanager_video_preflight`。

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | \
  PENGMANAGER_VIDEO_DATA_DIR="$PM_DATA" "$PM_NODE" "$PM_REPO/scripts/agent-mcp.mjs"
```

## 3. 分开检查安装、当前配置和项目产物

```bash
"$PM_NODE" scripts/agent.mjs list
"$PM_NODE" scripts/agent.mjs describe pengmanager.video.preflight
"$PM_NODE" scripts/agent.mjs invoke growth.video.workbench.guide --data-dir "$PM_DATA"
printf '%s\n' '{"startNative":true}' | \
  "$PM_NODE" --env-file="$PM_MODEL_ENV" scripts/agent.mjs \
  invoke pengmanager.video.preflight --data-dir "$PM_DATA" --input-file -
```

`growth.video.workbench.guide` 的 `result.markdown` 是当前引擎的完整操作指南，同时带版本和 SHA-256。制作、返修或交付前读完并保存当前摘要。

MCP 对应的预检工具是 `pengmanager_video_preflight`。空输入只检查安装和当前状态。`{"startNative":true}` 在满足初始化条件且未使用外部会话时启动受管实例，并从该实例读取模型配置。`startup:setup-required` 时回到安装步骤。`external-session-configured` 表明启动环境有外部会话配置，需要另行核对目标实例。两种检查都不派发供应商任务，`providerCallsPerformed` 和 `productionVerified` 均为 false。密钥已配置、后端健康、模型在目录中可见，与供应商已受理、已结算和已收到真实媒体是不同状态。

遇到源码摘要不符、pnpm 不匹配、工具缺失、端口被占用或私有目录权限不对，按诊断修复原问题再检查。模型未配置、资格失败、费用未知或额度不足时，保留具体报错并停在有关的付费步骤前。启动/探测成功无需通过提交付费视频来证明。

## 4. 按一次真实项目推进

先冻结用户原话、人物与用途授权、商品事实与参考图权利、平台、时长、画幅、音频、字幕、封面、交付件和费用边界。已有同项目同镜头的成功源片，先核对供应商任务、项目作用域、授权、当前文件和 SHA-256，符合要求就进入后期。

| 顺序 | 实际入口 | 继续条件 |
| --- | --- | --- |
| 1. 发现与计划 | 通用 Agent CLI/MCP 的 `growth.video.production.plan`、`growth.video.production.status`。调用前 `describe` 或读 `tools/list` 的当前 schema。 | plan 预览材料，返回 `ready:false` 与 `execution:null`。status 读本地阶段账本。进入原生路径前核对当前项目状态。 |
| 2. 正式预生产与档案 | 由有权限的本机原生客户端使用 `video.studio.start`，用 `video.studio.archive` 读同一项目档案。源文件见下方导航。 | 记录真实 project/run/attempt、分流、G1 等本次前期裁决和完整镜头文件 SHA。需要模型参与的前期也计费。 |
| 3. 核对真实当前镜头 | 通用 CLI/MCP 的 `growth.video.production.shots`，输入 `{"projectId":"实际项目ID"}`。 | 当前服务来源、镜头、长度、提示词、已接受素材和项目合同一致。缩减列表不能替代完整归档片单。 |
| 4. 资格与提交 | 原生客户端使用 `video.production.qualifyShot` 及 `video.render.submit`，也可用下方正式逐镜 CLI。 | 按当前项目/镜头、模型、参数、素材、围栏、预算和人的授权判断。提交只消费当前真实资格，超时先查原请求。 |
| 5. 轮询与后期 | 原生任务读取/轮询回填，取得实际媒体资产与文件，再用正式后期。 | 非 mock，逐镜关联原 task/job、媒体资产、文件与当前 SHA。发布另行授权。 |

通用 MCP 的菜单按实际注册范围工作。当前 `archive`、`qualifyShot`、`render.submit` 和固定影片工位的 `film.start` 是原生服务入口；它们不因写进 prompt 而成为通用 MCP 工具。没有获准的原生客户端时，交接给当前本机 owner，在相应步骤保留明确阻塞。不要猜路由、构造审批数据、直连供应商补跑或把站点管理员的 bearer 当作本机身份。 [原生 Studio/渲染路由](../engines/video-edit/apps/server/src/video/router.ts) · [资格路由](../engines/video-edit/apps/server/src/video/production-router.ts)

已有前期失败时，从原档案和费用台账检查同一个项目。原生 `video.studio.resume` 只在没有活动执行、未决审批或未知费用时接续；如当前尝试尚未绑定创作合同，营销恢复需要准确的原始意图和完整 metadata。保留旧运行号和新运行号，不用新项目掩盖原失败。

单次模型窗口、项目费用和 RDAS 验收总量分别核对。原生创作在请求前按完整消息、工具与参考图占用计算 `max_tokens`，再用本项目批准的调用、总 token 与费用预占；结束后按供应商实际用量记账。RDAS 的 300,000 是专门的整轮验收限额。若容不下已核实的最坏请求预占，结果应是未派发，不应把这个额度写成模型输出配置。普通生产需有独立且明确获准的项目预算。输出截断不能通过内容验收；用量未知时保留预占并查原请求。

### 在本机工作台审核，或使用正式逐镜 CLI

需要本机网页进行人工审核时，在 core setup 之后用已核对版本的 pnpm 构建 Web，再显式启动工作台。下面以 `PM_PNPM` 指向实际 pnpm 可执行文件为例。

```bash
(cd engines/video-edit && "$PM_PNPM" -C apps/web build)
"$PM_NODE" --env-file="$PM_MODEL_ENV" scripts/video-start.mjs \
  --with-workbench --data-dir "$PM_DATA"
```

默认工作台地址为 `http://127.0.0.1:14318/ai-video/assets`，以本次启动回执为准。当前服务预生产完成后，可在 `?tab=studio` 选择服务镜头、查看模型和报价，再按围栏执行资格校验、提交和轮询。要求批准时，由有权的审阅者先在原生项目的脚本审核流程处理。服务的项目档案是原始镜头来源。已配置模型而当前工作区没有真实模型证明时，按原生模型设置流程做获准的试调，试调调用的费用计入授权范围。

有权调用同一个已运行原生实例的本机执行者，也可走服务项目逐镜 CLI。下列命令在已安装的 `engines/video-edit` 目录执行。连接参数 `WORKLOOM_API` 取已核实的本机 loopback 原生后端地址。`WORKLOOM_TOKEN` 由获准的原生客户端提供给进程，避免写进日志、脚本、CLI 参数或长期配置。若由本机程序管理运行时，应保留同一个 `runtime = createVideoRuntime(...)` 实例，等待 `runtime.start()` 成功，再通过该实例的 `runtime.nativeSession()` 把会话交给受控子进程；任务结束由拥有该实例的程序停止它。

本例的逐镜 CLI 未提供首帧或参考图参数，适用于无需显式视觉参考的任务。当前工作台可提交首帧；真实商品外观模式可使用本次 G1 采纳的规范 HTTPS 图片。需要同时绑定角色和商品原图时，由本机 owner 在私有复用 manifest 中显式选择当前 G5 合成人物及已登记的同项目商品原件，原生服务按本次 G1 来源、素材摘要及授权签发。提交使用资格回执对应的原始参考，不能用无参考图的命令代替。[AI Agent 指南第 9 节](AI-AGENT-GUIDE.md) · [商品选择 schema 和校验](../engines/video-edit/apps/server/src/video/studio-product-references.ts)

```bash
cd "$PM_REPO/engines/video-edit"
"$PM_NODE" node_modules/tsx/dist/cli.mjs scripts/tools/render-project.mts --list-models
```

先核对实际目录、已获准的本次 CNY 上限和镜头范围。以下命令可能调用付费评审和视频模型，只在这些条件已满足时执行。目录 ID 和项目 ID 分别来自前述真实返回，`PM_RENDER_SUMMARY` 是私有绝对路径，画幅和分辨率按合同及当前模型支持范围填写。只渲染点名镜头时用 `--only` 加实际镜号，避免重付已有素材。

```bash
"$PM_NODE" node_modules/tsx/dist/cli.mjs scripts/tools/render-project.mts \
  --project "$PM_PROJECT_ID" --model "$PM_MODEL_ID" \
  --aspect "$PM_ASPECT" --resolution "$PM_RESOLUTION" \
  --max-estimated-cny "$PM_APPROVED_CNY" --summary-out "$PM_RENDER_SUMMARY"
```

该入口先给所选镜头估价，再由服务从当前镜头原件签发资格，按已审请求派发并轮询入库。CLI 的报价上限之外，服务仍核对项目预算、套餐秒数、审批和来源。渲染汇总含真实 task/job 和媒体本机路径，可能含短期供应商地址，作为私有证据处理。未知回执、限流、下载失败或计费未明时，读取同一原任务并对账，不能把它当成新提交许可。只拿到预览片单时可以用正式工具的 `--dry-run --shots` 诊断文本，不能把它作为生产源。

### 用已接受原片做正式本地后期

把真正入库并验过 SHA-256 的源片按已确认镜号关联到 `<work-dir>/clips/<projectId>/<shotId>.mp4`。保留源文件及任务回执原件。将完整、已核对片单放在 `PM_SHOTLIST`，并将 `PM_WORK_DIR` 和 `PM_OUT_DIR` 设为同一私有数据目录下实际作业的绝对路径。使用 `post-only` 时，`PM_ASSEMBLY_REASON` 要记录真实原因，例如已从原生渲染入库但缺本 CLI 回执，至少 8 个字符。它不会补造前期或供应商证据。

下面是请求合成、保留原色、字幕、配乐、封面和母版的后期示例。按本次已核对的交付合同选阶段和参数，使用准备好的工具和获准的配乐。未请求或不适用的层记录原因，不因本示例额外生成。

```bash
"$PM_NODE" node_modules/tsx/dist/cli.mjs scripts/tools/full-chain-film.mts \
  --shots "$PM_SHOTLIST" --project "$PM_PROJECT_ID" \
  --work-dir "$PM_WORK_DIR" --out "$PM_OUT_DIR" \
  --keys-file "$PM_DATA/process-model-keys-only.env" \
  --assembly-mode post-only --assembly-reason "$PM_ASSEMBLY_REASON" \
  --stages compose,color,subtitle,bgm,cover,mux,master
```

后期示例只消费现有原片。缺镜头时回到当前服务任务核对，先恢复原任务。没有原生批准与可核验资格的情况下，不用固定影片工位或独立全链 CLI 代替逐镜生成。

## 5. 验证完整交付

从本次真实输出的当前发布指针和交付清单读回母版。用 `growth.video.delivery.inspect` 核对当前文件字节，再用 `growth.video.post.quality` 核对媒体与请求加工。两者先 `describe`，输入本次真实 `projectId` 与以私有数据目录为根的相对 `outDir`。`delivery.inspect` 只核对字节，技术交付看 `post.quality` 对本次文件的检查结果。显式变体时逐一核对 `publish.recommended`，包括视频、封面 SHA、时长和 `completeVideo`。普通单母版检查当前交付清单和真实母版文件。

将包含实际 `projectId` 和 `outDir` 两个字段的 JSON 保存到仓库外的 `PM_DELIVERY_INPUT` 绝对路径。从仓库根执行两项检查，确认它们读取的是同一交付根。

```bash
cd "$PM_REPO"
"$PM_NODE" scripts/agent.mjs invoke growth.video.delivery.inspect \
  --data-dir "$PM_DATA" --input-file "$PM_DELIVERY_INPUT"
"$PM_NODE" scripts/agent.mjs invoke growth.video.post.quality \
  --data-dir "$PM_DATA" --input-file "$PM_DELIVERY_INPUT"
```

重新探测与完整解码母版，实测时长、画布、帧率、音轨及字幕/封面要求。人工试看片头、中段和片尾，核对人物、产品、文字和声音。技术检查的 `complete=true` 不代替艺术审阅。最终交接可播放文件、当前 SHA-256、真实任务/资产/费用回执、封面与字幕、已采用的复用源及仍未知项。媒体清单或阶段 JSON 本身不是成片。

### 给 Codex 的任务示例

> 先完整阅读本仓 AGENTS.md、AI Agent 指南及本机工作台指南，运行不收费的安装与项目预检。以我给出的 Brief、已授权人物和真实商品资料制作一支 30 秒竖屏视频，先核对可复用的原片。前期、视频提交及后期使用仓库正式入口；每次付费都遵守当前项目的批准、报价和额度。没有获准的原生执行身份或本次资格时，告诉我实际缺失的阶段、回执和可继续完成的工作。已有 task ID 时先查该任务。最后交付真实可播放的母版、实测规格、文件 SHA、各阶段回执及仍未知的费用或授权。此次任务仅本机交付。

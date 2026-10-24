# PengManager 视频运行与工具边界

鹏经理根目录启动器管理本目录的完整原生服务、工作台与工具。引擎内的数据库、服务、SDK 和 CLI 是同一个受版本固定的工作空间；本机其它 Edit 服务和源码目录不参与运行。

## 安装、检查与启动

在鹏经理仓库根目录执行：

```sh
pnpm video:setup
pnpm video:doctor
pnpm start
```

安装需要产品指定的 Node、pnpm、Python/uv 和可复制的 PostgreSQL 17 公共程序前缀；参数与失败原因由根目录安装命令给出。安装器只复制 PostgreSQL 的公共程序、库和扩展，不复制其它实例的数据、密码或用户。启动前逐文件校验内嵌源码快照，发现缺失或改动就停止该视频运行实例并报告原因。

macOS 默认持久目录是 `~/Library/Application Support/PengManager/video-runtime`；其它系统与显式数据目录由根目录配置模块决定。它持有自身的数据库数据、角色口令、JWT 签名材料、工具安装、模型、工作产物和运行回执。秘密文件采用私有权限，供应商模型密钥只进入当前进程。安装器在自己的缓存目录使用固定的公开依赖源；不会读取用户 npm 配置或复用旧工作站 token、声音档案或授权。

原生工作台通过独立本地地址打开，拥有其原有页面、路径、媒体接口和权限。启动桥只为当前产品所属的真实 owner、租户与工作区建立会话；它不接受外部传来的任意身份。向导依次检查模型连通、业务档案、当前装配、岗位、技能、围栏和默认行业包。仅看到进程健康或曾经的激活字段，不代表当前可以正式经营。进程重启后需要重新提供密钥并重新验证当前连接。

## 生产能力与工具

| 能力 | 实际入口 | 运行条件 |
|---|---|---|
| AI 图片和视频 | 原生视频工位、媒资、制作 worker、`scripts/tools/full-chain-film.mts` 与视频 SDK | 当前供应商账号、正确模型、真实素材资格、预算和审批；本地安装不等于供应商已经调用成功 |
| 通用与口播精剪 | 原生工作台、`scripts/tools/edit-*.mts` 与 `bundles/video-edit` | 本地 FFmpeg、媒体输入、ASR；需要模型的理解和创作步骤使用当前已验证连接 |
| 合成、图层、文字和封面 | 六桥执行注册表中的视觉桥、`visualread.*` 和 `visualwrite.*` | 随产品分发的固定 Compositor headless 程序及独立 loopback 桥；图像生成与视觉评审另需供应商 |
| 配音与 ASR | 原生 voice 服务、配音桥、MLX 音频服务、CPU LoomMate | 目标自己的 Python 环境及固定公开模型；真人声音克隆需要对应声音档案的明确授权 |
| 白板片 | `video.whiteboard`、`scripts/tools/whiteboard-film.mts` | 随产品的白板渲染代码、自有 Python 环境、旁白和合法输入素材 |
| 口播解说片 | `video.explainer`、`scripts/tools/explainer-run.mts` | TalkCraft 固定公开源码、运行依赖与浏览器；商业用途须真实 `LICENSE-GRANT.md` |
| 后期和交付 | 调色、BGM、字幕、后期桥及现有 `edit:post`/封面/返修 CLI | 独立端口、自有工具 token、合法媒体和字体；每步保留产物与校验回执 |
| 岗位、技能和围栏 | 原生岗位、向导与行业装配；完整目录 `pengmanager-capabilities.json` | 声明、代码存在、依赖就绪与真实产出分别核验；未接工具返回原生未核实状态 |

目录由实际四个行业包、全部岗位和技能文件、连接器工具白名单、现有能力声明与源码引用生成。它保留唯一跨包技能引用的解析记录，并列明仍缺失的绑定；不会用名称匹配制造一个执行实现。AI 供应商是配置项，通过原生向导接通，不提供虚假的安装命令。

## 工具复查和失败恢复

工具主管入口是 `scripts/pengmanager-tools.mjs`。它返回每项安装、进程和健康状态，并在内存中向原生后端注入执行模块与随机 token。命令行输出会剥离该秘密环境。

```sh
# 在本目录运行；独立命令用于修复安装，普通产品入口仍在仓库根目录。
node scripts/pengmanager-tools.mjs status
node scripts/pengmanager-tools.mjs setup --tool voice
node scripts/pengmanager-tools.mjs setup --tool talkcraft
```

安装失败会保留明确的失败步骤；下次只重试指定步骤，其它步骤的记录保留。安装状态和运行状态独立，Python 文件或 bridge 进程存在不足以判定对应模型就绪。启动发现外部端口被占用时报告冲突，不连接或终止该外部服务。停止只清理本主管创建的进程组；取消后不会继续晚到的子进程启动。重复启动复用健康的自有进程，替换健康检查失败的自有进程。

Compositor 分发的是 `vendor/compositor-kit/PINNED.json` 记录的已授权本地 headless 制品，当前机器不具备官方完整 GUI 所需的较新系统/Xcode，故不声称已在此机编译官方 GUI。MIT 许可与程序 SHA 保留；headless 适配器的原始构建源码在当前受控材料中缺失，复现边界已写入 pin。

TalkCraft 安装期匿名拉取固定公开 commit，不把其受限源码提交进产品仓库。运行依赖和浏览器安装在产品私有目录。默认非商业评估状态不代表商业授权；商业使用缺少真实 grant 时保持阻塞。重新安装只原样保留已经存在的 grant，不创建或替换授权内容。

真实声音克隆、图像或视频供应商调用、账户发布和收费额度都由原生链路再校验。工具安装与本地烟测记录不能当作客户任务交付、真人同意、平台已发布或供应商零费用的证明。

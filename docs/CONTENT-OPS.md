# 28 个内容运营师：准备、制作与审核

本文面向本人、获准管理编辑资料的人，以及接手本仓库的 Agent。使用前完整阅读
[AGENTS.md](../AGENTS.md) 与 [AI Agent 指南](AI-AGENT-GUIDE.md)。本文描述当前源码的实现；
目标网站、电脑上的工位进程和拉取的代码是否相同，须分别核对。

## 能完成的工作

后台的“内容运营师”提供 28 个岗位、准确母版计划、真实源文件、目的地规则、工单、
独立终检、预算与本机工位。岗位共用已批准事实，各自保留读者任务、原生成品、编辑策略、
润色清单及允许的 AI 操作。岗位目录存在不代表账号已配置、已经登录或获准外发。

三个常用场景：

1. **一篇文章给不同读者看。** 选择不可变原文修订、LinkedIn 与个人官网等真实目的地，
   分别选择语言与形式。跨语言／形式先建立共享的中立转换，再各自产生独立渠道包。
2. **把实际素材做成平台作品。** 上传真实源视频、图像、字幕、代码、数据或 notebook，
   完整预览并审阅使用权。图文、文档或剪辑适配器产生实际文件；没有实物时保留具体缺项。
3. **同一成品检查、修改并交付。** 独立检查者阅读最终文字和真实附件，最终包、报告与人审
   共同绑定；人工修改的真实修订可通过 API 形成限定账号、目的地、语言的风格候选，单独提升或回滚。
   当前后台没有专用的风格候选表单，具体接口见 [HTTP API](API.md#content-operators-and-private-worker)。

本期不会自动发送社媒内容、登录第三方账号、运行 notebook、部署 Demo、训练／推理模型，
也不会从任意计划执行 shell、下载 URL 或扩大原生工具权限。固定视频适配器处理已授权源片，
AI 视频生成继续使用独立的[完整视频引擎](VIDEO-RUNTIME.md)。技术作品的说明和实际作品分别保存。

## 从后台开始

1. 在“编辑出版”建立真实选题和完整母版，核对其 Claim。运营准备引用的事实须已批准公开、
   未过期且低敏感；私有资料不能为方便生成而假改成公开事实。
2. 核对具体账号及目的地。去“真实来源与规则”保存本次实际读过的规则、来源、有效期和
   允许的 AI 操作。岗位、目的地规则与预算授权取共同允许范围；新规则不会使旧批准自动有效。
3. 按需要登记真实作者原稿。公众号等作者主导流程、限定校对流程与相应社区消息需要真实的
   作者贡献对象，单独勾选“已人审”不能代替原稿。
4. 上传真实源文件，选择所属选题、用途与真实 MIME。查看完整预览／实际文件，再分别核对
   来源与使用权、隐私及许可。附件审核与媒体域审核是独立步骤；导入媒体后仍需完成媒体审核。
5. 在“建立准备计划”选择准确母版、目标、语言、原生成品及本次使用的已审源文件。
   生成计划只生成数据；随后单独校验。也可导入完整 UTF-8 AdaptationPlan JSON。
6. 阅读服务端校验结果及全部缺项。预算为空时只能保存 `blocked_budget` 工单，不会派发。
   补预算须重新引用实际授权并校验新计划；旧工单及其未知预留保留。
7. 工位实际就绪且云端、本机权限一致后，才领取并逐步执行。准备结果进入独立终检；终检
   未覆盖的媒体不能被文字模型的自述补成“已看过”。
8. 在“工单与成品”阅读完整最终包、顺序、附件、全部报告及问题。通过后创建的是私有草稿。
   在“编辑出版”再次完整审核准确快照，批准与排期；外发仍需独立的单账号动作授权。

没有对应目的地、材料、规则、作者贡献或可用工位时，界面保留原因。`needs_input`、
`blocked_budget`、`needs_reconcile`、`skipped` 均不能计入成品或发布成功。

## 源文件与实际产物

管理员的源文件入口不依赖先建工单，因此不会出现“建工单要素材、传素材要先有工单”的循环。
源文件明确记录 `origin: administrator_upload`、所属 Story 和 sourceUploadId，`taskId` 与
`attemptId` 为 null。工位产物则必须绑定真实 task、attempt、epoch、输入摘要与 outputKey。

单文件上限 50 MiB；私有 ART 存储总额默认 500 MiB，计入未登记的中断文件。写入使用
独占创建、真实字节 SHA-256、同步与不可变对象；不允许上传路径或覆盖旧文件。同一上传请求
恢复时仍读取并核对本次完整请求体。上传中途父选题变化只保留私有字节，不提交错误关联。

| 用途 | 支持的实际材料与边界 |
| --- | --- |
| 图片、视频 | PNG/JPEG/WebP、MP4；按真实容器与字节验证，媒体引用另需媒体域审核 |
| 文稿、字幕 | UTF-8 文字／Markdown、VTT/SRT/纯字幕 ASS；字幕时间轴不由脚本文字冒充 |
| 源码与差异 | 被动源码、Markdown、JSON、diff 及受限 ZIP；不会执行或解压到项目目录 |
| 数据与 notebook | CSV/JSON、notebook v4 静态预览；富媒体输出受限，不运行单元格 |
| 权利资料与日志 | 实际文字、JSON、被动 PDF 等；是否覆盖本次使用须真实审阅 |
| 模型权重 | 有界 Safetensors 字节对齐子集，最多 1 MiB 文件头、4,096 个头字段、16 维；不加载模型 |
| 文档与音频产物 | 被动 PDF、PCM WAV；不因格式校验通过而声称已完成视觉或听觉验收 |

Safetensors 当前接受 F16/F32/F64、I8/I16/I32/I64、U8/U16/U32/U64，校验真实非空张量、
形状与字节长度、连续无重叠偏移及完整缓冲区。BF16、BOOL、亚字节类型等返回明确不支持。
这是本产品的受限附件合同，不表示完整支持上游全部类型或大模型文件。
格式依据：[官方格式说明](https://github.com/safetensors/safetensors#format)。

原生形式包括 article、image_text、video、thread、document、repository_change、model_card、
dataset_card、notebook、demo_bundle 和 community_message。每个岗位仅接受自己声明的形式。
模型卡需要真实权重及许可，数据卡需要真实数据及许可，notebook 需要实际文件，仓库变更
需要准确仓库和 baseCommit；说明文字、一个现存 Story ID 或一个“已运行”布尔值不能代替这些材料。

## 本机工位与双端权限

这是主动连接云端的独立工位，不开放本机公网端口，不接收管理员 Cookie 或旧受限 HTTP Agent
令牌。供应商密钥只保留在工位进程。云端配对范围与本机 owner 授权共同约束 origin、worker、
workspace、project、job、target、固定适配器、有效期及资源上限。云端通过准确 job 引用该工单
的预算；本机授权还直接绑定 budgetAuthorizationHash。界面模板只接受使用同一准确预算的工单集合。

先发现真实绑定和缺项：

```bash
node scripts/content-ops-worker.mjs --help
node scripts/content-ops-worker.mjs bindings
node scripts/content-ops-worker.mjs doctor --config /absolute/private/worker.json
```

`doctor` 不调用供应商。`bindings` 返回固定适配器版本与源码闭包摘要；`doctor` 返回
各适配器实际 ready、原因、proofHash 与 productionVerified，验证字体及运行依赖。
没有模型配置、可核实的 token 上界、价格快照、字体、运行时或真实源文件时，不宣称就绪。

当前固定 FFmpeg／FFprobe pin 只在 **darwin-arm64** 上验证。`image.compose` 实际完全解码
RGB／RGBA PNG，源文件入口可保存 JPEG／WebP 并不表示该适配器可以合成这些格式。
`caption.align` 从真实 VTT／SRT 时间轴产生 VTT；styled ASS、翻译／双语字幕没有准确、
已验证的定时译稿时阻断。`voice.speak` 明确返回未就绪：当前没有启用独立分段授权与计费合同。

配置与本机授权文件须在仓库之外，普通文件、本人所有、私有权限；工位数据目录同样在仓库
之外。配置不会接受内嵌供应商秘密。完整字段由 CLI 校验：

- 配置 schema 为 `pengmanager.worker-config/v1`，包括 origin、workerId、dataDir、grantFile；
  可选固定 model、renderer、media 配置及本人明确登记的本地源文件白名单。
- model 的实际字段为 endpoint、provider、model、contextTokenLimit、contextProof、
  pricingSnapshotHash、currency、maxOutputTokens、timeoutMs。contextProof 包含
  kind:`provider_documented_context`、sourceUrl、sha256、verifiedAt；来源与上下文上界须实际核实。
  模型密钥不在 JSON 中。
- 授权 schema 为 `pengmanager.worker-local-grant/v1`；包含准确范围、adapterBindings、scopeHash、
  budgetAuthorizationHash、expiresAt、limits、roles、ownerConfirmed 与 localGrantHash。
- `ownerConfirmed` 必须由本机真实授权核对，不能由云端计划或模型自行改成 true。
  `grant-hash --grant /absolute/private/local-grant.json` 计算准确授权摘要。
- 云端 grantId 是配对回执，不属于本人可随意变更的 scope；原请求恢复时保留相同挑战、
  scope 与本机授权，遇结果未知先回读，不能另建凭据重复执行。

配对页面可先“读取准确工单”，再下载不含秘密的 local-grant.json 与 worker.json 模板。
模板保持 ownerConfirmed:false，不含 localGrantHash、挑战或令牌。移到本人私有目录、核对
所有范围与绝对路径、设置 0600 后，只有本机 owner 实际同意才改为 true；用 grant-hash
计算并加入摘要。模型任务先通过受保护的 CONTENT_OPS_MODEL_API_KEY 进程变量提供模型密钥，
再运行 doctor；doctor 不发供应商请求。本次任务所需的适配器就绪后才交接独立工位令牌与
一次性挑战的进程变量、执行 pair 和 run。

以下环境变量经受保护的会话／秘密管理器传给进程，不把实际值写入 JSON、命令参数、日志或截图：
`CONTENT_OPS_WORKER_TOKEN`、`CONTENT_OPS_MODEL_API_KEY`、一次性的 `CONTENT_OPS_PAIRING_CHALLENGE`。

```bash
node scripts/content-ops-worker.mjs pair \
  --config /absolute/private/worker.json \
  --challenge-id FROM_ACTUAL_PAIRING_RESPONSE --confirm-local-owner
node scripts/content-ops-worker.mjs run --config /absolute/private/worker.json
node scripts/content-ops-worker.mjs status --config /absolute/private/worker.json
```

`--watch` 显式持续领取；默认单次。独立 checker 使用独立 worker 身份及本机授权，不能由
同一生成者签自己的终检。`--recover-stale-lock` 只在原进程确已退出时恢复自己的日志锁，
不会清除未知调用、改变 epoch 或重发供应商请求。

变更固定适配器源码后必须重新启动工位。运行中重算源码闭包，发现变化会停止后续调用；
不会用新磁盘 hash 冒充已经载入的旧 ESM 实现。已有 task／blueprint 不原地改 hash。

## 预算、取消与恢复

预算授权固定 name、currency、deadlineAt，以及 maxCalls、maxInputTokens、maxOutputTokens、
maxPerCallInputTokens、maxPerCallOutputTokens、maxInFlight、maxCostMicros、maxRenderSeconds、
maxTempBytes、maxNativeProcesses。价格快照保存供应商、模型、币种、单位、覆盖的计费维度、
实际审阅时间、有效期与官方来源；不能把估算金额当已付账单。

每次底层请求先持久预留，再派发，包括策划、转换、起草、翻译、检查、每次返修、润色、
最终检查及本地原生进程。最后一份额度以短事务竞争，只有一方成功。
没有可核实的上界或有效价格不派发；静态计划和未就绪诊断不消耗模型额度。

供应商返回 token 用量仍不等于实际账单金额。无法核实的 actual 为 null，最坏预留保留；
`partially_settled` 与 `unknown_usage` 分别显示。管理员核对必须逐项绑定原 reservation、attempt、
供应商请求、单位、币种和证据；不能用一句“零费用”清掉未知金额。

本机日志先记录派发意图；云端同一 dispatch 回读返回 `execute:false`，不能再次调用供应商。
网络中断、进程退出、重启、取消、撤权、到期或旧 epoch 返回均不会抹掉未知费用。
已成功文件可用原摘要恢复上传；迟到字节留在私有隔离区，不自动激活下一步。
恢复用量不等于恢复未知的制作结果，更不等于外部平台已成功。

## 最终包、人工审核与发布

最终包冻结准确标题、摘要、正文、全部有序块、媒体顺序、真实 ART 文件、原生设置、
作者与事实来源、账号／目的地身份、规则／风格版本、计划及 blueprint。
`packageHash` 绑定完整包，`reviewSnapshotHash` 同时绑定准确包、最终报告集合和检查上下文。

终检分别报告确定性合同、事实／语义、媒体完整覆盖与表达质量。报告必须由独立授权的
实际检查尝试或明确的独立管理员检查产生，绑定准确包和实际执行证据。文字模型读取完整
文字与支持的静态附件；未真正检查图像、视频、音频或 PDF 时，媒体仍为 unverified，
需要逐附件的实际完整阅读／播放证据。初检或终检的 blocker／major 不能被最终润色抹掉。

`materialize` 只创建私有 draft。v3 内容批准必须同时提供准确 snapshotHash 与
reviewSnapshotHash；批准／排期、创建／批准／开始／完成运营动作时重新核对当前来源、
规则、权利及实际文件字节。更换正文、附件、顺序或目标需新包与新终检。

外部回执继续核对原来的 editorialSnapshotHash 与全部 MED assetHashes；v3 还必须提供
原 packageHash、reviewSnapshotHash 和全部 ART artifactHashes。超时恢复沿用原结果与原回执，
不会再次发送。历史结果调和保留原批准和完整包，不用当前已变化的资料替代当时的授权。

个人官网仅承载 article／image_text／video 原生包，并且额外经过独立公开快照批准、真实
完整备份、激活与本站真实回读。`live_unverified` 必须完成 verify，才能记为发布验收通过。
受限 Discord 等目的地在专用可见范围回执未提供前，不能借用公开 URL 完成流程。

## 迁移、备份与数据边界

启动先完成原有编辑迁移，再进行 schema 2→3 加法迁移。迁移前实际备份准确旧状态、全部
媒体与已有原生附件；事务再次比对 revision 和状态字节摘要，竞态变化时要求重新备份。
旧集合、自定义对象、原事件前缀、旧审批及 v1／v2 snapshot hash 保留。重启不重做迁移。

```bash
node scripts/editorial-data.mjs plan-content-ops \
  --state-file /absolute/private/state.json --origin https://pengmanager.com
```

`plan-content-ops` 只读预检；离线实际迁移用相同参数的 `migrate-content-ops`，由 CLI 执行真实
完整备份。正常应用启动也完成相同备份闸门。状态文件只允许一个可写进程。

完整编辑备份 manifest v2 包含所有注册 ART 文件及隔离证据、工单、租约、重试、规则、风格、
报告、授权与未知费用；旧备份格式继续接受。恢复只写入不存在的隔离目录，并再次核对实际
文件集合、字节长度与 SHA，禁止覆盖在线 DATA。完整主机恢复还要包含 GEO SQLite、配置、
本机工位私有日志与独立视频 PostgreSQL；Mac 定稿副本不能替代完整备份。

v3 接受新写入后，旧二进制应拒绝该状态。不能用降级代码、删除新集合或清空未知预留来回滚；
保留真实完整快照并向前修复。

## 接口与故障处理

管理员接口位于 `/api/content-ops/*`，独立工位位于 `/api/content-ops/worker/*`。
所有 JSON 写入使用严格 UTF-8 JSON、1 MB 上限、无重复键、封闭 schema、真实引用与幂等键；
修改既有对象同时带准确 If-Match。具体入口见 [HTTP API](API.md#content-operators-and-private-worker)。

| 情况 | 操作 |
| --- | --- |
| 来源／规则／身份变化、412 | 重新读取准确对象与全文，重新校验计划／报告，不改旧 hash 过关 |
| 缺素材／作者／时间轴 | 补真实材料及使用审核，或保留 needs_input／skip 原因 |
| 预算／价格／工位未就绪 | 保存明确阻断状态；不调用供应商、不伪造就绪 |
| 上传中断／重复请求 | 保留原幂等键与相同完整字节；冲突文件不覆盖 |
| 已派发结果未知 | 停止后续制作，核对原请求及费用；不盲重试 |
| 终检 unverified／major | 阅读完整报告，补真实检查证据或创建受限新修订，保留原包及报告 |
| 平台结果已存在、回写失败 | 回读原对象，重试准确回执或使用管理员历史结果调和，不重发 |

代码精读说明的是实现边界（A）；隔离单元／HTTP／真实本机媒体测试是对应执行证据（B）。
真实供应商费用、外部账号状态、生产部署与发布结果仍须各自现场核实，不能从测试夹具推断。

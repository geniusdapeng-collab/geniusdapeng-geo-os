# 平台策划进入二次生产：集成设计

> **文档状态：研究／设计归档，新增员工能力尚未实现，待产品方案对焦。** 这是 2026-10-25 同次研究的完整正文晋升。研究所分析的代码基线是 main `4e521c6f9645d7ddde29aae27b0df24bc7610e2e`；正文中的覆盖率、历史动作和验收结果属于原作者的该次研究，不是本次文档发布后的新运行回执。文档进入仓库不创建岗位、compiler、worker、接口、模型任务或外部发布权限。
>
> 原文标为 JSON、provenance、原始抓取、缓存、独立审阅回执的文件名／目录名，均保留为**原研究取证标识**；它们未随本文入库，不是当前仓库文件或可点击下载。公开来源 URL、取得范围、证据 A／B／C／D 和样本访问缺口完整保留。仓库代码路径相对本仓库根目录。本文仅改正原工作区绝对路径／临时路径的可移植表达，并清理原文尾空格，未删减研究正文。
>
> 原始正文取证标识：`platform-secondary-production-integration.md`；SHA-256：`fe23540743d4e0bb4abf3e242c7b1d2d5dd8d60d89ac3245fe6d5e8da8c6c970`。早期产品矩阵为概要；平台限制以三组档案中明确支持的官方来源范围及执行前重新核实的规则为准；编译／执行的详细合同见二次生产集成方案。原文拟议 API、类型与验收仍为 D 级，实际可调用接口见现有接入指南和 API 文档。

三组研究中的 AdaptationPlan／toolTask 字段属于**岗位需求的语义规格**；涉及精确 schema／API、静态编译蓝图与运行期输入 hash、worker 与管理员分工时，以[二次生产集成方案](PLATFORM-SECONDARY-PRODUCTION.md)第 4—9、11 节为本批文档唯一的后续设计合同。旧字段、旧接口或通用自动准备措辞不并行实施；早期 priorOutputHashes 等语义需求须按该合同分别映射为编译期逻辑依赖和运行期 resolvedInputHash，不能把未来产物／package／终检 hash 回写静态蓝图。研究中的 review／receipt／productionTasks 等语义展示不定义最终哈希载荷；最终以 PublicationPackage → 包外 QualityReport → ReviewEnvelope 及静态 blueprint／运行期 input 的分离为准，旧示意不得把报告、approval 或未来产物 hash 塞回包或蓝图。历史研究中的“需补能力”清单也不表示本期 worker 已纳入；本期 allowlist 与不做项以最新集成为准，例如 notebook 仅静态预览、executeCode:false，不运行单元格，隔离执行需另立实施授权及验证合同。研究中的 documented_cli／参考 command 示例是历史或人工正式 CLI 说明，不是 worker 可执行清单；worker 只能从最新集成的固定 adapter 投影编译任务，不能回放 production.plan 返回的命令。该优先序说明不把任何设计变成已实现接口。

[A 组研究](platform-research/group-a.md) · [B 组研究](platform-research/group-b.md) · [C 组研究](platform-research/group-c.md) · [产品与岗位方案](CONTENT-OPERATORS-DESIGN.md) · [二次生产集成方案](PLATFORM-SECONDARY-PRODUCTION.md) · [AI 接入指南](AI-AGENT-GUIDE.md)

<!-- promoted-source-body:start -->
## 覆盖率声明

- 本集成设计限定的输入文件共 **62** 个：精读 **A＝51**，完整结构／元数据解析 **B＝8**，选段阅读 **C＝3**，范围内整文件未读 **0**。完整路径、读取范围、行数与 SHA 在 `原研究取证标识：platform-secondary-production-read-provenance.json`。先前 40 个文件的完整读取留痕经当前哈希复核保留，恢复后继续读取其余相关文件，没有重做整个仓库审计。
- 其中 **57 个仓内文件**的当前 SHA256 与字节数均与正式 main `4e521c6f9645d7ddde29aae27b0df24bc7610e2e` 的部署 manifest 一致（B）。manifest 自身 SHA256 为 `d0fc40ada30f2831fd3b0207350a155efbfe9a3f4c760a7612a2fac0129086af`。本子任务没有调用 Git，也没有将其他代理的 Git 回执冒充本代理的操作。
- 三个 C 级大文件：`post-bridge/core.mjs` 5,247 行中选读 541 行；`subtitle-bridge/core.mjs` 3,548 行中选读 332 行；`voice-bridge/core.mjs` 1,609 行中选读 215 行。合计 **1,088 行选段，9,316 行未作语义精读**。选段行号登记于 provenance；其跨调色、音频、字体、供应商等传递依赖没有全量审计。原因是本次只提交集成方案、不改引擎、不启用执行。它们只能支持明确选段结论，不能据此授予 ready。
- 三组平台研究 JSON 采用全量解析 B，并阅读与本合同有关的政策条目；本稿没有声称再次全文复核三组 28 份研究。A10 已另经独立全文复核，凭据为 `原研究取证标识：platform-a-independent-review.json`。研究原始内容、规则时效和样本缺口继续按各组档案保留。
- 证据分级：**A**＝完整精读当前代码／文档；**B**＝完整结构解析、manifest 比对或同次官方研究记录；**C**＝明确选段；**D**＝拟议设计、假设或未验证。本稿所有新增类型、集合、接口、worker、任务、费用控制与验收均为 **D：尚未实现**。

# 平台策划如何进入鹏经理的二次生产与审核链

建议采用 **平台岗位输出受约束的 AdaptationPlan → 鹏经理导入与编译 → 本机生产 worker 领取固定任务 → 上传真实产物 → 不可变 Edition／Variant／原生包 → 独立终检 → 人工完整审核 → 独立运营授权 → 真实回读**。平台岗位负责判断、策划与编辑，编译器决定可执行任务，现有视频／视觉工具承担匹配的实际加工。平台岗位输出的命令、工具名或“已完成”声明都不直接取得执行权。（D）

这份设计补的是“研究和策略怎样变成现有系统里的真实成品”。它延续原 308 行岗位方案中的最终包／终检／审批绑定、预算未知预留和跨形式追溯，增加实际源码衔接、受控导入、编译与本机执行合同；没有先行创建 28 名运行员工或改动生产系统。（D）

## 1. 给谁用与最小使用流程

使用者是本人及明确授权的管理员；内容仍以本人真实的 AI／产品／工程实践为主。日常操作是：选择准确母版修订和真实素材、勾选相关目标、阅读每个平台的策略、确认本次准备范围和预算；后台完成有权限且有输入的准备步骤；随后审核每份完整成品。目标不是把每篇内容凑成 28 份，而是让选中的每份目标都有成品、明确跳过理由或可补齐的阻塞项。（D，产品假设）

三个核心场景对应三种实际收益：（1）公众号与小红书共用事实、分别组织文章和图片卡，减少重复编辑而保留真实作者参与；（2）一份真实演示分别形成哔哩哔哩与 YouTube 的语言、节奏、封面与字幕包，避免把脚本当成片；（3）一次软件交付先核实 GitHub／Hugging Face／魔搭／Kaggle 各自需要的真实作品，再准备与作品相符的说明和文件，避免为凑渠道虚构模型、数据集或运行结果。第 10 节逐一给出任务、产物、阻塞与交接。（D）

P0 容量假设：单管理员，单工单 1—28 个目标键；同一平台可有不同账号／目的地，但每个目标独立冻结；模型并发上限提议 2，本机重型渲染并发提议 1。正文、图片数、视频时长采用目的地当次核实的规则快照，不把公开样本或旧目录写成永久平台限额。本次没有吞吐、时延或费用实测。（D）

## 2. 已有接点与不能直接跨越的边界

以下代码路径相对 本仓库根目录；函数名可直接定位。表中的限制是现状，右栏是 D 级拟议衔接。

| 已读现状与证据 | 新链的具体处理 |
| --- | --- |
| **A** `src/agent.mjs` 与 `scripts/agent.mjs` 组合原生目录及两个鹏经理视频只读入口；引擎 `agent-capabilities.mjs` 执行目录中的受控 transport。**B** 原生是 core 8＋growth 16＝24 个目录项，另加 2 个鹏经理入口。 | 原生发现面仅作为发现、状态、指南、预览和技术回执；不把大目录 334 个工具当成已经开放的 MCP。 |
| **A** `growth.video.production.plan` 的 `productionPlan` 返回 `previewOnly`，并产生参考 CLI 建议，其中有 `--review-policy off`；ready 是清单检查，不证明真实出片。 | 仅采纳经过验证的标题／项目／目标等数据字段。完全忽略返回的 command、argv 和执行建议；新编译器重新生成固定任务，终检不能被 plan 关闭。 |
| **A** `deliveryInspect` 校验交付文件和指针，仍返回 complete:false／technical unverified；`post-quality.mjs:deliveryQuality` 调用技术闸，艺术质量 unverified。 | 文件存在、技术通过、语义通过、艺术通过、人工批准、发布回读为不同字段；technical passed 不变成所有维度 passed。 |
| **A** `EditorialService.createEdition` 的 `sourceEditionId` 只允许同 Story、同 format、另一 locale；`createVariant` 继承 Edition 的 locale／format。 | 文章→图文／视频新增显式 `derivedFromEditionIds`／`formatLineage`，不能偷用翻译字段，也不能只改 Variant 的 format。 |
| **A** `EditorialService.#write` 与 `routeEditorialApi` 拒绝 `method:'agent'`；现有受限 HTTP Agent bearer 无权读／写整套编辑接口。 | 增加独立、窄范围 worker 准备接口和 principal；保留旧 bearer 的 403。不能把 worker 假装成 session 管理员。 |
| **A** `MediaAssets.upload/review/openVerifiedAsset` 支持 PNG、JPEG、静态 WebP、MP4、纯 VTT；默认单资产 50 MiB、总额 500 MiB，VTT 1 MiB；先上传再审核权利与隐私。 | 本机中间文件不直接变为公开素材。PDF、SRT／ASS、WAV／MP3、ZIP、代码、notebook 需要新附件合同；没有合同就导出待人工或阻塞，不改扩展名冒充媒体。 |
| **A** `AccountOperationsService` 的编辑动作绑定准确 editorialSnapshotHash 与全部 assetHashes，需分别批准／开始；不确定结果通过受控 reconcile 核对。 | 原生新包增加明确 v3 快照分支，动作继续独立授权；worker 没有外发权限。 |
| **A** `website-readback.mjs` 对受保护官网 origin 的 JSON、初始 HTML、完整资产字节作真实核对；`EditorialService.publishRelease` 有备份和路由比较交换。 | 官网继续现有公开候选→独立批准→完整备份→激活→服务端回读；本机制作成功不跳过此链。 |
| **A** `JsonStore` 和 `services/bootstrap.mjs` 只接受 schemaVersion 1／2；单写者锁、串行 mutate、事件链。`editorial-backup.mjs` 同样只接受 1／2、备份 JSON 与注册媒体。 | 新业务集合与附件必须显式迁移到 v3，同时升级完整性、备份、恢复和旧程序拒开门禁；没有现成 SQL 表或 SQL 索引。 |
| **A** `DeepSeekAdapter.generateContent` 以中文 300—800 字、title/body/hook/cta/hashtags 为旧接口合同，有 1,400／4,000 两次内部请求循环，最终仅返回最后 body 的 usage；`LivePipelineService.generateContent` 保存旧 content。 | 不能用它直接实现多语言原生包和硬预算。新增单次请求受控适配器，或把每个底层网络请求显式纳入 attempt；不能只在旧方法外层扣一次额度。 |
| **A** `LivePipelineService.publishContentToGitHub` 明确拒绝含 snapshotSchema／editionId／destinationId 的编辑稿。 | 不借旧 GitHub issue 发布入口发送新稿；作品说明准备和实际仓库写入／release 分开。 |

现状冲突的结论：已有内容域适合继续负责事实、不可变稿、媒体、审核和运营回执；已有视频／视觉域适合做限定加工。缺少的是两个域之间的正式计划、实际执行适配器与可信结果导入，不是另造一个可以任意调用系统工具的万能 Agent。（A：现状；D：选择）

## 3. 架构候选与选定

| 候选 | 具体形态 | 优点 | 成本、风险与前提 |
| --- | --- | --- | --- |
| A：鹏经理云端直接执行所有模型和媒体工具（D） | 云端 HTTP 请求中调用各工位、保存临时文件，完成后直接建稿。 | 调试路径较短，无本机任务同步。 | 生产存储／管理权限与工具执行耦合；媒体依赖、算力、私有原素材和本机登录状态需迁移；长请求和重试难恢复；当前 `ENABLE_MEDIA_RENDER=false` 时云端渲染被显式拒绝（A 条件行为）。不适合直接扩成任意脚本执行器。 |
| **B：鹏经理受控导入／编译＋本机出站领取任务的 worker（选定，D）** | 云端保持单写者账本、不可变计划、DAG、预算及审核；本机只领取经编译和本机批准的任务，调用固定适配器，上传限额内的结果。 | 复用本机素材与已安装工位；云端不保存本机供应商凭据；可独立恢复、核对费用、逐目标失败；与当前存储／审核链衔接清楚。 | 要实现 worker 配对、任务租约／fencing、双端权限、私有文件运输、实际适配器和预算账本。不能只加一张目录和按钮。 |
| C：平台岗位直接在 Codex／MCP 调用全目录，然后回填“完成”（D） | 每个平台自由选择 334 工具、执行返回的 CLI，事后填写回执。 | 初次演示快，策略自由。 | 发现面与执行面混淆；计划可注入命令；最终产物／费用／外发权限难统一；重启和超时不明确。仅适合人工受控研究，不能充当生产协议。 |

选 B。本机 worker 采用向已配置 HTTPS 鹏经理 origin 发起的出站连接；不要求向互联网开放本机端口，不由云端 SSH 进入 Mac。已有本机服务若需本地鉴权，由本机固定适配器使用现有受控凭据；凭据、浏览器 cookie 和声音档案不上传。分布式“恰好一次”不能靠租约承诺，设计采用持久尝试、业务幂等键、单次派发与未知结果核对。（D）

## 4. 正式计划合同与安全导入

`AdaptationPlan` 是数据，不是脚本。以下是本产品拟议类型；不是声称现有原生 schemaIssue 支持全部验证。当前 `agent-capabilities.mjs` 校验器只覆盖若干 type／enum／required／additionalProperties 等分支，不能拿它代替完整的计划交叉引用和业务验证。（A／D）

```ts
type Sha256 = string; // 服务端实际验证 /^[a-f0-9]{64}$/
type Locale = "zh-CN" | "en-US";
type EditorialFormat = "article" | "image_text" | "video";
type NativeForm = "article" | "image_text" | "video" | "thread" | "document"
  | "repository_change" | "model_card" | "dataset_card" | "notebook"
  | "demo_bundle" | "community_message";
type PlanDecision = "prepare" | "skip" | "needs_input";
type CreationMode = "ai_assisted_draft" | "author_led_editor_assist"
  | "human_original_copyedit" | "human_only" | "ineligible";
type DeliveryMode = "prepare_only" | "manual_only" | "separately_authorized" | "ineligible";
type AiAction = "research" | "outline" | "copyedit" | "translate" | "draft" | "generate_media";
type EffectivePolicy = { creationMode: CreationMode; deliveryMode: DeliveryMode;
  allowedAiActions: AiAction[]; requiresAuthorContribution: boolean;
  requiredConditions: string[]; ruleBindingHash: Sha256 };
type Ref = { id: string; revision: number; sha256: Sha256 };
type ClaimBinding = { claimId: string; fingerprint: Sha256 };
type FileBinding = { artifactId: string; sha256: Sha256; bytes: number;
  role: "source_video" | "source_image" | "transcript" | "timed_captions"
    | "code" | "dataset" | "notebook" | "run_log" | "rights_evidence";
  rightsReviewHash: Sha256; privacyReviewHash: Sha256 };
type RequiredOutput = { outputKey: string; kind: "text" | "image" | "video"
  | "captions" | "repository_diff" | "model_card" | "dataset_card"
  | "notebook" | "demo_manifest" | "document";
  locale: Locale | null; required: boolean; derivedFromKeys: string[] };
type LanguagePlan = { sourceLocale: Locale; targetLocale: Locale;
  translateBody: boolean; subtitleMode: "none" | "original" | "translated" | "bilingual";
  voiceMode: "preserve_original" | "explicit_approved_profile";
  approvedVoiceProfileRef: Ref | null };
type AdaptationTarget = { targetKey: string; platformId: string;
  destinationRef: Ref; accountRef: Ref | null; locale: Locale; nativeForm: NativeForm;
  decision: PlanDecision; decisionReasons: string[];
  profileRef: Ref; rulesRef: Ref; styleRef: Ref | null;
  requestedCreationMode: CreationMode; requestedDeliveryMode: DeliveryMode;
  authorContributionRefs: Ref[];
  readerNeed: string; angle: string; thesis: string;
  retainClaimIds: string[]; mustRetainQualifiers: string[]; removeSections: string[];
  structure: { key: string; purpose: string; sourceSectionKeys: string[] }[];
  languagePlan: LanguagePlan; inputFiles: FileBinding[];
  outputs: RequiredOutput[]; settings: NativeSettings;
  knownGaps: { code: string; inputKey: string; explanation: string }[] };
type NativeSettings =
  | { kind: "article"; canonicalSourceRef: Ref | null; disclosure: Disclosure }
  | { kind: "image_text"; coverOutputKey: string; orderedImageOutputKeys: string[]; disclosure: Disclosure }
  | { kind: "video"; durationMs: number; aspect: "16:9" | "9:16" | "1:1";
      chapters: { atMs: number; title: string }[]; disclosure: Disclosure }
  | { kind: "thread"; orderedSegmentKeys: string[]; disclosure: Disclosure }
  | { kind: "document"; orderedPageOutputKeys: string[]; disclosure: Disclosure }
  | { kind: "repository_change"; repositoryRef: Ref; baseCommit: string;
      operation: "prepare_diff" | "prepare_release_notes"; tag: string | null }
  | { kind: "model_card"; repositoryRef: Ref; modelArtifactRefs: Ref[]; licenseRef: Ref }
  | { kind: "dataset_card"; datasetArtifactRefs: Ref[]; licenseRef: Ref; synthetic: boolean }
  | { kind: "notebook"; notebookRef: Ref; inputDatasetRefs: Ref[];
      executionEvidenceRef: Ref | null; executeCode: false }
  | { kind: "demo_bundle"; demoArtifactRefs: Ref[]; runtimeEvidenceRef: Ref | null; deploy: false }
  | { kind: "community_message"; channelRef: Ref; threadRef: Ref | null;
      visibility: "public" | "restricted"; send: false };
type Disclosure = { aiUse: "none" | "copyedit" | "translated" | "generated_text"
    | "generated_media" | "mixed"; requiredLabels: string[]; authorExplanation: string };
type AdaptationPlan = { schema: "pengmanager.adaptation-plan/v1";
  storyRef: Ref; motherEditionRefs: Ref[]; claimBindings: ClaimBinding[];
  sourceBundleHash: Sha256; researchBundleRefs: Ref[];
  goal: string; targets: AdaptationTarget[]; budgetAuthorizationRef: Ref | null;
  mode: "prepare"; containsCommands: false };
```

以上每个对象都采用**封闭字段集**；`NativeSettings` 是按 kind 精确区分的联合，不能有任意 `extra`、任意工具参数或透传配置。Ref 中 revision 必须是安全整数且查到真实业务实体，不以 ID 看起来合法代替存在性。具体平台 settings 由已核实的规则快照进一步约束；尚未核实的可见范围、受众、分类、声明和商业设置保留 needs_input，不能由模型替本人承诺。（D）

导入入口分两步：（1）`POST /api/content-ops/plan-imports/validate` 只校验并持久化不可变导入快照，返回 validatedImportId、归一化预览、hash、每目标缺口，不创建执行工单、不调用模型／工具；（2）管理员对准确 source／target／rule／budget 快照确认后 `POST /api/content-ops/jobs` 创建持久计划和准备工单。JSON 来自本地文件、岗位输出或人工编辑都经过同一验证器；不执行里面的 Markdown、front matter、URL、路径、notebook 或工具建议。（D）

导入与编译必须同时满足以下不变量，否则返回明确错误：（D）

1. UTF-8 JSON，传输上限提议 1,000,000 字节，与当前 JSON 请求限制相容；拒绝重复键、危险对象键、非有限数、过深嵌套、超长单字段、未知字段。服务端先流式字节限额，再解析，再 schema，再业务校验；不能靠解析后截断。初期深度上限提议 32，数组上限逐字段明确。
2. 1—28 个 target；`targetKey=H({platformId,destinationId,accountId,locale,nativeForm})` 由服务端重算，禁止重复；目录必须包含平台 ID。归档目的地不会因导入重新启用。
3. 所有母版属于同一 Story；母版修订、Claim 指纹、资产字节／权利／隐私、岗位／规则／风格、账号／目的地身份快照均在服务端核对。目标账号为空仅用于自有官网等当前模型允许的目的地，不泛化到外部账号。
4. retainClaimIds 是冻结 Claim 集合的子集；每条需要的数字／身份／能力有可批准证据；新事实只形成待核候选，不能在编译时自动批准。已过期、私有或撤销的事实不能进入对外成品。
5. requestedCreationMode／requestedDeliveryMode 只是请求，创作方式与外发方式是两个轴，不能把 manual_only 当成允许AI起草，也不能按一个总序“取更严格”。服务端将平台、具体目的地、本次授权分别允许的 AiAction 集合求交集，并合并作者参与／标识／禁止批量等必需条件，形成 EffectivePolicy；creationMode／deliveryMode 是展示标签，真正门禁是 allowedAiActions、requiredConditions、ruleBindingHash 和双端权限。外发始终另需准确运营动作授权。作者贡献必须有真实输入与版本，不接受单独 `humanReviewed:true`。公众号作者主导、DEV／Kaggle 评论限制、脉脉人工限定均在生成前生效。
6. 形式与 settings.kind、outputs、languagePlan 相容。无真实视频不能选择“已有成片完成”；无实际模型／数据／notebook 不产生相应成果。缺输入保留 needs_input；不静默裁减必需产物。
7. `derivedFromKeys` 全部存在，DAG 无循环、不跨无关工单；输出唯一且可枚举。compiler 自己加入检查／冻结／终检节点，导入者无法删掉它们。
8. 引用只能是业务 ID＋hash。worker 本机路径由受控 registry 解析，计划不得带绝对路径、`..`、shell、URL 下载指令、环境变量、secret 名或供应商 endpoint。引用资料 URL 只作来源；抓取是另一个有界、允许主机的只读研究任务。
9. budgetAuthorizationRef 可为 null，仅用于保存未配置预算的导入／blocked_budget 工单；非null时指向管理员准确授权。金额、币种、token、调用、并发、期限、渲染与磁盘限制完整才可启动相应费用／副作用步骤，null绝不派发。补预算或改变授权必须创建新plan revision，得到新planHash与重新校验的导入快照／blueprint；jobs请求的budgetAuthorizationHash必须与该准确非null Ref对应同一授权快照，不能把任意新budgetHash配到旧null计划。旧草稿／工单留存，重用内容须显式hash核对；旧unknown预留不转移或清零。
10. 计划语义内容服务端规范化后哈希；客户端给出的 hash 只作对照。`planHash=H({schema,storyRef,motherEditionRefs,claimBindings,sourceBundleHash,researchBundleRefs,goal,targets,budgetAuthorizationRef,mode})`，不包含 hash 自身。保留原字节摘要、归一化对象与校验器版本，不用 hash 代替授权。

`H` 继续当前 `hashObject` 的对象键排序、数组保序和 SHA256 语义，前置拒绝不合法 JSON 值；文件 hash 取实际字节。顺序有意义的图片、页、分段、字幕和输出列表绝不排序以求“相同”。计划修改创建新 revision／planHash，旧计划和产物留存。（A：当前哈希；D：新合同）

## 5. 编译为实际任务，分清目录与就绪

### 5.1 当前发现面：24＋2，而非 334 个可执行 MCP

| 目录项 | 已有用途与来源 | 本次状态边界 |
| --- | --- | --- |
| `core.workspace.profile`、`core.agents.list`、`core.threads.list`、`core.threads.get` | 原生 core 清单、tRPC query。（B 清单；A loader） | read；当前工位／成员可访问性未实测。 |
| `core.threads.events`、`core.approvals.list`、`core.inspection.status`、`core.skills.list` | receipt／read，读取原生过程。（B／A） | 不等于云端编辑权限或员工在线数。 |
| `growth.service.ticket.list`、`growth.service.ticket.receipt` | C-service 读工单与回执。（B／A） | 不作为内容制作或发布。 |
| `growth.service.inquiry.preview` | 本地 previewInquiry。（A） | preview；无外部写入。 |
| `growth.service.inquiry.execute` | 清单 enabled:false。（B／A loader） | 禁用，调用失败关闭，不进入 MCP tools/list。 |
| `growth.video.route.record`、`growth.video.production.status` | 本地 routeRecord／productionStatus。（A） | 只读项目和路线状态。 |
| `growth.video.delivery.inspect` | 本地 deliveryInspect。（A） | 读取交付和指针，不等于最终质量完成。 |
| `growth.video.production.plan` | 本地 productionPlan。（A） | 仅预览；命令建议不能回放执行。 |
| `growth.video.gen.catalog`、`growth.video.production.shots` | 原生 tRPC query。（B／A loader） | 可发现供应商／镜头不等于供应商可用、费用已准或已生成。 |
| `growth.repo.status`、`growth.repo.docs`、`growth.bundle.summary`、`growth.repo.readiness` | 本地 repo 方法。（B；loader A，具体 repo 模块未在本次做语义审计） | 读／预览；不提升生产权限。 |
| `growth.video.workbench.guide` | 固定视频指南，现行源已完整读取。（A） | 实际制作前必须取得并固定指南版本／hash。 |
| `growth.video.post.quality` | 当前包技术检查。（A） | artisticQuality 仍单列，不能自动补成 passed。 |
| `pengmanager.video.status`、`pengmanager.video.capabilities` | 鹏经理 wrapper 两个只读入口。（A） | 当前运行环境状态和目录；不是通用 invoke 全工具。 |

24＋2 共 26 个可发现项，1 项禁用，因此当前代码规则下 MCP 可暴露 25 项；这不是本次真实连接的 25 项数量（B／A）。大目录实际包含 tools 334、capabilities 80、roles 101、skills 123（B 完整 JSON 解析），只能作为候选实现索引。未对 334 项逐个发请求，也没有把角色／技能声明计为运行中的员工。

还需区分“读业务数据”和“完全没有本机生命周期副作用”：`src/agent.mjs:invoke` 在缺原生token的tRPC路径会启动runtime并取得nativeSession；本地capability调用会建立受控dataRoot／仅记key存在性的私有文件（A）。因此 `operation:read` 不作为任意自动探测的许可；目录 list／describe 与真实 invoke 分开，readiness只运行本机owner允许的固定探针，必要进程启动有明确scope和生命周期记录，不逐项invoke24／334目录。（D）

就绪采用四个独立字段，不用一个 `available` 混合：（D）

- `declared`：所选版本目录确有该 ID；只能证明声明。
- `codePresent`：固定入口及规定的实现文件存在、hash 与已审基线相符；目录的 literal reference 仍只算 B，不算完整行为审计。
- `ready`：对这个 worker／成员／项目完成无副作用依赖与权限检查，必要的隔离产物验证已通过，指定 adapter／输入 schema／输出 schema 已落地；有时效和范围。key 存在不能单独置 true。
- `productionVerified`：有真实授权任务、准确输入、实际输出、独立检查与回读 receipt；不能由 health、fixture、dryRun 或 synced 单字段推出。

本稿所有新 worker adapter 的 `ready=false／unverified`、`productionVerified=false`。本次尝试运行 `node scripts/agent.mjs list`，exec PATH 返回 `node: command not found`，没有执行 CLI、安装运行时或改 PATH；因此本次原生数量来自完整清单解析与源码，而非运行成功回执。它不说明 root 的其他运行环境不可用。（B：实际命令结果）

### 5.2 固定任务模型与适配器选择

拟议 `TaskBlueprint={schema,taskId,jobId,targetKey,kind,adapterBinding,dependsOn,inputRefs,outputSpec,permissionRequirements,costClass,budgetAuthorizationHash,timeoutMs,compileInputHash}`。adapterBinding 由服务端和本机批准清单共同生成，含 adapterId／version／entrypointSha／nativeCapabilityId（如适用）／fixedTransport／validatorVersion；岗位输出无权指定它。taskHash 覆盖全部字段；taskAttempt 单独记录次序与结果。budgetAuthorizationHash仅在无执行的预览／blocked_budget blueprint可为null；派发前必须随已重验的新plan／blueprint固定为非null，worker无权自行补值。（D）

**蓝图与运行期解析必须分离**：`compiledBlueprintHash` 只覆盖编译期不可变结构、固定源refs/hash、adapter／权限／预算快照，以及依赖的逻辑 `{producerTaskId,outputKey}`；`compileInputHash` 同样只取这些已知输入与逻辑依赖。它不包含未来产物hash、未来packageHash、终检报告或approval。依赖成功后服务端按准确提交产物解析出 `resolvedInputRefs`，计算 `resolvedInputHash=H({taskHash,resolvedInputRefs})`，只进入持久attempt／requestHash；同task第一次可执行时固定这一解析快照，重试不得偷偷改成别的最新产物。新输入须新blueprint。`quality.final` 读取最终packageHash是运行期attempt输入，不能回写整DAG再改变compiledBlueprintHash；否则package反过来包含blueprint会形成间接循环。此不变量也适用于所有产物完成和结果恢复。（D）

| 计划需要 | 可复用的当前接点 | 拟议严格投影与真实完成条件 |
| --- | --- | --- |
| 中文／英文深改、翻译、润色 | 当前 DeepSeekAdapter 的单次 chat／respond 源存在（A）；原 generateContent 是旧中文稿合同，不直接复用其内部重试。 | 新 `text.adapt`／`translation.localize` 只接收冻结资料、目标结构、术语／限定、EffectivePolicy，返回有界 typed text／blocks。单次网络请求一个 attempt；逐句事实映射、完整文字落盘／hash、独立语义检查。供应商策略／价格未核实则阻塞。 |
| 真实截图＋文字卡／封面 | `visualwrite.compose/render/text` 的 VisualBridge executor 声明和固定 transport 已读（A），334 目录仅索引（B）；实际视觉 server 深层处理未在此完成审计。 | 新 `image.compose` 只允许已审 layoutId、真实 assetRefs、有界文本、尺寸和输出角色；映射到该版本已验证的结构化参数，禁止任意路径／URL／prompt-as-command。没有已实现、隔离验证的参数映射就 `ADAPTER_NOT_READY`。输出实际 PNG／JPEG／静态 WebP，核对字节、尺寸、文字可读与真实截图语义；不默认生成图片。 |
| 已有视频增量返修 | `postwrite.reedit` executor／CLI（A）及 readRevisionBase／reedit／callTool 选段（C）。 | 新 `video.reedit` 输入 projectRef、expectedVersion、expectedProjectSha256、允许的字幕／copy／封面等 typed patch；初期不投影 shots、shot_paths、任意音轨路径或新镜头生成。取新版本实际输出；`executed:false`、dryRun、blocked 都不能完成。 |
| 真实片段的新本地交付包 | `postwrite.package` executor／CLI（A），buildDeliveryPackage 与 callTool 选段（C）。 | 新 `video.assemble` 明确 sourceShotRefs、时间轴、画幅、原声策略、字幕与所选配方；经完整适配审计后才绑定。固定新工作区与输出，不传任意 env／argv。完整包、真实 MP4／封面／字幕／manifest 与各 hash 都需存在。成功源片不因本设计重生成。 |
| 已有时间轴字幕、双语旁挂或软轨 | subtitle executor／CLI（A），exportSidecars／softMux（C）。 | `caption.align` 要已有可信台词及 cue／时间映射。无 transcript／timing 不凭译文猜真实语音；没有明确 ASR 请求不启动 ASR。侧车 SRT／ASS 留本机，按当前媒体验证器准备独立语言 VTT；组合双语 VTT 不冒充两份单语。softmux 选实际 MP4，读取轨道／时长和 hash；语义与翻译仍另检。 |
| 显式允许的配音 | voice executor／CLI（A），speak／dub（C）。 | 新 `voice.speak` 只在 explicit_approved_profile＋真实授权档案＋单次明确配音要求时开放；初期不允许 consent／register／record／任意voiceId、丢弃原声或 overflow。每个底层 chunk 合成单独记账。默认 preserve_original，不因英文稿存在就换声。WAV 是私有中间产物，不上传为当前媒体。 |
| 技术质量／文件读取 | `delivery.inspect`、`growth.video.post.quality` 与 postread.quality 路径（A 入口；C 核心选段）。 | `media.inspect`／`quality.technical` 只读明确 job workspace；检查 manifest 和当前字节、解码与合同。技术通过单列，不替代审美／事实终检。 |
| README／release、模型卡、数据卡、notebook、Demo 说明 | 平台研究 B＋现有目录；没有已实现的鹏经理原生软件附件审批适配器（D 缺口）。 | `native.prepare` 只准备有实际作品的文字与静态 diff／文件清单，不执行代码、不装依赖、不 apply patch、不部署、不推送。实际文件存储、预览／验证合同未落地就导出待人工，不能把 unsupported 内容塞入 mediaAsset。 |
| 包冻结与终检 | 现有不可变稿／媒体／哈希／审核域可衔接（A）。 | 新 `package.freeze` 是确定性提交；`quality.final` 由独立 checker 读取最终包和实际附件，按第 8 节生成不可变报告。两者为新功能，当前无可调用 ID。 |

`edit-auto.mts` 虽有完整入口源码（A），含默认意图推断、BGM 准备、自动排片和多步子程序；其整个深层依赖本次未审完，**不进入初期 worker allowlist**。`production.plan` 建议的 full-chain-film 命令也不进入。只有被具体任务需要、适配完成且有 scope／budget 的路径才开放；不因“都有目录”就把几十种流水线自动串起来。（D，范围决定）

VisualBridge 当前自动幂等键是 FNV 风格缓存键、网络错误可切换端点，soft receipt 可 synced:false（A）；它不能代替业务幂等和未知费用账本。新 worker 不启用盲目自动重试／故障转移；结果不明进入 unknown。postwrite.reedit 的 dryRun／未执行分支也可能 `receipt.synced:true`（C 选段），因此 adapter 必须核对 executed、expected inputs、版本、实际文件与检查，不能只认 synced。voice speak／dub 会逐段合成并主动卸载 ASR 权重（C）；在适配器能够按段预算、处理工位共享模型状态和真实授权前保持阻塞，不在共享工位静默调用。（D 处理）

## 6. 双端权限、任务租约与真实文件运输

### 6.1 权限分层

| 主体 | 可以做 | 无权做 |
| --- | --- | --- |
| 平台策略岗位（D） | 读取本工单允许的母版／事实／规则，提交计划建议、缺口、文字候选。 | 自行选择工具入口、批准事实／资产／内容、增加费用、发送、创建账号。 |
| 鹏经理管理员（现有权限 A，新增动作 D） | 冻结目标身份、核对规则与素材、确认预算／worker 范围、导入准备稿、内容与具体外发审批。 | 管理员点击不能把缺媒体、假回执、陈旧终检变成真实通过。 |
| 云端编译器／调度器（D） | 校验数据、产生 allowlisted DAG、持久预算／attempt、发放窄 task lease、保存结果。 | 向本机任意进程发命令、获取本机 token／cookie、借 root 权限绕过本机 owner。 |
| 本机 worker（D） | 领取限定 job／task；读取固定来源；在自己的工作区产生新文件；用本机允许的 adapter；提交未审核产物与执行凭据。 | 改账号／目的地／Claim 状态、媒体权利审查、终检自签、批准、排期、发布、提升风格记忆、读取任意本地文件。 |
| 本机工具域 owner／成员（既有工具约束 A，联合门禁 D） | 给予指定 workspace／项目／能力／期间的本机执行权；保留原生租户／成员／围栏／审批／费用门禁。 | 鹏经理云端批准不能伪造原生审批或突破引擎 scope。 |
| 独立 checker（D） | 按固定检查版本读取冻结最终包和证据、写不可变 QualityReport。 | 修改包、扩大素材范围、批准发布、删去阻断问题。 |
| 发布执行者（现有动作 A，原生包扩展 D） | 在单账号、单目的地、准确包授权下执行并实际回读。 | 根据“生产已好”自动发送所有目标；结果不明靠重发。 |

新增 worker 配对由**鹏经理管理员批准＋本机 owner 确认**共同建立，绑定 workerId、允许的 cloud origin、workspace／tenant、项目、job 范围、adapter 白名单、文件／费用／期限。凭据使用单独的短期、可撤销 scope；服务端只保存不可逆凭据摘要和 scope 元数据，不保存明文。本机工具认证与云端 worker 身份分离。现有 HTTP Agent bearer 不被升级，管理员 session 不被导出给 worker。（D）

### 6.2 租约和恢复

每个 task 固定编译期taskHash；实际依赖就绪后按第5.2节固定resolvedInputHash。拟议 attempt 保存 `attemptId,taskId,epoch,workerId,leaseExpiresAt,taskHash,resolvedInputHash,requestHash,status,dispatchRecordedAt,providerRequestId,resultRef,reservationIds`。claim 是条件写：只给一个 worker 一个 epoch；结果提交核对 taskHash、epoch、worker scope、未取消状态与输入指纹。网络／模型／渲染在 JsonStore 锁外运行，短事务只写状态。（D）

租约过期不证明旧 worker 未执行。`reserved→dispatch_recorded→running→succeeded|failed_known|unknown|cancel_requested` 中，已经 dispatch_recorded 但无确定结果的副作用／付费任务，重启后进入 needs_reconcile，不自动重派；旧 epoch 的迟到结果只进入隔离审计，不覆盖新 head。纯确定性本地只读检查可按已定义幂等规则重跑；写产物也必须使用新 attempt 私有工作区和唯一文件名，不能覆盖上一版本。（D）

重启从持久 DAG／attempt／reservation／artifact 清单恢复；成功依赖按实际 hash 复用。取消立即落盘并 fence 后续 claim／dispatch／complete 激活；已开始进程尽力停止，费用和外部结果仍可能发生。迟到输出可核对记账，但不自动接着润色、终检、批准或外发。cancelled 是终态，不能 worker 自行恢复；管理员若另立新工单重用产物，旧未知费用继续保留在原账本及账号总账。（D）

### 6.3 文件运输与提交原子性

所有输入先通过已授权 ID 解析到固定源；实际读取用 pin 后的描述符／摘要，拒绝符号链接、设备、FIFO、跳出根目录与不受支持格式。原始视频、商业音乐库与声音档案默认本地；worker 只能读本次明确来源，输出永远新目录。不能扫描本机用户目录补素材、自动下载模型或删除来源来释放空间。工作区字节／时间上限在派发前检查，失败返回 `WORKSPACE_QUOTA_EXCEEDED`／`LOCAL_SOURCE_MISSING`。（D）

新 `worker-artifacts` 上传只允许 task.outputSpec 预先声明的 MIME／角色／大小／SHA。按字节限额流式写入私有 staging，服务器独立重算 hash／解析文件，不接受 worker 自填“审核通过”。现有可用媒体类型经受控桥导入 MediaAssets 的**未审核**状态；这个桥是新代码，不能伪造 session 调用当前拒绝 agent 的 API。管理员完成真实权利／隐私审核后才生成可用于冻结包的 assetReviewHash。（D）

文件落盘和 JSON 不是一个数据库事务：先用 O_EXCL 等价的不可覆盖操作写新对象并 fsync，再短事务提交准确 manifest／引用；事务失败留为不可引用的 staging，明确可重试的原 requestHash。只有完整提交才可被 package 引用；取消／失败产物不变为公开素材。后续回收只能处理本系统自己创建且仍未引用的临时对象，采用明确保留策略，不自动触碰原始库。（D）

原生软件附件另设私有 `native-artifacts` 合同：严格类型白名单、实际字节摘要、内容预览与限制、版权／许可／隐私检查、完整备份／隔离恢复。notebook 仅静态预览，不执行单元格；仓库 diff 不 apply；压缩包不自动解压执行；PDF 不在网页同源执行脚本。未实施这些验证器的类型在 runtime 返回 `NATIVE_ARTIFACT_TYPE_UNSUPPORTED`。成片超过当前 50 MiB 时不能静默截断或自动降清，显示超限并由明确的尺寸／压缩方案形成新候选，或待新的限额合同。（D）

## 7. 不可变稿、数据模型与 API 衔接

### 7.1 Edition／Variant 与原生包的职责

跨形式先形成**中立形式版本**，然后按目标生成 Variant／NativeCandidate。一个 Story 的同 locale＋format 修订族仍沿用现有替代规则；同一批平台不能各建一份互相替代的“中立母版”。编译器以 `formatTransformKey=H({sourceEditionRefs,targetLocale,targetFormat,transformSpec})` 合并中立转换节点，并对 family head 作比较交换；各平台的标题、顺序、素材、节奏与设置保留在不同 Variant／包中。并发冲突返回 `EDITION_FAMILY_CHANGED`，不覆盖管理员刚创建的新修订。（D）

新增 `formatLineage={schema,derivedFromEditionRefs,transformKind,transformSpecHash,lineageHash}` 纳入 v3 Edition 快照。跨形式不用 sourceEditionId；同形式翻译仍遵守现有 same Story／same format／opposite locale，英文视频若源是中文视频可用翻译关系，若源只有中文文章则表达跨形式＋跨语言的 lineage。所有引用指向准确不可变版本，禁止自引用和环。（A：旧语义；D：扩展）

同形式平台深改复用现有 `createVariant` 的 full title／summary／body／blocks／assetRefs／adaptationNote 形态；原生字段放入明确 v3 PublicationPackage，不能藏在 adaptationNote 或未参与 hash 的任意 JSON 中。线程、文档、代码／notebook 等不强塞进旧三种 blocks：可用 article Edition 保存中立说明，但需要独立 nativeManifest 和全部有序附件。（D）

拟议包合同如下，实际没有新实例：（D）

```text
PublicationPackage(v3)
  schema, candidateId, targetKey, storyId, sourceEditionRefs, lineageHash
  platformId, destinationIdentitySnapshot, accountIdentitySnapshot|null
  locale, editorialFormat, nativeForm
  title, summary, body, orderedBlocks, orderedMediaRefs
  nativeManifest{strict kind union, ordered segments/pages/chapters/files, settings, disclosures}
  sourceClaimBindings, rightsReviewHashes, privacyReviewHashes
  operatorProfileRef, rulesRef, styleRef, adaptationPlanHash, compiledBlueprintHash
  artifactRefs[{id,role,mime,bytes,sha256,validatorVersion}]
  packageHash = H(all above except packageHash)
```

人工需要看到的全文、图片顺序、视频、字幕、正文引用、发布设置和作品文件都必须进入 packageHash。模型调用日志、终检报告、人工 approval 另设不可变对象，不放进 package 再互相循环 hash。生效前重新核对现行 Claim／权利／身份／规则，保持既有历史不可变。（D）

### 7.2 拟议集合及唯一键

沿用单写者 JSON；下列是数组集合及启动时校验／可派生 Map 的查找键，不是现有 SQL 表或索引。（D）

| 新集合 | 核心字段 | 唯一性与关键引用 |
| --- | --- | --- |
| adaptationPlanImports／adaptationPlans | 原始字节hash、normalizedPlan、planHash、validatorVersion、inputBindings、createdBy、revision | import requestHash／planHash；修订不可覆盖；同来源异body幂等冲突。 |
| contentOpsJobs／contentOpsTargetRuns | jobId、planRef、targetKey、blueprintHash、状态、步骤、cancel／deadline、revision | jobId＋targetKey 唯一；终态与未选择分别显示。 |
| productionTaskBlueprints／productionTaskAttempts | DAG、kind、adapterBinding、inputRefs、outputSpec、epoch／lease／requestHash／resultRefs | blueprint taskId 唯一；attemptId 永不复用；taskHash＋epoch fence 结果。 |
| productionWorkers／workerGrants | workerId、允许origin/workspace/project/adapter/job、scopeHash、过期／撤销、凭据摘要 | 云端与本机批准同时有效；不存本机供应商 secret。 |
| productionArtifacts／nativeArtifacts | opaque ID、真实bytes/hash/MIME、所有者task、staging／committed、验证／权利记录 | id 唯一、artifact hash与当前字节一致；不可因同hash跨权限泄露存在性。 |
| nativeCandidatePackages／contentQualityReports | 完整包／packageHash；checkedPackageHash／contextHash／reportHash／实际检查凭据 | 候选与报告均不可变；唯一组合 candidate＋packageHash＋checkerVersion；禁止自签 passed。 |
| modelBudgetReservations／modelUsageReconciliations | 准确attempt、provider/model/pricingHash、各维预留、实际／未知、审计证据 | attemptId＋计费子调用唯一；未知预留跨重启／取消保留。 |
| formatLineage／draftMaterializations | edition refs/hash、转换类型、lineageHash、candidateRef、resultEdition／Variant IDs | DAG无环；materialization effectKey 唯一，重复返回原草稿。 |
| operatorProfiles／ruleSnapshots／styleVersions | 平台／账号／目的地／语言scope、版本、官方来源／范例、批准者与hash | 生效版本不可覆写；模型只提出候选，不自行提升。 |

事件如 `content_ops.plan_imported`、`task.dispatch_recorded`、`artifact.committed`、`usage.unknown`、`candidate.frozen`、`quality.final_completed`、`draft.materialized`、`job.cancelled` 均由真实主体写入并包含准确对象 hash。事件 payload 不放凭据、原始未授权私密文件或无限模型日志。新增 schemaVersion 3 要同步 JsonStore.assertState、editorial 完整性检查、bootstrap dry-run／迁移、两类备份／隔离恢复与旧二进制拒开规则；备份前后的旧 Claim／内容／发布／事件前缀和 v1／v2 快照 hash 必须相同。（D）

### 7.3 当前接口与拟议接口分开

**当前已实现（A）**：`GET /api/editorial/bootstrap`、`POST /api/stories/:id/editions`、`POST /api/editions/:id/variants`、`POST /api/content/:id/transition`、`POST /api/media/assets`（raw binary）、媒体 review／bytes、`/api/website/releases` 与 approve／publish／verify／withdraw、`/api/operations` 与 approve／start／complete／fail／reconcile。编辑路由执行管理员鉴权和来源检查；Agent 当前会 403。现有 API 不认识 AdaptationPlan、task lease、native package 或 worker bearer。

以下全部为**拟议、当前不存在**，身份和方法不能从路径名称暗示已经开通：（D）

| 方法／路径 | 请求、响应与授权 |
| --- | --- |
| `POST /api/content-ops/plan-imports/validate` | 管理员；`{plan}`＋Idempotency-Key，必要源etag；200 `{validatedImportId,normalizedPlan,planHash,sourceBindings,targets:[{effectivePolicy,gaps}],validationVersion,expiresAt}`。持久化校验快照绑定创建者、源版本和期限，不创建执行工单／调用模型工具；源码／身份／规则／预算变更或过期后需重新validate，不能只回填字符串ID。 |
| `POST /api/content-ops/jobs` | 管理员；`{validatedImportId,planHash,budgetAuthorizationHash:null|string,mode:"prepare"}`，Story If-Match＋幂等键；202 `{jobId,etag,blueprintHash,status,targets}`。服务端取同一未过期导入快照重验源与授权；hash必须与plan预算Ref完全一致。两者同为null才存blocked_budget，无claim／dispatch；补授权走新plan revision／hash及validate。创建不等于开通本机能力。 |
| `GET /api/content-ops/jobs/:id` | 管理员或明确job只读scope；返回每目标步骤、真实产物、actual/unknown/reserved、质量维度、错误；日志游标／有界，不返回secret或本机绝对路径。 |
| `POST /api/content-ops/workers/pair` | 管理员创建待本机确认的单次配对挑战；双方批准scopeHash后生成独立worker授权。无现有session/token复制；挑战过期／用过拒绝。 |
| `POST /api/content-ops/worker/tasks/claim` | 限定worker；`{workerId,adapterReadinessRefs,maxTasks:1}`；200 lease或204，无任意任务／租户可选参数。scope不匹配拒绝。 |
| `POST /api/content-ops/worker/tasks/:id/dispatch` | 准确lease／epoch＋taskHash＋requestHash＋幂等键；先原子预算预留并写dispatch，再返回一次派发许可。相同键返回同attempt，不新扣费。 |
| `POST /api/content-ops/worker/tasks/:id/artifacts` | 准确lease／attempt，只接受outputSpec已列角色的raw binary，声明SHA/size；201暂存回执。独立服务验证实际bytes；不是公开上传／权利批准。 |
| `POST /api/content-ops/worker/tasks/:id/complete` | `{attemptId,epoch,taskHash,resultManifest,executionReceipts}`；服务器核对实际文件和结果状态，200记录成功或unknown；不可自填quality passed或approve字段。 |
| `POST /api/content-ops/jobs/:id/cancel` | 管理员／原授权取消scope；`{reason}`＋If-Match＋幂等键；200持久取消与inFlight说明，不承诺未收费／撤回。 |
| `POST /api/content-ops/jobs/:id/usage/:attemptId/reconcile` | 管理员，准确供应商回执或逐项账单审计；If-Match＋幂等键；核对各单位／币种后结算，缺证据仍unknown。 |
| `POST /api/content-ops/candidates/:id/materialize` | **管理员**；`{packageHash,qualityReportHashes,reviewSnapshotHash}`＋Story If-Match／candidate ETag＋幂等键；201 新／既有准确 Edition／Variant draft，绝不批准／排期。worker只提交候选供审核。 |
| `POST /api/content-ops/jobs/:id/targets/:key/revise` | 管理员；具体修改指令＋父candidate/hash＋ETag／幂等键；新候选、剩余预算内新任务；修改后独立终检，不覆盖旧稿。 |

素材权利审查仍走管理员流程；worker 成品导入不能生成假 `method:"session"` 绕过当前 #write。实现时新增显式 `prepareDraftFromCandidate` 内部能力，检查窄 worker／job授权只可写 preparation 集合；管理员 materialize 复用当前建稿语义并把生成effect放在同一短事务／协调器中。不得在 store.mutate 里再递归调用异步 mutate，避免嵌套队列和跨事务重复效果。（D）

新快照审批分支使用明确 `snapshotSchema:"pengmanager.editorial-variant/v3"` 与 reviewSnapshotHash；保持当前 v2 内容原样验证，不能将 reviewSnapshotHash 无版本地塞进旧 snapshotHash。外部 operation v3 同样覆盖完整包、终检与目标，不借 v2 内容 hash 省略线程／文档／代码附件。（D）

错误沿当前 `{error:{code,message,details}}` 风格，新增安全字段 retryable／nextAction；不回显供应商 raw body／token／本机路径。约定：（D）

| 状态 | 明确错误与行为 |
| --- | --- |
| 400／413 | `ADAPTATION_PLAN_INVALID`、`UNKNOWN_FIELD`、`PLAN_TOO_LARGE`、`DUPLICATE_JSON_KEY`；不能截断后继续。 |
| 401／403 | `WORKER_AUTH_REQUIRED`、`WORKER_SCOPE_DENIED`、`LOCAL_PERMISSION_REQUIRED`、`AGENT_SCOPE_DENIED`；旧bearer不升级。 |
| 404／409 | `SOURCE_NOT_FOUND`、`SOURCE_OUTDATED`、`CLAIM_CHANGED`、`RIGHTS_CHANGED`、`IDENTITY_CHANGED`、`RULES_CHANGED`、`EDITION_FAMILY_CHANGED`、`TASK_EPOCH_STALE`、`IDEMPOTENCY_CONFLICT`、`ATTEMPT_UNKNOWN`；不盲重试副作用。 |
| 412／428 | 版本过期／缺 If-Match；返回新ETag和需重新预览对象，不覆盖人类编辑。 |
| 422 | `PLATFORM_POLICY_BLOCKED`、`AUTHOR_INPUT_REQUIRED`、`ARTIFACT_MISSING`、`CAPTION_TIMING_REQUIRED`、`NATIVE_ARTIFACT_TYPE_UNSUPPORTED`、`QUALITY_RECHECK_REQUIRED`、`QUALITY_REPORT_STALE`、`BUDGET_CONFIG_REQUIRED`、`PRICING_REQUIRED`。 |
| 429 | `JOB_BUDGET_EXCEEDED`、`WORKSPACE_QUOTA_EXCEEDED`、`PROVIDER_RATE_LIMIT`；只有各维预算／期限允许且结果已知时才按策略新attempt。 |
| 503 | `ADAPTER_NOT_READY`、`PROVIDER_UNAVAILABLE`、`BACKUP_REQUIRED`、`RESTORE_NOT_VERIFIED`；任务保留、状态可恢复，不展示成功。 |

## 8. 最终包终检、人工批准与发布回读

沿用原方案的无循环绑定：（D）

```text
sourceBundleHash + planHash + blueprintHash
           ↓ 真实产物／权利审查后冻结
PublicationPackage → packageHash
           ↓ 独立checker重读同一最终包与真实附件
QualityReport → checkedPackageHash, checkContextHash, reportHash
           ↓
ReviewEnvelope {schema,packageHash,qualityReportHashes,checkContextHash}
           ↓ H
reviewSnapshotHash → 人工内容批准 → 排期 → 单目标动作批准
           ↓ 发起前再核当前事实／身份／权利／规则及相同hash
真实执行 → browser/server readback → publication receipt
```

`QualityReport={schema,id,candidateId,checkedPackageHash,checkerVersion,checkContextHash,deterministicReceipts,semanticFindings,mediaEvidence,coverage,modelReceiptIds,status,checkedAt,reportHash}`，reportHash 对除自身外的完整报告重算；报告只由允许的 checker 运行记录生成。`checkContextHash` 固定母版／Claim、最终来源限定、target identity、岗位／规则／风格、质量政策及版本。报告不包含可再改的自由布尔“已审”；status 来自实际子检查和未解问题。（D）

终检分四项，并展示每项 passed／failed／unverified 及覆盖范围：（D）

1. **确定性合同**：schema、引用存在性、有序项完整、权限／实际字节／hash、技术规格、字幕时间与章节界限、native设置、过期规则／事实。执行实际解析，不由模型勾选。
2. **语义与事实**：独立于策划／起草／润色的上下文重读最终文字、图注、字幕、设置与必要证据；逐段检查新增事实、数字／身份、限定条件、翻译、引用和社区相关性；finding 指向准确 block／segment／file／timecode。
3. **媒体内容**：读取实际上传后冻结文件；图文逐张核对顺序、文字和截图；视频按照所需覆盖实际画面与音轨／字幕，不能只看封面或一帧。机器支持不足时，独立人类审核者记录实际覆盖；有未覆盖必需段落就 unverified／needs_input，不签passed。
4. **表达与艺术**：可读、可听、叙事节奏、视觉层次、平台原生体验由独立检查者／人类产生可解释意见；技术闸和生成者的自评分不能填这一栏。成功源片不因为要“评分”自动重生成；修改只指向需要的文字／字幕／封面／本地后期层。

流程是起草→独立核验→有限返修→**最终润色→再次冻结→独立最终检查**。润色前的报告不能放行润色后的包。标题、正文、分段／图片／页顺序、封面、实际视频、字幕、代码／notebook、native设置、目标身份或规则任一变化都产生新candidate，旧 checkedPackageHash／报告／approval 过期。缺剩余终检预算就 `QUALITY_RECHECK_REQUIRED`，不直接 ready_for_review。（D）

`ready_for_review` 表示所需终检维度有实际依据、无未解 blocker／major，且媒体权利已审；不是生成完。minor 明示并由人类按质量政策处理。人工审核页完整呈现最终所有有序项、实际播放器／字幕／文件预览、源稿差异、来源、目标身份和终检证据，确认准确 reviewSnapshotHash。人工批准不能替代缺失终检，也不能把平台禁止的生成方式变成合规。（D）

发布继续两段：内容批准／排期，再单账号单目的地动作授权。外部原生包未有已验证 connector 时，仅安全导出／明确授权的人工或浏览器执行；worker不替外发。官网走既有二次公开批准、完整备份、路由CAS和真实服务器回读。外部公开 URL 回执须实际读到准确对象／正文／附件，receipt 对应 packageHash、reviewSnapshotHash、assetHashes、原授权操作；上传成功、API 200 和 providerRequestId 都不是发布成功。（A：当前官网／动作；D：扩展）

当前公开回执合同无法表达 Discord 受限频道；在新专用 `{server/channel/thread/messageId,authorizedVisibility,readbackEvidence,verifiedAt}` 合同与权限检查落地前，受限结果不登记为公开 published。发送结果未知，保留 operation unknown，先回读／reconcile；不靠“再发一次”解决。（A：当前公开URL限制；D：未来受限合同）

## 9. 预算预留、隐式多请求与故障语义

BudgetAuthorization 至少固定：`maxCalls,maxInputTokens,maxOutputTokens,maxPerCallInputTokens,maxPerCallOutputTokens,maxInFlight,currency,maxCostMicros,deadlineAt,pricingSnapshotHash,maxRenderSeconds,maxTempBytes,maxNativeProcesses,authorizedBy,authorizationHash`。金额为指定币种百万分之一的非负安全整数；日期 UTC；视频时长用整数 ms、渲染时间用明确 s、文件用 bytes；不混单位和币种。本稿不引用或虚构供应商价格／免费额度。金额或有效价格缺失可以保存 draft，不能付费派发。（D）

每一次**底层实际外部请求**先申请独立 reservation，不是每次高层函数一条。planner、draft、translation、checker、polish、final checker、每次重试、TTS每个chunk、模型增强／生成图片等都计入。现有 generateContent 内部可能两请求、voice可能多段、VisualBridge可能切换端点的现状要求 adapter 显式展开／关闭隐藏重试；未做到则 `ADAPTER_NOT_READY`，不假装上层包住一次就已有硬上限。（A/C：现状；D：新门禁）

持久短事务执行以下次序：（D）

1. 检查准确 lease／scope／taskHash、job未取消、deadline有效、合法价格快照及请求上界；含缓存／推理／工具费等所有可能计费维度，不用估计免费折扣减少预留。
2. 用精确整数按各维最高可证明价格向上取整算 reservedCostMicros；单位缺失、溢出或任一无法约束就不派发。单纯token上限不能声称保证金额上限。
3. 原子检查 `已结算用量＋所有未决预留＋本次预留 ≤ 授权各维上限`，并核对并发／本机算力／磁盘；写 reservation＋dispatch attempt 后才允许外部请求。两个目标竞争最后额度只能有一个成功。
4. 已知响应按准确 usage receipt 结算；无法核实 actualCostMicros／actualToken 时为 null，估算另列，不能写0。超时、进程崩溃、断网都可能已执行，记 unknown_usage，旧预留仍占用。
5. 新重试有新 attempt，旧未知预留不释放；在剩余额度／期限允许、策略同意时才可发。外发unknown则先回读，不走内容模型重试逻辑。
6. 释放／结算未知预留只接受可关联该attempt/providerRequestId的实际供应商用量／账单，或管理员对准确尝试作逐项审计并留证据／原因／审核者。点击忽略、取消、归档、重启、改预算都不能自动抹掉未知。

取消或到期后不启动新的模型、重试、终检、付费渲染、部署或外发；已经发出的请求只能尽力停止本地等待，迟到结果只记审计／账本。补账查询若有外部调用／潜在费用，也由管理员显式发起独立只读核对任务，不能取消后后台自动“补救”。本地查看、取消落盘与保留预留继续可用。（D）

本地 FFmpeg 的依赖／CPU／磁盘任务与供应商费用分账。只有明确无外部模型／网络、固定参数的本地适配器才可在 monetary budget 0 下运行；仍受 maxRenderSeconds／maxTempBytes／maxNativeProcesses。没有把“本机”自动等同零费用，也没有授权自动安装模型、购买算力、升级套餐或调用原镜头生成。（D）

## 10. 三个完整工单示例：所需输入、任务、真实交付和停止点

以下都是 **exampleOnly＝true 的拟议实例**；文中 E／C／A／任务名是示例逻辑键，不是数据库里已存在的 ID；没有生成这些文件、模型调用或外发。表中“产物”指后续实施必须交付的实际文件／对象，缺失必须阻塞，不能把本节当成实际生产回执。（D）

### 场景 S1：真实交付复盘 → 公众号文章＋小红书卡片

输入：准确中文 article 母版 E-zh、已批准C1—C3及保留限定、实际截图A1—A4与权利／隐私审核、本人写的经历／判断与贡献修订、具体公众号／小红书目的地身份、对应当次规则和本次预算。文章母版已经完整，不需要先全自动重写一遍“中立文章”。（D）

| 节点／依赖 | 谁做、使用什么 | 必须有的真实结果／门禁 |
| --- | --- | --- |
| S1-P／无 | 两个平台岗位分别出readerNeed、angle、structure、mediaRequirements；compiler校验。 | 两个目标独立plan；公众号 effectivePolicy.creationMode=author_led_editor_assist，外发单列deliveryMode，不接受只有AI母版＋最终勾选。 |
| S1-W／S1-P | 公众号岗位在本人真实原稿上限定编辑；单次受控text adapter。 | 完整手机长文、实际图位／图注、AI参与与商业说明；作者不提供真实贡献则AUTHOR_INPUT_REQUIRED，不能先自动生成再要求批准。 |
| S1-XT／S1-P | 小红书岗位改成逐卡信息任务；受控text adapter。 | 卡1问题与适用对象、卡2—4步骤和真实截图、卡5限制／检查表；有序卡片文案＋配套正文／话题／alt。数量为本例设计而非平台限额。 |
| S1-XI／S1-XT | `image.compose` 对真实截图＋批准模板排版，只有adapter ready才运行。 | 实际有序PNG／JPEG／静态WebP、每张hash、尺寸／文字可读；缺A3不编截图，卡片缺失则整份required output未完成。 |
| S1-E／两目标文字与必要图片 | compiler建立中立image_text派生Edition，lineage指向E-zh；公众号同format用原article族；各自Variant。 | 公众号全文稿＋小红书图文包，分别绑定目标；不为每张卡建一份互替的母版。媒体先经管理员权利／隐私审核。 |
| S1-Q／每目标最终freeze | 独立checker逐目标重读最终文案和实际图，随后人工完整审核。 | 各自packageHash／终检reportHash／reviewSnapshotHash；小红书封面变字即旧QC过期；不得以公众号稿质检通用到小红书。 |
| S1-O／已排期及明确授权 | 独立人工／浏览器运营动作。 | 真实目的地、全文／图序核对与公开URL回执；没有授权只导出待发布。 |

公众号 3.27／3.28 的真实作者主导限制和 4.24.2 标识来自本次实际公开静态规范（B）；它们不是“任何AI稿只要最后人审就允许”。小红书规则／样本缺口沿 A10 档案保留；不凭模板向用户保证流量。（D 处理）

### 场景 S2：真实演示与既有声音 → 哔哩哔哩中文版＋YouTube英文说明／字幕版

输入：本人真实可用的源视频／片段及hash、已批准论断、原语言逐字稿与真实时间轴、音乐／人声／画面权利、目标账号和规则、明确成片规格、已确认可用的本机post／subtitle adapter。只有文字母版没有视频，则本工单停为视频素材缺口，不把文案转换称为真实演示。（D）

| 节点／依赖 | 谁做、使用什么 | 必须有的真实结果／门禁 |
| --- | --- | --- |
| S2-P／无 | B站／YouTube岗位分别策划讲解路径、章节、口语文字／说明和封面。 | 两个原生策略，不直接复制中文标题；明确原声音轨保留，英文稿不隐含TTS。 |
| S2-I／S2-P | media.inspect读取指定真实源、film-project及版本／hash。 | 真实源清单、decode／时长／轨道，缺工程但想增量reedit时说明缺口；不扫描其他个人文件。 |
| S2-Z／S2-I | 优先已有成功源片＋postwrite.reedit限定patch；若明确需要重排则经ready的video.assemble。 | 新版本真实MP4／封面／manifest，源未改；按已点名文字／字幕／封面层返修；不自动重生成镜头。 |
| S2-ET／S2-P | translation.localize与独立双语核验。 | 英文标题／说明／字幕文字，数字、术语与限定逐项对齐；不可把中文口播称为英文口播。 |
| S2-CT／S2-Z＋S2-ET | caption.align按真实cue／实际转场映射处理；可选固定softmux，默认不烧字幕。 | 实际单语／双语SRT、独立VTT、softsub MP4（若明确选择）、每项hash和轨道／时长验证。没有可靠cue则CAPTION_TIMING_REQUIRED；不暗启ASR。 |
| S2-F／S2-Z＋S2-CT | 按语言／格式形成中立video Edition和各平台包，chapter时间来自实际最终片。 | 版本family、跨语言／跨形式lineage准确；独立B站／YouTube封面／说明／设置；超过50MiB显示限额缺口，不静默压缩。 |
| S2-Q／最终freeze | 独立语义、媒体／声音、艺术检查，再完整人工预览。 | 实际成片、画面／声音／字幕／章节与标题承诺一致；技术闸passed不代艺术；修改英文字幕即终检过期。 |
| S2-O／具体授权 | 独立平台发布动作，等待平台处理／可见状态后实际回读。 | 实际URL／可见范围／成片对应；上传完成不当作已公开。 |

如本人明确要英文配音，另建受控voice子图、已有approved profile／授权hash、各句合成预算、原声策略和实际声音验证；没有输入／权限／预算时保留原声＋英文字幕或needs_input，由准确计划决定，不能静默生成／替换。本例没有任何TTS、ASR、镜头生成或付费渲染已发生。（D）

### 场景 S3：真实软件交付 → GitHub，选择性 HF／魔搭／Kaggle

输入：真实仓库只读快照、准确commit／tag及可公开diff、实际构建／测试记录、许可、获准截图／Demo。另按目标选择真实模型权重／dataset／notebook／Demo之一及输入输出／运行证据；不存在的作品不能被岗位文案补出来。（D）

| 节点／依赖 | 谁做、使用什么 | 必须有的真实结果／门禁 |
| --- | --- | --- |
| S3-P／无 | 四岗位先分别判定作品适配，不默认全选。 | GitHub prepare；只有应用Demo可选择HF Space／魔搭Demo；无模型则model_card skip；无dataset/notebook则Kaggle needs_input或skip，而非空卡片。 |
| S3-G／S3-P | native.prepare读取获准commit／diff／验证材料，text adapter只写准确说明。 | README／release notes／静态diff＋资产清单，记录baseCommit／文件hash／测试来源；命令依当前仓库／官方已核来源；不执行安装、不commit／push／release。 |
| S3-HD／S3-P | HF／魔搭岗位围绕实际Demo编写输入输出／运行条件／许可／边界；英文／中文分别核验。 | README、Demo manifest、真实文件refs、已实际验证或明确未验证的运行状态；“应用”不说成自研模型，不编训练参数或评测。 |
| S3-K／有真实Kaggle作品才建 | native.prepare对获准notebook／数据做静态预览和文件清单；不执行单元格。 | 实际code_file／输入数据版本／许可／真实运行日志与输出若已提供；未运行明确unverified；没有运行证据不能发布“已复现分数”。合成数据保留Synthetic标识。 |
| S3-A／各目标真实文件 | 新native-artifacts验证、私有存储／预览／完整备份／恢复门禁；未落地阻塞。 | 代码／notebook／模型／数据／ZIP不能通过现有mediaAsset类型；不可隐藏在body未批准附件。 |
| S3-Q／每目标最终freeze | 独立checker核对文字、commit／diff、说明和实际文件；人工完整审核。 | 各包实际文件hash和reviewSnapshotHash，不能只审核文章后任意换notebook。 |
| S3-O／另行具体授权 | 独立仓库写入／平台上传／部署动作，逐目标实际回读。 | baseCommit冲突需新候选重审；部署／算力费用另审；源码准备成功不代表Demo在线。 |

Kaggle论坛讨论／评论的AI用途限制不能用选择Writeup来自动绕开；DEV营销／评论限制和脉脉AI接管／模板批量禁令即使不在本例已选目标，也由同一编译器EffectivePolicy的创作／外发两轴及allowedAiActions约束。无适合目标是合法结果，准确skip不算已发布。（B：同次政策记录；D：处理）

## 11. 平台规则、协作分工与可核对交接

政策门禁先于生成和工具派发，具体目的地优先于平台抽象模板。以下规则依据来自同次研究中已取得的官方正文／索引，需执行前按规则快照重新核时效；它们只支持所述范围，不代表本次登录了账号：（B）

- 微信公众号静态规范 [运营规范](https://mp.weixin.qq.com/mp/opshowpage?action=newoplaw)：3.27真实作者主导、3.28模板重复、4.24.2标识。岗位有效模式 author_led_editor_assist；缺真实作者贡献先停，不能全部自动写完后只求最终点头。（D）
- [DEV AI-assisted Articles](https://dev.to/guidelines-for-ai-assisted-articles-on-dev/)：与作者理解、品牌／SEO主目的、评论中AI用途有关的限制；新披露功能未作为撤销旧限制的证据。编译器对不合适营销母版skip，评论仅允许已核范围内本人原文限定校对。（B／D）
- [Kaggle Community Guidelines](https://www.kaggle.com/community-guidelines)：本次只有官方索引实质内容，非直接动态正文；讨论／评论的AI用途、合成数据标识、作品相关性等限制按该证据范围保留。不把有notebook目录等同可执行／可发布。（B／D）
- [脉脉社区管理规范](https://maimai.cn/n/platform/rich-text/que1)：AI接管账号、模板批量和虚构经历等现行限制。岗位仅单篇研究／本人原文编辑，manual_only外发；归档状态不自动恢复。（B／D）
- [Medium AI policy](https://help.medium.com/hc/en-us/articles/22576852947223-Artificial-Intelligence-AI-content-policy) 与 [Distribution Guidelines](https://help.medium.com/hc/en-us/articles/360006362473-Medium-s-Distribution-Guidelines-How-curators-review-stories-for-Boost-General-and-Network-Distribution)：作者主导、生成内容披露、付费墙／分发范围分别判断；披露不保证General／Boost。编译器保存AI参与类别，不承诺分发。（B／D）

本节引用只复用同次已核来源；未另查版本号、外部API写法或价格。完整取得方式／官方支持范围／样本缺口见三组研究，平台内容策略仍为D，不把可访问的样例当规则或流量公式。

| 工作项 | R实际负责 | A最终负责 | C需协商／审核 | 交出什么 |
| --- | --- | --- | --- | --- |
| 母版／事实／真实素材范围 | 本人／内容管理员 | 本人 | 事实／隐私／权利审核者 | MotherBundle及准确输入hash |
| 平台研究与策略 | 具体平台岗位 | 内容主编 | 目的地规则审阅者／本人 | AdaptationPlan建议，证据和skip／gap |
| 校验／编译／预算 | 鹏经理compiler／scheduler | 系统owner | 平台岗位、本机owner | normalizedPlanHash、blueprintHash、scope／budget摘要 |
| 实际媒体／文件加工 | 本机worker＋已批准adapter | 本机owner | 平台编辑／素材owner | 真实artifact manifest和执行／费用receipt |
| 最终润色 | 平台编辑 | 内容主编 | 原作者 | 最终候选包；编辑不自签终检 |
| 独立最终检查 | 独立checker／必要媒体人审 | 质量审核负责人 | 原作者／技术／权利审阅者 | checkedPackageHash、reportHash、覆盖／findings |
| 完整内容批准 | 获授权管理员 | 本人或其明确授权者 | 独立checker | 准确reviewSnapshotHash审批 |
| 外发与回读 | 单次授权发布执行者 | 本人 | 平台账号owner | 实际URL／平台对象＋准确包／资产回读receipt |

同一人可兼任多个行政角色，但模型起草与独立终检上下文必须分离；发布授权不能从“负责生产”继承。高风险L0／L3按既有政策人工／安全处理，不因配置一个运营岗位而放宽。（D；A：既有分类）

交接采用五类不可变 envelope，逐段核对服务端重算hash，不能只传一句自然语言“做完了”：（D）

1. `StrategyHandoff={schema,sourceBundleHash,researchBundleHashes,planHash,targets,effectivePolicies,gaps,compilerVersion}`。
2. `ExecutionHandoff={jobId,targetKey,blueprintHash,taskHash,attemptId,epoch,resolvedInputHash,inputHashes,adapterVersion,scopeHash,budgetAuthorizationHash}`；没有shell／token／任意路径。
3. `ArtifactHandoff={attemptId,actualArtifactRefs,actualManifestHash,executionReceiptHashes,usageReceiptIds,unknownReservations,sourceUntouchedProof}`；failed／dryRun／unknown单列。
4. `ReviewHandoff={candidateId,packageHash,checkContextHash,qualityReportHashes,reviewSnapshotHash,unresolvedFindings,coverage}`；读取最终真实附件。
5. `PublishHandoff={operationId,authorizationSnapshotHash,packageHash,reviewSnapshotHash,targetIdentityHash,receiptId|null,readbackEvidenceHash|null,status}`；准备、批准、发起、验证分别记录。

## 12. P0／P1／P2、实施顺序与明确边界

| 级别 | 具体行为 | 用户不用它会怎样 |
| --- | --- | --- |
| P0 | 28平台岗位档案和严格策略导入；目的地规则／真实作者门禁；有限编译器；双端权限；持久DAG／attempt／预算／unknown；真实产物传输；现有3格式加v3原生包、完整文件预览与实际支持类型；独立最终终检／完整人工审查／运营分离；备份／隔离恢复与旧快照回归。 | 策略仍停留自然语言，成品／费用／稿件／目标容易脱节，无法判断哪个步骤真正完成。 |
| P1 | 从真实人类编辑产生限定账号／目的地／语言的风格候选，人工提升版本；规则更新／母版差异提醒；基于真实口径的运营结果观察。 | 同样问题反复改、旧规则难发现；但不影响P0的事实／权限／最终包正确性。 |
| P2 | 逐平台核实实际权限后的官方传输适配器；受限社区专用回执；多worker调度与多人协作。 | 成品仍可人工／浏览器明确授权执行，缺的是经核实的自动传输，不是内容准备能力。 |

实施按可审变更拆开：①v3迁移／存储／备份与schema、②只校验导入／无执行DAG预览、③单一文本adapter逐request预算、④一条真实本机媒体路径与双端权限、⑤原生文件类型逐类验证、⑥最终包终检／完整审核／operations v3、⑦28平台逐行验收。可以分批工程实现，最终“28岗位已实现”仍要有28行真实适用／缺前提用例，不能只做文章后把其他岗位算完成。（D）

明确不做：任意命令运行；28个岗位共享管理员密码；自动连接社交账号；把全目录一次开放；自动购买／部署／推送／外发；自动训练／下载模型；默认ASR／TTS／新镜头生成；执行外来notebook或仓库安装脚本；以去AI味绕过标识；保证推荐／流量；未经批准把学习变成事实／权限；用当前公开URL合同伪装受限社区已交付。原始源码／资产／成功源片保留，本方案不要求重新生成既有成功素材。（D）

## 13. 验收矩阵：设计齐全，运行结果明确未执行

以下是后续实施验收用例，**每行本次实际结果均为“未实施、未执行”**。本次只对设计文件做结构／来源／hash验证，没有借现有系统测试冒充新compiler／worker验收。（D）

| 用例／维度 | 前置条件 | 步骤 | 预期结果 | 本次实际 |
| --- | --- | --- | --- | --- |
| I01 正常导入 | 合法母版／目标／规则／预算 | validate再创建job | 计划／输入hash正确、分目标DAG，无模型副作用 | 未实施、未执行 |
| I02 28平台覆盖 | 28岗位档案，各有适用及缺前提样例 | 每平台至少一条原生成品／一条blocked或skip | 无遗漏目标；不以脚本当视频或说明文当模型 | 未实施、未执行 |
| I03 边界目标 | 0／1／28／29、重复targetKey | 导入并编译 | 1—28合法；重复／0／29拒绝；同平台异账号隔离 | 未实施、未执行 |
| I04 JSON攻击／字符 | 重复键／未知字段／深嵌套／超1MB／emoji／中英文／代码 | 解析、预览、导出 | 非法拒绝；合法原文保留，无截断／注入 | 未实施、未执行 |
| I05 来源／Claim变化 | validate后母版或Claim改版／过期 | 创建／dispatch／审核／发布各节点检查 | SOURCE_OUTDATED／CLAIM_CHANGED，保留历史并重审 | 未实施、未执行 |
| I06 DAG／类型 | 环、缺依赖、错locale／settings／产物 | 导入 | 明确拒绝，不静默删任务或假成功 | 未实施、未执行 |
| I07 arbitrary tool注入 | 命令／argv／URL／path藏在计划或原文 | compiler与worker接收 | 当资料或拒绝字段；无shell／下载／提权 | 未实施、未执行 |
| I08 目录／ready | 大334目录存在、native24项、一项disabled | 尝试调用未适配工具／disabled项 | ADAPTER_NOT_READY／禁用失败；目录不升级ready | 未实施、未执行 |
| I09 双端权限 | 云端准、本机拒；本机准、云端拒；过期scope | claim／dispatch／读取 | 每种越权403；现有Agent仍不能编辑 | 未实施、未执行 |
| I10 租约／并发 | 两worker争同task、旧epoch迟到 | 同时claim、过期后complete | 单一有效epoch；旧结果隔离；已派发unknown不自动重派 | 未实施、未执行 |
| I11 幂等／版本 | 同key同体／同key异体、旧／缺ETag | 创建／dispatch／上传提交／materialize重复 | 原结果恢复，无重复扣费／建稿；409／412／428准确 | 未实施、未执行 |
| I12 底层多请求 | generateContent两轮、TTS多chunk、视觉端点切换 | 通过受控adapter运行／制造失败 | 每个实际请求独立预留；隐藏重试不允许绕过 | 未实施、未执行 |
| I13 最后额度并发 | 金额／calls／token任一只余一次额度 | 两target同时派发含finalQC | 原子预留仅一个成功，另一个blocked_budget | 未实施、未执行 |
| I14 价格／单位 | 缺价格／过期／混币／溢出／不可约束计费维度 | 付费dispatch | PRICING_REQUIRED等，不发；真实费用null不当0 | 未实施、未执行 |
| I15 超时unknown | 已发请求响应丢失 | 超时、重启、取消、归档、新尝试、对账 | 旧预留保留；新尝试不清账；精确证据才结算 | 未实施、未执行 |
| I16 取消／deadline | inFlight＋排队任务 | 取消／到期并接迟到结果 | 不启动新费用／副作用；只审计迟到，不自动继续 | 未实施、未执行 |
| I17 文件边界 | symlink／FIFO／越界／hash错／尺寸超／unsupported | 本机读取、上传、commit | 失败可见，无源覆盖；新对象不可被错误引用 | 未实施、未执行 |
| I18 媒体与真实成品 | 无视频／无cue／坏MP4／无模型／空notebook | 对应目标准备 | ARTIFACT_MISSING等；无伪造字幕／截图／训练／分数 | 未实施、未执行 |
| I19 形式与语言 | 同Story中文章→图文／视频＋英文 | 编译／materialize，双目标并发建中立稿 | 显式lineage，不挪sourceEditionId，不互替平台母版；family CAS | 未实施、未执行 |
| I20 receipt语义 | dryRun、executed:false、synced:false、technical passed/art unverified | worker提交complete | 不能算成品／最终质量完成；缺维度needs_input | 未实施、未执行 |
| I21 作者／平台规则 | OA缺作者、DEV营销／AI评论、Kaggle论坛、脉脉批量 | compile至draft／external | 生成前阻塞／限定校对／manual_only，不因人审放宽规则 | 未实施、未执行 |
| I22 最终润色／hash | 润色前QC通过 | 改标题／正文／顺序／视频／字幕／文件／native设置后各门禁 | 旧报告过期，独立重读最终包，预算不足不放行 | 未实施、未执行 |
| I23 终检真实性 | 伪passed、错checkedPackageHash／报告hash／checker版本 | submit／approve／schedule／start | 服务端重算与执行授权核对，全部不符阻塞 | 未实施、未执行 |
| I24 完整预览 | 多图／线程／视频／双语字幕／document／notebook | 桌面和移动查看全部有序项、播放／切换 | 内容完整可读、无溢出；不能藏未审附件／设置 | 未实施、未执行 |
| I25 发布与未知 | 已审核排期、一次准确外发授权 | 发起后丢响应、实际回读／reconcile | 只对准确原包入账；未知不重发；restricted不假公开URL | 未实施、未执行 |
| I26 迁移／回归 | 真实v1／v2历史、全媒体、v3工单／账本 | dry-run→备份→v3迁移→旧快照／官网／动作回归 | 保护集合／历史hash不变；旧程序拒开v3；新包完整入审批 | 未实施、未执行 |
| I27 完整恢复 | v3数据、native文件、媒体、报告、预算、幂等、租约 | 完整备份到全新隔离目录、逐文件hash与事件验证、重启恢复 | 无丢引用／清未知；不覆盖live；restore前无假verified | 未实施、未执行 |
| I28 部分失败／学习隔离 | 28项部分成功，两个账号／语言／社区 | 一项失败，提升一条风格候选／回滚 | 保留成功；总任务非假全成；限定scope不改事实／权限 | 未实施、未执行 |

覆盖率需要分开报告：岗位28／28；本次选中目标N／N；真实生产产物K／K；最终质检维度与实际覆盖；真实发布回读M／M；预算已结算／预留／未知。准确skip不算发布成功，未选择平台不混入成功率。体验QA另须实际桌面／移动运行截图；本提案没有生成新页面，因此不以HTML原型截图代真实员工能力。（D）

## 收尾报告

- **已完成**：当前源码与正式main manifest衔接核对；至少2候选比较并选定“受控compiler＋本机worker”；正式AdaptationPlan与导入不变量；24＋2原生面／334目录区别；实际text／visual／post／subtitle／voice接点和ready边界；严格任务／权限／文件投影；Edition／Variant跨形式与v3原生包；独立最终QC与人工／运营／回读哈希链；逐底层请求预算、unknown、取消／重启／幂等；3个完整示例；协作RACI／5类交接；P0／P1／P2及28组验收设计。
- **未完成／未覆盖**：本稿按“先方案对齐”的授权只做设计；没有新compiler／worker／接口／schema迁移／员工运行、模型调用／媒体产物／平台外发。大引擎9,316行及其传递依赖未完整语义审计，未对334工具逐一运行；实际账号／费用／运行ready未核。CLI list因exec PATH无node未执行；这些没有被说成通过。
- **自主追加事项及理由**：补入隐藏多请求逐attempt预算、dryRun／synced区别、校验快照ID、可空预算草稿与新修订授权绑定、创作／外发双轴规则、同族Edition并发、真实媒体类型和新附件备份门禁，因为仅自然语言策略＋现有目录无法保证真实生产、预算或完整审批；A10独立复核的来源精度项已修并留稳定hash，不改变平台方向或生产范围。
- **采用的假设**：本人＋获授权管理员；AI／工程／产品内容定位；每工单最多28目标，模型并发2／重型本机渲染1仅为提议；cloud origin与本机受控工位均由owner配置；金额／价格不默认；单一写者JSON继续适用，未来容量不足再单独评估存储迁移。
- **置信度**：现有A文件的接点／冲突高，manifest全选文件比对高；C引擎仅选段且跨依赖未审，执行ready不作保证；方案结构与权限／预算／哈希合同可逐字段审查，实施成本与质量效果尚无实测。
- **建议复核**：①平台策略导入、双端权限与按底层请求预留是否符合本人预期；②3场景的真实成品／缺口与原声／作者参与边界；③最终包润色后独立终检、完整人工审核和外发另行授权的准确绑定。

## 自检表

- [是] 覆盖了本次完整集成设计范围，包括现状冲突、可落地合同、异常／权限／回归及3种实际生产场景，没有只写概念流程。
- [是] 可自主完成的源码阅读、manifest比对、方案选型与验证已完成；没有要求用户替代常规工程决策，也没有提前执行未授权生产。
- [是] A／B／C／D、当前／拟议、目录／ready／真实生产、结构校验／运行验收均准确分开；具体结论有函数／来源／哈希依据，未核项逐项声明。
- [是] 计划字段、任务投影、文件／费用／状态转换、最终hash链与未来用例可由资深工程师逐项复核，无空实现冒充功能完成。
<!-- promoted-source-body:end -->

# 28 个内容运营岗位：产品与岗位设计

> **文档状态：研究／设计归档，新增员工能力尚未实现，待产品方案对焦。** 这是 2026-10-25 同次研究的完整正文晋升。研究所分析的代码基线是 main `4e521c6f9645d7ddde29aae27b0df24bc7610e2e`；正文中的覆盖率、历史动作和验收结果属于原作者的该次研究，不是本次文档发布后的新运行回执。文档进入仓库不创建岗位、compiler、worker、接口、模型任务或外部发布权限。
>
> 原文标为 JSON、provenance、原始抓取、缓存、独立审阅回执的文件名／目录名，均保留为**原研究取证标识**；它们未随本文入库，不是当前仓库文件或可点击下载。公开来源 URL、取得范围、证据 A／B／C／D 和样本访问缺口完整保留。仓库代码路径相对本仓库根目录。本文仅改正原工作区绝对路径／临时路径的可移植表达，并清理原文尾空格，未删减研究正文。
>
> 原始正文取证标识：`platform-content-employees-proposal.md`；SHA-256：`fd4faa180bee48f4cf80b04f0f44d4eb3fddd0bac6b8e6e8a41b67abc8959d40`。早期产品矩阵为概要；平台限制以三组档案中明确支持的官方来源范围及执行前重新核实的规则为准；编译／执行的详细合同见二次生产集成方案。原文拟议 API、类型与验收仍为 D 级，实际可调用接口见现有接入指南和 API 文档。

三组研究中的 AdaptationPlan／toolTask 字段属于**岗位需求的语义规格**；涉及精确 schema／API、静态编译蓝图与运行期输入 hash、worker 与管理员分工时，以[二次生产集成方案](PLATFORM-SECONDARY-PRODUCTION.md)第 4—9、11 节为本批文档唯一的后续设计合同。旧字段、旧接口或通用自动准备措辞不并行实施；早期 priorOutputHashes 等语义需求须按该合同分别映射为编译期逻辑依赖和运行期 resolvedInputHash，不能把未来产物／package／终检 hash 回写静态蓝图。研究中的 review／receipt／productionTasks 等语义展示不定义最终哈希载荷；最终以 PublicationPackage → 包外 QualityReport → ReviewEnvelope 及静态 blueprint／运行期 input 的分离为准，旧示意不得把报告、approval 或未来产物 hash 塞回包或蓝图。历史研究中的“需补能力”清单也不表示本期 worker 已纳入；本期 allowlist 与不做项以最新集成为准，例如 notebook 仅静态预览、executeCode:false，不运行单元格，隔离执行需另立实施授权及验证合同。研究中的 documented_cli／参考 command 示例是历史或人工正式 CLI 说明，不是 worker 可执行清单；worker 只能从最新集成的固定 adapter 投影编译任务，不能回放 production.plan 返回的命令。该优先序说明不把任何设计变成已实现接口。

[A 组研究](platform-research/group-a.md) · [B 组研究](platform-research/group-b.md) · [C 组研究](platform-research/group-c.md) · [产品与岗位方案](CONTENT-OPERATORS-DESIGN.md) · [二次生产集成方案](PLATFORM-SECONDARY-PRODUCTION.md) · [AI 接入指南](AI-AGENT-GUIDE.md)

## 修订优先序与已取代内容

本篇保留早期产品提案全文，用于审阅岗位目标与设计取舍。**28 个岗位是能力覆盖目标，不是 28 个平台都允许 AI 起草整稿，也不是自动铺发许可。** 自动准备只可执行具体平台、目的地和本次授权共同允许的 AI 操作；不适合的目标应 skip／needs_input，不能先统一生成再靠最终人审补救。

实际创作前须分别核对：公众号真实作者主导与作者贡献；DEV／Kaggle 评论、讨论仅在已核实允许的本人原文翻译／语法等范围内辅助；脉脉仅单篇本人原文研究／编辑，不允许 AI 接管账号或模板化批量运营；Medium 的真实作者材料、AI 披露、分发资格及 Partner 付费墙资格分别判断。具体例外与适用范围以三组研究列明的官方资料及执行前新核的规则为准；人工最终审批不豁免禁止的创作方式。

**本篇旧的通用生成／自动准备流程和拟议 API 表，已由[二次生产集成方案](PLATFORM-SECONDARY-PRODUCTION.md)第 4—9、11 节的后续合同取代，不是可以并行择用的执行指令。** 其中 jobs 只能消费同一准确校验快照的 validatedImportId；预算从 null 补齐必须新建 plan revision／hash 并重新 validate；materialize 由管理员执行、只形成待核草稿；编译期静态 blueprintHash 与运行期 resolvedInputHash 分离，不能把未来 package／终检报告回写蓝图形成循环。最终润色后的独立终检、完整人工审核和单目标外发仍分别进行。

上述后续合同也仍是 **D 级未实施设计，待方案对焦**；旧表和新表都不代表当前已有 content-ops API。当前真实入口继续以 [AI 接入指南](AI-AGENT-GUIDE.md)、[现有编辑合同](CONTENT-PUBLISHING.md)和 [HTTP API](API.md)为准。

<!-- promoted-source-body:start -->
## 覆盖率声明

- 本方案限定阅读范围：10 个文件；精读 A：9；机检／结构解析 B：1；抽样 C：0；范围内未读：0。方案本身为 D 级设计，尚未编码、调用模型或执行任何平台发布。
- 精读清单：仓库 AGENTS.md、docs/AI-AGENT-GUIDE.md、data/platform-catalog.json、docs/CONTENT-PUBLISHING.md、src/services/editorial-service.mjs、src/domain/editorial.mjs、src/domain/platform-catalog.mjs、src/domain/policy.mjs，以及 原研究取证标识：editorial-implementation-contract.md。大文件已分段读至末尾。
- 机检清单：原研究取证标识：platform-matrix-research.json（未随本文入库）（2026-10-25 同次任务的 27 个官方来源、定位、限制和目录研究）；读取结构与全部来源条目，没有把 1,638 行 JSON 的结构解析称为全文精读。
- 范围边界：这是一份内容运营员工的产品与衔接方案，没有重做整个仓库审计，也没有把当前代码验证或平台目录视为已经接通 27 个外部平台。
- 证据标记：A＝实际精读代码／现有文档；B＝结构解析、官方检索正文或元数据；C＝抽样；D＝产品建议、假设或未实测。下面的平台写法均为 D 级建议；链接只支持明确列出的平台形态与规则事实，不支持所谓算法偏好或流量保证。

建议把这项能力定义为：**28 个平台内容运营岗位，围绕同一份事实母版，各自完成原生策划、深度改写、独立质检和最终润色，交付可逐项审核的发布包；同一个平台的不同账号、社区和语言保留自己的风格与规则。** 岗位身份持续存在，任务按需运行。每篇内容是否进入某个平台，由内容与目的地的匹配度决定，不要求把所有母版硬发 28 份。（D）

这比复制母版后改标题更有用：用户得到的应当是能在目标平台直接审核和使用的成品，包含正文结构、图片顺序、脚本、字幕、标签、作品文件和发布设置等实际需要的材料。没有真实素材、作品或权限时，员工明确交付“阻塞／不适合”的理由，不能把一段建议冒充成品。（D）

### 给谁用、解决什么问题

目标用户是独立经营多个中文、英文内容阵地的本人及获授权管理员。当前假设内容定位仍为 AI 产品、Agent 与工程实践；不自主增加“模型作者”“客户成功案例”“投资意见”等身份。日常使用只需要选母版、选目的地、看每个平台的完整差异并确认最终成品；平台篇幅、社区上下文与素材编排由员工处理。（D）

三个关键收益对应三个可验证结果：第一，减少重复编辑，审核页能看到一份母版如何形成不同结构的成品；第二，减少内容失真，每个新增论断能追溯到已批准事实或被标为待核验；第三，减少错发和串号，每份成品固定账号、目的地、语言和准确文件哈希，随后沿独立授权链发布。（D）

### 四个具体场景

1. **中文产品实践**。母版是一次真实功能交付复盘及已获准截图。官网稿保留完整过程与证据；公众号改成问题—做法—结果—限制；小红书做可读的步骤卡；哔哩哔哩形成演示脚本、章节、封面与真实视频任务。没有渲染好的视频时，哔哩哔哩显示“等待视频文件”，不能显示成品完成。（假设场景，D）
2. **真实技术发布**。母版绑定具体仓库、commit／tag、变更和实测记录。GitHub 员工整理实际 release／README 变更；Hugging Face 与魔搭先判断是否有模型、数据集或可运行 Demo；Kaggle 只有在有数据、评测或 notebook 时开任务。员工不能为了凑渠道凭空生成模型卡、虚构安装成功或宣布开源。（假设场景，D）
3. **英文专业案例**。同一真实案例另建英文母版，核对专业术语、数字、身份和引用。LinkedIn 强调工作的选择与影响；X 形成有独立价值的短帖或串；Medium 保留完整英文叙事；YouTube 重写为先演示、再解释的英语脚本。每个平台分别润色，不把逐句翻译当深度适配。（假设场景，D）
4. **社区问题回应**。用户选中一个具体 subreddit 问题或 Discord 主题。员工先读该目的地的规则和对话上下文，先解决问题，再决定是否需要引用本人作品；不相关、禁止推广或没有权限时跳过。即使成稿已完成，发送仍需要针对这个社区与这份内容的明确授权。（假设场景，D）

### 当前基础与必须补齐的衔接

| 当前事实 | 对方案的影响 |
|---|---|
| Story→Edition→Variant 已存在；Edition 按选题、语言、形式形成不可变修订族，重复建同族版本必须明确替代最新修订。定位：EditorialService.createEdition，390 行起。（A） | 母版与其各形式版本可复用现有数据，不能给 28 个平台各建一个互相替代的“中立母版”。 |
| createVariant 可独立修改标题、摘要、完整正文、blocks、assetRefs、adaptationNote，并保存具体目的地／账号快照；它的 locale 和 format 继承来源 Edition。定位：createVariant，422 行起。（A） | 可承接同形式的平台深改；文章变视频或图文需要先产生另一形式的中立版本，不能只换个目标平台。 |
| sourceEditionId 校验为同一选题、相同形式、不同语言；现有状态完整性检查也保持此规则。定位：createEdition 的 406 行附近；assertEditorialStateIntegrity 的翻译分支。（A） | 新增 derivedFromEditionIds／formatLineage 表达跨形式派生；不挪用翻译字段，避免破坏现有完整性规则。 |
| 现有形式只有 article、image_text、video；批准快照包含正文、结构、媒体引用和目标身份。定位：EDITORIAL_FORMATS、editorialVariantSnapshot、validateEditorialVariant。（A） | PDF 文档、帖子串、notebook、模型卡、仓库变更等需要可枚举且可哈希的原生发布包，不应塞入一个未被批准的任意附加字段。 |
| 内容批准要求 reviewed:true 和准确 snapshotHash，之后才能排期；新编辑写入拒绝 method:'agent'。定位：#write、transitionVariant。（A） | 生成员工不能借已有管理员接口越权批准。新增有限的“准备草稿”能力，人工审批继续独立。 |
| 官网激活有真实媒体核对、完整备份与路线比较交换；完成入账依赖服务端真实回读。定位：publishRelease、verifyRelease。（A） | 内容员工产出可以接入已有官网链；模型自评分、上传成功或 HTTP 200 都不能替代发布回执。 |
| 目录 28 项保留稳定 ID；外部平台是 manual_not_connected。目录不是登录、OAuth、API 或发布许可。定位：data/platform-catalog.json、platformCatalog。（A） | 本期方案讨论的是 28 个内容岗位的生产与审核能力；不能把“内容已备好”和“外部平台已接通”合并。 |

代码定位对应目录：本仓库根目录。上表是当前基础分析；以下接口、集合与员工行为均为拟议扩展，没有宣称已经实现。

### 方案对比与选定

| 候选 | 优点 | 成本与风险 | 适用前提 |
|---|---|---|---|
| A：28 个独立常驻 Agent，每个长期保持自己的会话与运行器。（D） | 岗位直观，容易单独调试。 | 28 套运行状态、权限和恢复逻辑；事实与规则版本容易分叉；长会话会混入过期稿件；并发模型与主机成本更难控制。 | 有多人运营、独立班组与充足运行预算，并愿意维护独立执行器。 |
| **B：一个持久编排器＋28 个版本化岗位档案＋每个任务独立上下文＋独立质检调用。（推荐，D）** | 事实、预算、审批和恢复统一；每个平台仍有独立策略、账号风格、目的地规则与工单；可以限并发和逐项重跑。 | 需要认真设计岗位档案、任务状态和原生包审核；不能只给一个通用 prompt 换平台名。 | 当前单人运营、小型主机和现有单写者存储；后续可把执行器拆开而不改岗位合同。 |
| C：一个 prompt 一次输出 28 段改写。（D） | 首次实现便宜。 | 容易同文异标题；缺少逐平台依据、素材和失败状态；后半部分质量易下降；无法可靠绑定每项审批。 | 临时头脑风暴。不能作为本需求交付。 |

选 B。用户看到的是 28 位有岗位卡、有工作记录、有能力边界的运营师；后台按需给相应岗位派任务。跨平台事实由共享事实账本约束，账号风格与社区规则分别存放。事实核验与最后润色使用独立步骤，不能在一个生成结果末尾加一句“已检查”就算通过。（D）

拟议运行规模：单个管理员，日常 0—3 份新母版，每个工单最多 28 个目的地，同时最多 2 次模型调用。以上只是启动配置与容量假设，不是当前系统实测性能；实际 token、费用和耗时应按模型回执展示。视频制作沿既有本地制作能力和实际素材流程执行，任何付费渲染、算力或订阅都不因创建工单自动获准。（D）

### 核心流程与员工职责

1. **立项**：选择完整母版修订、可公开事实、真实素材、目标语言、具体账号／目的地、运营目标与本次费用上限。只创建准备任务，不顺带批准或发送。（D）
2. **冻结输入**：记录母版哈希、Claim 指纹、权利状态、账号与目的地身份版本、岗位版本、规则版本、风格记忆版本和去重指纹。（D）
3. **平台策划**：岗位先交出 readerNeed、angle、nativeForm、结构、必需素材、应删的母版部分、是否适合以及理由。结果只能是 prepare／skip／blocked，不能默默缺席。（D）
4. **深度适配**：重组切入点、论证顺序、例子、节奏与媒体；保留事实和作者立场。补充外部信息时只产生“待核 Claim”，不得自封为已批准事实。跨形式先建中立形式版本，再建平台成品。（D）
5. **独立核验**：确定性校验原生包和引用；独立模型上下文检查事实扩大、遗漏条件、虚构截图、翻译偏差及目标规则。每条 finding 关联具体句段或文件，给 blocker／major／minor 和修复建议。提议最多自动返修 2 次；仍不合格则停为 needs_input／blocked。（D）
6. **最终润色与终检**：平台员工对核验后的完整稿做最后一次编辑，清理口号、翻译腔、重复信息、模糊 CTA 和标题夸大；随后由独立检查上下文重新读取这一最终包，完成语义、事实、原生规则与实际附件的终检，不能只重算哈希或复用润色前的机器结论。最终报告必须绑定 checkedPackageHash、reportHash 与 checkerVersion；任何标题、正文、顺序、附件或原生设置变化都使旧报告过期。润色不允许新增事实或覆盖质检记录，终检未通过则不能 ready_for_review。（D）
7. **人工定稿**：逐目的地展示全文、母版差异、图片顺序与实际预览、真实文件、字幕、原生设置、目标身份和未决问题；同时核对终检报告对应的准确 packageHash 与报告哈希，再确认完整 reviewSnapshotHash。审核后任何实质变动建立新候选，旧质检与待发布审批不再适用，须终检和重审。（D）
8. **排期与发布**：提交至现有内容审核／排期链，再为具体平台的一次外发单独授权。官网继续独立公开快照审批、备份、激活、真实回读。外部可选择经明确授权的人工／浏览器发布；没有已核实连接器时不显示“自动发布”。（D）
9. **回读与学习**：记录真实 URL、实际时间、正文／文件或平台对象核对结果，成功后形成回执；失败、不确定和导出待人工分别显示。人类修订与真实反馈只形成记忆候选，再经批准生效。（D）

拟议岗位状态：idle→planning→drafting→checking→revising→polishing→final_checking→ready_for_review；可分支 skipped／blocked／failed／cancelled／deadline_exceeded。final_checking 的独立终检必须通过，不能从 polishing 直接跳到 ready_for_review。成品审核与发布状态沿独立轨道：draft→fact_check→approved→scheduled→外部动作／官网修订→verified。生成完成、最终机器质检通过、人工批准、真实发布四个时间必须分别呈现。（D）

### 28 个岗位的深度适配矩阵

以下完整覆盖当前目录 28 个稳定 ID。每行都是产品策略建议 D；列出的原生形态是拟提供的成品类型，实际账号权限和平台当前限制必须在执行前核对。默认归档渠道仍有岗位档案和验收用例，是否恢复实际运营由明确任务决定，不因目录存在自动启用。（D）

| 平台／岗位 | 读者任务与原生成品 | 深度适配：具体重做什么 | 最终润色与验收重点 | 执行前提 |
|---|---|---|---|---|
| official-site 个人官网主编 | 寻找完整作品与可信事实；中文／英文文章、图文、视频文稿 | 留完整证据、过程、适用边界与正式来源；正文结构、媒体与作者定位形成长期可读页面 | 标题准确、目录与段落清楚、图注／替代文字／字幕齐全；两种语言各自完整，正式地址稳定 | 现有公开目的地、合格 Claim、真实媒体；官网完整审批和服务端回读 |
| wechat-official 公众号编辑 | 中文读者一次看懂一件事；完整长文／图文 | 重写开篇问题、段落层次和案例解释；把工程术语转成具体行为；保留可理解的证据与限制 | 手机阅读、标题与结果一致；开头能说明值得读什么；图注与链接位置可审 | 实际公众号、当前规则与编辑器核验；不推定 API 权限 |
| xiaohongshu 小红书编辑 | 读者收藏可执行做法；图文卡片或短视频 | 每张卡片只承担一个信息任务；重做封面题、步骤顺序、实际截图批注、正文补充与相关话题 | 逐张可读，封面不许夸大；卡片顺序与正文一致；最后给明确使用条件 | 真实图片／实际短视频和权利；账号及当前发布形态核验 |
| bilibili 哔哩哔哩编导 | 观众看懂并能复现；演示视频、章节、说明 | 重做可视化讲解、操作演示、失败案例和章节；母版文字变口语脚本，屏幕上有对应证据 | 成片可播放；口播、画面与字幕一致；封面与标题不承诺未展示能力 | 真实成片、封面、字幕、授权音乐；已核实账号 |
| linkedin LinkedIn 编辑 | 同行理解专业判断；专业短帖、文档组页或文章 | 从“我做了什么”转为问题、决策、约束与可借鉴影响；中文案例补足英文背景；文档按论证分页 | 职业身份准确、数字有来源；去口号与直译；文档每页独立可懂 | 具体个人／Page 目的地；文档等新文件必须经新原生包校验 |
| x X 编辑 | 快速理解一个有证据的观点；单帖或编号串 | 选一个核心判断；拆成每条有信息的推进；演示放适当位置；论断与限定词不因压缩丢失 | 开头能独立成立，线程顺序与附件匹配；去无关标签、重复引流与悬空结论 | 实际账号；执行前核对当前文字／媒体和账号权益限制 |
| youtube YouTube 编导 | 搜索并看完整解释；长视频或独立短片 | 重做开头演示、学习路径、镜头表、章节、说明、语言与字幕；短片只讲一个完整问题 | 实际成片与缩略图一致；章节时间正确；可见范围、受众、合成内容等设置逐项审 | 真实视频、权利与频道权限；处理完成和实际公开分别核验 |
| github GitHub 发布编辑 | 开发者取得可用软件；README／release／discussion 变更包 | 绑定真实仓库与 tag／commit；说明变更、使用、迁移、限制、验证结果；给准确文件 diff 与资产清单 | 命令来自当前仓库／官方依据且可验证；版本不编造；不夹带宣传或假下载 | 真实仓库、授权范围及相应作品；代码写入／release 另行明确授权 |
| huggingface Hugging Face 作品编辑 | 使用或复现实物；Space、模型卡、数据集卡或技术文章 | 先识别真实作品类型；讲输入输出、示例、许可、限制和已完成评测；模型卡与 Demo 各有模板 | 示例能对应实际作品；模型／数据来源和许可有据；没有模型时不填训练结果 | 实际作品及可分享权利；算力与部署预算另审 |
| modelscope 魔搭作品编辑 | 中文使用者体验作品；在线 Demo／模型说明／数据说明 | 把实际作品改写为中文使用路径、运行条件、示例与边界；平台原生文件与依赖清单随包给出 | 说明与实际 Demo／文件一致；不把应用当自研模型；不编造评测和免费算力 | 真实模型／数据／Demo 之一；当前平台指南与权限核验 |
| tiktok TikTok 编导 | 快速看懂一个结果或步骤；短视频／照片稿 | 重写英语或目标语言的视觉开场、连续演示、口语字幕、说明与声音方案；图片稿按步骤重排 | 视觉可理解、字幕安全区与节奏实际检查；标题不夸大；声音权利可追溯 | 实际文件与账号；Direct Post 需要独立应用／scope／用户授权与审计条件 |
| instagram Instagram 编辑 | 看清作品和视觉过程；Reel／多图／照片 | 先做视觉叙事；重做封面、逐图说明、过程截图和简洁文字；不照搬 X 串或公众号长段 | 图组风格与信息顺序一致；说明与 alt 完整；音视频和文字不矛盾 | 真实视觉资产、明确账号；当前原生格式核验 |
| facebook Facebook 编辑 | 在具体关系或群体上下文理解内容；文字配图／视频稿 | 说明受众背景、实际价值与讨论点；Page、个人动态与 Group 分别策划，群组规则单独绑定 | 受众和可见范围明确；不机械同步 Instagram；问题有实际可回答内容 | 明确 profile／Page／Group，权限和社区规则；不同目的地独立审批 |
| douyin 抖音编导 | 通过直观演示学会一件事；中文短视频 | 挑一个动作与结果；重做镜头、口播、屏幕字幕、封面与结尾；长篇背景只保留必要条件 | 可视证据跟得上口播；成片无多余铺垫和夸张保证；字幕与截图清楚 | 真实成片与权利；创作者账号和当前配置核验 |
| wechat-channels 视频号编导 | 中文关系链读者理解案例；解释／演示视频 | 补足人物与场景背景，突出可信过程；口语叙事与视频说明独立编辑，不简单搬抖音 | 人物身份、标题与案例一致；字幕和转发说明准确；不虚构客户背书 | 真实视频、授权与具体视频号身份 |
| zhihu 知乎编辑 | 解决一个具体问题；回答或专题文章 | 先回答题目；定义前提、比较方案、给实际证据与局限；将无关母版段落删掉 | 每节都能对应问题；结论不过度概括；引用与自有作品关系透明 | 真实问题／专栏目的地、当前规则；与题目无关则 skip |
| reddit Reddit 社区编辑 | 获得相关解答或讨论；指定 subreddit 的帖子／回复 | 阅读问题和社区规则；写原生英文上下文、可检验例子和具体问题；需要时披露作者关联 | 先解决对方问题；链接与自荐比例遵从实际规则；不刷相同文本 | 确定 subreddit／thread、规则与成员权限；禁止推广则 skip |
| discord Discord 社区编辑 | 在一个频道获得帮助；消息／forum 主题／回复 | 针对已有对话做短答、必要代码块和 Demo；论坛标题、标签与频道规范单独适配 | 不打断无关讨论、不越界群发；敏感信息不进入公共记忆 | serverId＋channelId＋threadId（如有）及当前权限；私密／受限结果不能冒充公开 URL 回执 |
| jike 即刻编辑 | 同行看到真实过程与观点；观察短帖／图文／Demo | 从母版提炼一个亲历细节、取舍或阶段进展；保留个人口吻和可讨论点 | 去新闻稿语气与虚假亲历；一帖一个主题；配图确实支持观点 | 实际账号、当前原生形态与目的地规则核验 |
| juejin 掘金技术编辑 | 中文开发者复现实现；技术文章 | 以场景、环境、步骤、关键代码、失败处理和验证组织；具体命令依仓库／官方来源 | 代码可读且与实现一致；说明适用版本与限制；不把营销文改个标题当教程 | 真实代码与验证材料；当前技术信息需重新核实 |
| csdn CSDN 技术编辑 | 找到具体问题的可靠解法；故障／教程文章 | 针对搜索问题说明症状、前提、根因、解决步骤和检查方法；保留来源与版本 | 标题与实际故障相符；命令和结果可查；不复制无关目录或堆词 | 真实复现／实现证据、授权代码与当前编辑规则 |
| devto DEV 技术编辑 | 英文开发者理解和复现；Markdown 技术文章 | 重写英文解释、可运行样例和教训；整理正文标题、图像 alt、相关标签与 canonical 元数据 | Markdown 与嵌入实际可预览；官方首发地址准确；草稿链接不当私密资料 | 当前编辑规则；敏感母版不上传到公开但隐蔽的草稿地址 |
| medium Medium 编辑 | 一次读完完整的英文观点与案例；长文 | 重做叙事弧线、必要背景、段落节奏和证据解释；保留作者声音及局限 | 不用空泛开头；引文准确；图片／嵌入权利与解释完整 | 实际账号、文章目的地和当前编辑规则 |
| hashnode Hashnode 编辑 | 持续阅读开发博客；技术文章 | 以实践问题与实现路径组织英文稿；系列关系、代码、图片和原始文章信息单独整理 | 代码与来源准确；博客身份与首发关系明确；不复制 DEV front matter 冒充原生设置 | 实际博客目的地；API／付费条件当次核实，不能默认开通 |
| kaggle Kaggle 作品编辑 | 重现评测或使用数据；notebook／数据集／模型说明 | 交付真实可执行 notebook、数据字典、来源许可、依赖及已完成运行记录；说明实验限制 | 结果对应真实输出；无数据泄漏或虚构分数；文件和文字共同审核 | 实际数据／notebook／模型及许可；无实物则 skip，不能发空卡片 |
| baijiahao 百家号编辑 | 非技术读者了解一个具体应用；可读文章 | 解释陌生概念、具体场景与来源；删除需要大量上下文的内部术语 | 标题与内容对应；不杜撰趋势、市场数据或“必然替代”结论 | 默认归档保留历史；明确恢复任务后核实账号与规则 |
| toutiao 今日头条编辑 | 看懂实际事件或方法；图文／视频稿 | 重写普通读者能理解的开头与段落；有真实图像则编排，有成片再选视频 | 杜绝夸张标题与虚构新闻性；图文／视频说明一致 | 默认归档；明确恢复、真实素材、账号与当前形态核验 |
| maimai 脉脉编辑 | 理解职业实践或团队方法；专业动态／文章 | 围绕个人可证实的工作判断和经验；写清行业背景、取舍与可借鉴做法 | 不披露雇主／客户隐私，不编造招聘关系或职务；去无关流量话术 | 默认归档；只有职业目标明确时恢复；身份及隐私复核 |

每个岗位 P0 的验收最小成品是本行的一种**适配且实际成立**的原生包。视频岗位需至少一份真实短成片／完整视频包；技术作品岗位需真实作品或在“不适合”用例中正确跳过。把“写了脚本”统计成“视频已完成”，或把“说明文”统计成“可运行 notebook”，均不通过。（D）

### 原生发布包与跨形式模型

拟议关系为：Story＋事实资料包→精确母版 Edition→中立 FormatEdition→平台 NativeCandidate→完整 PublicationPackage→内容批准→具体发布动作／官网修订→真实回执。（D）

- **母版资料包 MotherBundle**：准确母版 ID／hash、已批准 Claim 及指纹、故事主张、必须保留的限定、禁止新增的身份／数据／背书、真实资产与使用权、外部材料的可信边界。母版是可追溯资料集合，不是一段长 prompt。（D）
- **FormatEdition**：复用现有 Edition 的中立语言／形式版本；新增显式 formatLineage，记录输入 Edition IDs／hash、转换目标与转换说明，并把 lineageHash 纳入新版本 Edition 的不可变快照；独立集合只是查找与审计入口，不能成为可在审批后改写的旁路。跨语言仍按现有 sourceEditionId 语义；跨形式另行记录。不同平台的叙事在 Variant／NativeCandidate 层变化，不污染中立修订族。（D）
- **PublicationPackage**：最终发布载荷包含 schema、nativeForm、最终标题／正文／有序分段、有序媒体引用、typedNativeFields、实际附件及 sha256、目标身份、来源及岗位／规则版本绑定；packageHash 对这一准确载荷做确定性规范化哈希。线程的顺序、视频字幕、文档每页、README diff、notebook 文件和可见范围都在其中。生成回执、质检报告和审批另有不可变记录，通过下述 ReviewEnvelope 绑定，避免“报告引用 packageHash，同时 packageHash 又包含报告”的循环哈希。（D）
- **版本衔接**：旧 v1／v2 快照与历史哈希保持原样；为含原生包的新内容引入明确的新 snapshotSchema 与对应 operation snapshot 验证，覆盖完整包，不偷偷追加未被哈希的字段。当前媒体上传类型只有现有文档列出的 PNG／JPEG／WebP／MP4／VTT；PDF、notebook、代码变更包等新增文件必须实现专用验证、私有存储、预览与备份后才能成为可批准附件。（A：现状文档；D：新方案）
- **公开与受限回执分开**：当前外部链面向可回读的公开 URL（现有 policy.validatePublication，A）。Discord 私密／受限频道的“消息已送达”需要另立平台对象 ID、受权可见范围、实际读取与时间的交付回执类型；在此合同实现前只允许安全导出／等待人工，不伪造公开 URL 或把未发内容记为 published。（D）

### 最终包质检与审批绑定合同

独立终检既运行确定性校验，也用与起草／润色分离的检查上下文重读最终标题、正文、顺序、原生设置与实际附件。检查器只报告问题，不偷偷改稿；发现需要修改时产生新候选，再对修改后的准确包终检。即使润色声称没有改变内容，也必须得到对最终 packageHash 的终检记录；无剩余调用预算时进入 QUALITY_RECHECK_REQUIRED，不能复用旧报告放行。（D）

拟议不可变 QualityReport 为 {id,candidateId,checkedPackageHash,checkerVersion,checkContextHash,deterministicReceipts,semanticFindings,modelReceiptIds,status,checkedAt,reportHash}。checkerVersion 固定本次验证器／检查提示／模型策略版本；checkContextHash 固定母版、Claim、目的地、岗位与规则版本。reportHash 由服务端对除自身外的规范化报告重算，不能相信客户端自填“已通过”。只接受被授权检查执行器的可追溯运行结果；reportHash 证明记录完整性，不代替执行器权限与实际检查。（D）

拟议 ReviewEnvelope 为 {schema,packageHash,qualityReportHashes,checkContextHash}，其 reviewSnapshotHash 进入新版本内容审批和动作审批。进入 ready_for_review、提交审核、批准、排期和发起发布的每道门禁均重新核对：当前包重算结果等于 packageHash；报告 checkedPackageHash 等于同一个最终 packageHash；报告完整性有效、checkerVersion 仍获准、检查上下文未变、无未解决 blocker／major。人工确认同时绑定 packageHash、报告哈希和 reviewSnapshotHash。任何一项不符都以 QUALITY_REPORT_STALE／QUALITY_RECHECK_REQUIRED 阻塞；最终稿变化不能沿用旧报告或旧审批。（D）

minor 项按明确质量策略展示给人审，不由模型隐去。现有已发布历史不因检查器升级被覆盖；受影响的未发布任务需重新终检。终检报告、版本与绑定同样进入备份、恢复及幂等结果，防止重启后只恢复成品却丢掉其依据。（D）

### 记忆、学习与事实边界

| 层 | 存什么 | 谁能使它生效 | 防止什么 |
|---|---|---|---|
| 共享事实层 | 已批准身份、Claim、来源、许可与有效期；继续使用事实账本 | 获授权管理员；模型只建议新增候选 | 把模型记忆、旧稿或自评分当事实 |
| 平台规则层 | 官方规则 URL、提取范围、checkedAt、版本、与账号能力的差异 | 人工审阅后锁定；过期或冲突则阻塞受影响任务 | 把主页简介当发布权限，把旧限制长期固化 |
| 风格与目的地层 | accountId＋destinationId＋locale 下的风格约束、批准范例、禁用表达、社区专属规则 | 从真实人工编辑／拒绝理由产生候选，审核后提升 | 一个社区的偏好覆盖所有渠道；多个账号互相串风格 |
| 工单临时层 | 这次素材、草稿、质检、尝试记录与本次修订理由 | 工单内使用，保留期限可配置 | 长会话把别的客户／私密社区信息带入公开稿 |

学习只接受可解释的修改：例如“删掉未验证的客户收益”“这个账号用 I 而非 we”“该频道禁止独立推广链接”。每条候选附原文、修改后文本、原因、范围和证据；批准后形成新版本，旧版本可回滚。阅读量／互动等结果只接收真实查询或明确 imported 的观察，带平台口径、分母、时间窗口与样本数；数据不足时显示不足，不能根据一次高互动宣布因果或自动改写全平台风格。（D）

不会自动学习或更改审批权限、账号身份、事实真实性、素材许可、对外承诺及费用上限。这里的“记忆”是 PengManager 应用内的新业务对象，不涉及写入 Codex 全局记忆。（D）

### 版本、去重、故障与权限

- **来源更新**：新母版出现时，旧稿保留具体来源 ID；未发布候选标记 source_outdated 并显示差异。待发布候选的事实、权利、目标身份或规则变化需要重核与重审；已经发布的历史回执不被覆盖。修订不会自动触发再发布。（D）
- **翻译**：中文／英文分开冻结与审核；核对数字、专名、证据和条件；缺译文显示未准备，不生成假语言链接或把不同主题当译文。（D）
- **去重**：以 story＋sourceHashes＋targetIdentity＋locale＋nativeForm＋profileVersion＋rulesVersion＋inputHash 建任务指纹。同键同请求返回原结果；同目标已有稿时显示已有候选／历史，不自动再发。近似重复只提出提醒，不以“规避检测”为目标改写事实。（D）
- **预算与重试**：每次模型调用先按下述预算合同原子预留，记录 provider/model/requestId、尝试 ID、token／金额及实际状态；网络超时记 unknown_usage 并继续占用预留，不填零、不靠重试释放额度。内容生成只有在剩余调用、token、金额及期限都允许时才能另开尝试；外发结果不确定必须先回读／调和，不能靠重发猜结果。（D）
- **恢复**：工单步骤有 durable checkpoint，重启从最后确认步骤恢复；没有收到外部确定结果时进入 needs_reconcile。取消会阻止后续步骤，但不能声称撤回已发送的外部动作。28 项之一失败不抹去其余项，也不把工单显示为全部完成。（D）
- **权限**：新增只可读指定母版／目标并写草稿工单的 worker capability，绑定 jobId、范围、有效期和预算。它不能批准、发布、改账号、改 Claim 状态、提升记忆或读取凭据。生成执行器内部调用受控草稿接口；不把现有 restricted Agent bearer 自动升级为管理员。（D）
- **外部材料**：网页、README、社区发言与模型输出都是不可信资料。它们可以被引用和核验，不能改变系统权限、要求泄露凭据或下发工具命令。新文件名、URL、压缩包和 notebook 需专用安全校验，notebook 检查／预览不等于获准执行其中代码。（D）

### 预算单位、最坏预留与未知费用合同

预算字段是可验证的合同，不能只保存一个不透明 budget 对象。拟议 BudgetSpec 采用以下字段与单位；这些是 D 级产品设计，不是某家模型的价格、上下文限制或实际费用承诺。（D）

| 字段 | 单位与约束 | 拟议启动值／缺失行为 |
|---|---|---|
| maxCalls | 工单累计实际外部模型请求次数，正安全整数；策划、生成、检查、返修、润色、终检与每次重试全部计入 | 提议 10×已选目标数，最多 280；不是保证每项都在 10 次内完成，耗尽就阻塞 |
| maxInputTokens／maxOutputTokens | 工单累计计费输入／输出 token 的硬上限，正安全整数；模型的隐藏推理等若计费，必须纳入可约束的输出维度 | 提议 1,000,000／160,000；只作产品配置，仍须满足实际模型能力 |
| maxPerCallInputTokens／maxPerCallOutputTokens | 单次请求最坏输入／输出计费 token 上限 | 提议 32,000／8,000；无法可靠计数或约束任一计费维度则不派发 |
| maxInFlight | 同时已派发但未确认完成的模型请求数 | 提议 2；恢复与重试共用同一计数，不能另开并发池绕过 |
| currency | 单工单的结算币种，例如 USD 或 CNY；从已核实的供应商计价配置取得 | 不默认兑换；不同币种不能直接相加；混币种须分账并分别有明确上限 |
| maxCostMicros | 本次明确允许的最高金额，单位为 currency 的百万分之一；使用非负安全整数，避免浮点金额 | 管理员明确设置，不臆造默认金额；保存草稿时可为 null，null 时不能开始付费调用 |
| deadlineAt | 绝对 UTC 截止时间；所有请求派发和重试前检查 | 提议创建时刻＋30 分钟；只作可配置期限，不保证 28 项在此时限完成 |
| pricingSnapshot | provider、model、currency、各计费维度的费率／计价单位、固定或工具费、来源、核实时刻和有效期；可为 null | 价格未核实、已过期或无法给出最坏计费上界时阻塞 PRICING_REQUIRED；不会退化为仅 token 模式却声称金额硬上限仍有效 |

所有默认值都只是对齐后可修改的假设，不代表实测成本、吞吐或服务商真实限额。创建工单可以保存未配置的金额／价格，但界面应明确显示“预算待配置，尚未调用”，不能把未知价当免费。缓存折扣、促销或推测的免费额度不减少最坏预留；需要付费工具、渲染或算力时必须有独立且明确授权的费用范围，内容工单不隐含授权。（D）

每次派发前，编排器以 callAttemptId 原子写入持久 BudgetReservation：{jobId,targetKey,stepId,callAttemptId,provider,model,pricingSnapshotHash,reservedInputTokens,reservedOutputTokens,reservedCostMicros,status,providerRequestId,usageReceiptId,reconciliationId}。reservedCostMicros 是按有效价格对单次输入／输出上限及所有可能计费项向上取整得到的最坏金额；对有缓存／推理／工具等多维计费的供应商，采用各维可证明的最高费率与上限，不能只估算可见文本。费率明确分子、计价单位与币种，计算使用精确整数并向上取整；单位缺失、计算溢出或无法证明上界就不执行，并报告需要补齐的维度。（D）

同一持久事务检查“已结算用量＋所有未决预留＋本次最坏预留”不超过调用、输入、输出、金额上限，并检查 deadlineAt、取消状态和 maxInFlight；通过后才能发网络请求。若派发结果未知，call 次数保守计入且相应 token／金额保持预留。另一次重试有新 callAttemptId，必须在旧预留仍占用的情况下再次通过同样检查；同键重放读取原尝试，不能新建额度、清零失败或绕过预算。（D）

模型回执把实际用量与账单区分：actualInputTokens／actualOutputTokens／actualCostMicros 在无法核实时为 null，另存 estimatedCostMicros、pricedUsageCostMicros 及其价格来源，不能把估算展示成真实扣费。unknown_usage 保留原最坏预留，跨超时、取消、deadline、进程重启和工单归档都不自动释放。只有两类证据可结算／释放：可核对到该 callAttemptId／providerRequestId 的供应商用量／计费回执，或管理员对准确尝试、输入输出和实际账单进行的人工逐项审计，记录证据、原因和审核人；简单点击“忽略”或编辑 maxCost 不能抹去未决用量。若证据仍不完整则继续保留预留和 unknown_usage。（D）

deadline 到期或取消后，立即禁止新的模型、重试、终检、付费渲染、部署／外发等有费用或副作用的自动外部调用。已经发出的请求只能尽力停止本地等待，不能假定供应商没有执行或没有收费；迟到结果可记入审计，但不自动接着润色、重检、批准或发布。费用核对若需要新的外部查询，须由管理员明确发起受控、只读的独立操作，并先核实其费用与权限；取消／到期不自动触发可能收费的“补救”。本地读取、展示、取消落盘和保留未知预留不受影响。（D）

### 拟议数据模型与接口

沿用当前单写者业务存储；模型、网络和渲染在状态锁之外运行，结果通过版本条件提交，避免长调用占住写入队列。原生文件放私有、按哈希寻址的资产区，JSON 保存有界元数据和引用。以下是拟议集合，不声称当前有 SQL 表或数据库索引。（D）

| 集合 | 核心字段 | 约束／查找 |
|---|---|---|
| channelOperatorProfiles | platformId、version、supportedNativeForms、strategy、ruleRefs、qualityGates、defaultModelPolicy | platformId＋version 唯一；发布后的版本不可覆盖 |
| contentOpsJobs | id、storyId、motherBindings、claimBindings、targetRefs、inputHash、BudgetSpec、budgetTotals、status、revision、createdBy | jobInputHash 去重；最多 28 targets；实际目标身份冻结；用量＋预留原子约束 |
| contentOpsTargetRuns | jobId、targetKey、accountId、destinationId、locale、nativeForm、profileVersion、rulesVersion、memoryVersion、steps、attempts、blockingReasons | jobId＋targetKey 唯一；状态条件提交 |
| nativeCandidatePackages | id、targetRunId、schema、sourceBindings、body／blocks、nativeManifest、fileRefs、packageHash、reviewEnvelope、reviewSnapshotHash、status | 候选不可变；修改另建 revision；包、终检和审批分别哈希并显式绑定 |
| contentQualityReports | id、candidateId、checkedPackageHash、checkerVersion、checkContextHash、findings、modelReceiptIds、status、checkedAt、reportHash | 报告不可变；按 candidate＋最终 packageHash 查找；旧报告不能放行新稿 |
| modelBudgetReservations／modelUsageReconciliations | callAttemptId、jobId、stepId、pricingSnapshotHash、各维最坏预留、actual 用量／金额（可 null）、status、providerRequestId、证据和审核事件 | callAttemptId 唯一；未决预留持久保留；准确回执或人工逐项审计才能结算 |
| formatLineage | formatEditionId、derivedFromEditionIds／hashes、transformType、locale、format、revision | 不能循环；引用必须存在；与现有翻译字段分别验证 |
| styleMemoryCandidates／styleMemoryVersions | scope、before／after、reason、evidence、promotedBy、version、supersedes | 账号＋目的地＋语言隔离；提升与回滚均有事件 |
| contentResultObservations | packageHash／receiptId、platformId、metric、value、denominator、window、observedAt、dataMode、source | 不跨口径相加；不把预测值作为真实观察 |

初期用内存 Map 建上述唯一键与查找键，启动做完整引用／哈希校验。新增 schema 迁移要有预检、完整备份、前向迁移与隔离恢复；接受新写入后不切旧程序继续写。日志、草稿与模型上下文有可配置上限和清理政策，已批准／已发布包及回执保留追溯关系。（D）

| 拟议接口 | 请求／响应与限制 |
|---|---|
| GET /api/content-ops/profiles | 返回 28 个岗位及准确版本、原生形态、规则来源与当前可准备／阻塞状态；不返回凭据 |
| POST /api/content-ops/jobs | {storyId,motherEditionIds,targets:[{destinationId,locale,nativeForm}],goal,budget:BudgetSpec,mode:"prepare"}；需 Story If-Match 与 Idempotency-Key；返回 202＋job／etag；预算未配置则为 blocked_budget，不审批、不外发 |
| GET /api/content-ops/jobs/:id | 返回各 target 的步骤、实际产物、最终质检 checkedPackageHash／reportHash／checkerVersion、模型回执、问题、各维预算已用／预留／未知以及 deadline；可分页读取有界日志 |
| POST /api/content-ops/jobs/:id/cancel | {reason}；准确 ETag＋幂等键；停止未执行步骤，保留已发生记录 |
| POST /api/content-ops/jobs/:id/targets/:key/revise | {candidateId,instructions}；输入也需敏感信息检查；剩余预算及父版本满足后创建新候选 |
| POST /api/content-ops/candidates/:id/submit-review | {packageHash,qualityReportHashes,reviewSnapshotHash}；服务端逐项重算并校验最终包终检，再转成版本化 Edition／Variant 关联的待核稿；旧报告拒绝，不直接批准 |
| POST /api/content/:id/transition 的新快照分支 | 保持 reviewed:true＋准确 reviewSnapshotHash＋ETag，核对最终包／报告绑定并覆盖完整原生包；旧 v2 规则不被静默改写 |
| POST /api/content-ops/jobs/:id/usage/:callAttemptId/reconcile | 管理员提交该准确尝试的供应商回执或逐项审计证据／原因；服务器核对尝试、币种、单位与金额后结算；ETag＋幂等键；不能仅声明零费用或释放预留 |
| POST /api/content-ops/memory-candidates/:id/promote | {scope,reason,reviewed:true}；管理员确认后生成新记忆版本；不能提升事实／权限 |
| 现有 /api/operations 与 /api/website/releases 链 | 只消费符合其版本合同的已排期成品；新快照分支核对同一最终包与终检报告，原生字段／文件须同样进入审批和回执绑定 |

所有拟议写入继续用准确的不透明 ETag 与 8—128 位幂等键；请求不能提供审核人、假回读或自签预算完成证明。常见错误：401 未认证；403 超范围／越权；409 SOURCE_OUTDATED、CLAIM_CHANGED、IDENTITY_CHANGED、RULES_CHANGED、IDEMPOTENCY_CONFLICT、DUPLICATE_TARGET、QUALITY_REPORT_STALE、JOB_CANCELLED、JOB_DEADLINE_EXCEEDED、USAGE_RECONCILIATION_REQUIRED；412 版本过期；428 缺少版本；422 NATIVE_PACKAGE_INVALID／QUALITY_BLOCKED／QUALITY_RECHECK_REQUIRED／ARTIFACT_MISSING／BUDGET_CONFIG_REQUIRED／PRICING_REQUIRED／CURRENCY_MISMATCH；429 JOB_BUDGET_EXCEEDED／PROVIDER_RATE_LIMIT；503 MODEL_PROVIDER_UNAVAILABLE。错误带 code、message、可安全展示的 details 和 retryability；真实外发 unknown 与模型 unknown_usage 分别留待核对，不能统一标“重试即可”。（D）

### P0／P1／P2 与不做清单

| 级别 | 具体可交付行为 | 用户不用它会怎样 |
|---|---|---|
| P0 | 28 个完整岗位档案与逐平台原生模板；母版／事实冻结；深度适配→独立核验→有限返修→最终润色→独立最终包终检；完整包和实际附件预览；包／报告／审批准确绑定；导出／现有授权发布衔接；跨形式追溯；调用／token／金额／期限硬约束、未知预留、幂等、取消和恢复；新增存储与文件完整备份 | 仍需手工做每个平台；容易错稿、假成品、串号、用旧质检批准新稿或因超时重试超支 |
| P1 | 从人工修改与真实结果形成受控学习；账号／社区风格版本；规则更新提醒；母版变化差异；可追溯的数据观察与运营回看 | 反复纠正同一写法，难以发现旧规则或旧素材，但不会因此放松 P0 质量和授权 |
| P2 | 按平台逐一核实权限后接官方适配器；受限社区专用交付回执；多人协作和更多执行器 | 成品仍可审核和人工／浏览器执行，缺少的是合规且可回读的自动传输通道 |

P0 可以按官网／长文、社交短文、图文、视频、技术作品、社区的工程顺序实现，但最终验收仍覆盖 28 行；不能以先做 6 个平台替代本方案承诺。技术作品和视频的真实输入不足时，验收可用客户已授权的公开样例或明确隔离测试资产；真实运营任务仍必须跳过／阻塞，不能伪造本人的作品。（D）

不做：未授权自动外发、自动创建／绑定账号、自动购买套餐或算力、自动把所有母版铺满所有平台、把阅读量当保证、制造客户背书／数据／模型、绕过社区规则、用同一篇通稿批量覆盖平台、不经许可执行外来 notebook、不把学习结果自动变成事实或权限。（D）

### 验收矩阵

本节是**对齐后实施的验收计划**；本次仅交付方案，所以每项实际结果均为“方案未实施，未执行”，不能引用当前系统其他测试冒充新员工能力已通过。（D）

| 用例／维度 | 前置条件 | 步骤 | 预期 | 本次实际 |
|---|---|---|---|---|
| T01 正常深适配 | 真实中文母版＋合格 Claim＋两种可用目标 | 同批生成官网与小红书稿，查看完整差异 | 两份结构与媒介确有区别；事实不变；各有独立核验与润色记录 | 方案未实施，未执行 |
| T02 28 岗位全覆盖 | 28 个岗位档案及各行合法样例 | 对每行执行至少一个原生成品用例与一个缺前提用例 | 全部岗位有包或准确 skip／blocked；不存在悄悄消失的目标；成品达到上表最小要求 | 方案未实施，未执行 |
| T03 跨形式 | 只有 article 母版，有真实视频资产 | 生成 video 方案并提交审核 | 新形式有明确 lineage；sourceEditionId 不被挪用；中立母版族不被平台稿互相替代 | 方案未实施，未执行 |
| T04 空／最大／重复 | 空目标、28 目标、29 目标、重复目标 | 分别创建工单 | 空／29／重复明确拒绝；28 项状态可完整追踪，不超过配置并发 | 方案未实施，未执行 |
| T05 大内容／特殊字符 | 达边界正文、emoji、中英文、代码、恶意 HTML／URL | 生成、预览、导出和提交 | 合法内容原样保留；超限明确报错；无注入、乱码、截断或私有路径泄露 | 方案未实施，未执行 |
| T06 幂等／并发 | 同一来源与目标，两次操作同时进行 | 同键同体重试、同键异体、旧 ETag、双创建 | 原结果可恢复；冲突 409；旧版 412；缺版 428；不重复扣费或提交稿件 | 方案未实施，未执行 |
| T07 模型失败与预算 | 有费用上限；模拟超时、429、无效 JSON | 触发重试与恢复，观察账本 | 已知／未知用量真实记录；预算不足停机；最多约定返修次数；无无限调用 | 方案未实施，未执行 |
| T08 事实／语言／身份变化 | 候选已完成或已审核 | 修改 Claim、母版、账号身份、目的地规则／可见范围 | 受影响待发布候选标陈旧并重审；其他目标不误伤；历史回执保留 | 方案未实施，未执行 |
| T09 文件与成品真实性 | 缺视频、缺模型、坏 notebook、篡改 PDF／图片顺序 | 各岗位准备并尝试审核 | 缺实物不算完成；损坏或 hash 不一致阻塞；批准后改任一原生字段／文件失效 | 方案未实施，未执行 |
| T10 权限与注入 | 草稿 worker、普通受限 Agent、恶意外部资料 | 尝试批准／外发／提升记忆／改身份／读取秘密 | 全部越权拒绝；外来指令不执行；仍可完成被授权准备任务 | 方案未实施，未执行 |
| T11 社区边界 | 禁自荐 subreddit、只读 Discord、私密频道 | 生成并尝试提交／发布／登记公开回执 | 按具体规则 skip／blocked；不跨频道发送；受限结果不假装公开发布 | 方案未实施，未执行 |
| T12 最终审核 | 有多图、帖子串、文档、字幕和作品文件 | 桌面／移动逐项预览并人工审阅 | 全文、顺序、真实资产与设置可见；阻断问题未清不能批准；最终哈希准确 | 方案未实施，未执行 |
| T13 部分失败／取消／重启 | 28 项中部分已完成，部分调用中 | 一项失败，取消后重启，恢复另一可重试项 | 成功记录保留；取消不启动新调用；未知结果先核对；没有全批假成功 | 方案未实施，未执行 |
| T14 真实发布／未知结果 | 已精确批准与排期的一份包 | 明确授权一次发布；制造响应丢失；先回读再处理 | 原包、真实 URL／平台对象和字节一致才入账；结果不明不重发 | 方案未实施，未执行 |
| T15 学习隔离 | 两账号、两社区、两语言及真实人工修改 | 提升一条限定范围的风格记忆并回滚 | 只影响指定范围与新任务；可解释可回滚；不更改事实、权限和既有批准包 | 方案未实施，未执行 |
| T16 回归／恢复 | 旧 v1／v2 内容、官网、媒体和动作回执；新员工工单 | 跑现有关键回归并完整备份、隔离恢复 | 历史 hash／审批／回执不变；新旧文件、工单、记忆版本、预算和幂等记录完整恢复 | 方案未实施，未执行 |
| T17 润色后终检 | 润色前质检通过；另有最终候选 | 分别只改标题、正文、图片／线程顺序、附件、字幕、native 设置，再尝试 ready／提交审核／批准／排期／发布 | 每个变更均使旧 checkedPackageHash 过期；不能只重算事实 hash 放行；独立重读最终包并生成新报告后才可继续 | 方案未实施，未执行 |
| T18 报告真实性与绑定 | 最终 packageHash 已固定，有有效终检报告 | 缺报告、换 checkedPackageHash、篡改报告、用未获准 checkerVersion、自签 passed；再尝试使用旧 reviewSnapshotHash | 服务端重算 reportHash／reviewSnapshotHash、核验授权执行与版本；任一不符均阻塞，人工点批准不能绕过终检 | 方案未实施，未执行 |
| T19 预算配置与单位 | 分别缺金额上限、缺／过期价格、不同币种、无法界定输出计费维度 | 创建工单并尝试派发付费调用；再提供完整可信配置 | 可保存待配置草稿但不调用；金额单位清楚，未知实际费用为 null；不能把 token 上限描述为已保证金额上限 | 方案未实施，未执行 |
| T20 未知用量与重试 | 一次请求已预留，响应丢失为 unknown_usage | 重启、取消、归档、另开重试；再提交模糊零费用声明与准确供应商／人工逐项审计 | 旧 token／金额预留持续占用；新尝试重新计入全部上限；无证据不释放；准确核对后才结算，保留完整事件 | 方案未实施，未执行 |
| T21 最后额度并发 | 调用、输入、输出、金额任一维仅够再派发一次 | 两个 target 同时争用最后额度，含返修与最终检查 | 持久原子预留只允许可支付的尝试；另一项 429／blocked_budget；检查器也不能独立绕过预算 | 方案未实施，未执行 |
| T22 截止与取消 | 有正在等待的模型请求和待执行终检／渲染／外发 | 触发 deadline 或取消，接收迟到响应，再重启工单 | 停止全部新有费用／副作用调用；不自动补做终检或重发；迟到结果仅审计；unknown 预留不释放，需明确核对 | 方案未实施，未执行 |

覆盖率口径分三项独立报告：岗位能力 28／28、适合本次母版的实际目标 N／N、真实发布与回读 M／M。跳过有理由不算“发布成功”；没有选择的渠道不混入本次成功率；机器质检分数不算用户效果。（D）

### 官方依据与核实范围

以下来源查阅时间为 2026-10-25。27 项基础形态／定位来自同次任务的官方研究条目；本方案另行读取 GitHub Releases、Hugging Face Model Cards、LinkedIn 分享内容、YouTube 上传、DEV 编辑器、TikTok Direct Post 的官方正文节选。Reddit 本次重读返回 403，Discord 直连超时；两者代理重试也均为 403。因此社区基础事实仅沿用同次任务前次 B 级来源记录，未声称本次重读成功，不补造新限制。

- GitHub release 基于真实 tag，可包含发布说明和二进制链接；本方案的 release 包因此需要仓库／tag 与实际资产绑定。（B）[About releases — GitHub Docs](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)
- Hugging Face 模型卡是模型仓库中的 README，说明用途、限制、训练和评测信息；产品方案要求有真实模型再做模型卡，不能凭应用案例伪造训练与评测。（B：模型卡形态；D：本产品前提）[Model Cards — Hugging Face](https://huggingface.co/docs/hub/model-cards)
- LinkedIn 官方帮助列出动态、图片、视频、文档和文章。本方案中的专业叙事与文档分页是内容策略建议，不是官方算法结论。（B／D）[分享内容 — LinkedIn Help](https://www.linkedin.com/help/linkedin/topic/a148004)
- YouTube 上传流程包含标题、说明、缩略图、字幕与可见范围；上传和公开发布是不同状态。视频任务须交付实际成片及可审核设置。（B／D）[上传 YouTube 视频](https://support.google.com/youtube/answer/57407)
- TikTok Direct Post 官方要求注册应用、scope 审批及目标用户授权，并对未审计客户端设置可见性限制；不能因有内容接口就宣称本系统已接通。（B）[Get Started — Direct Post](https://developers.tiktok.com/docs/en/content-posting-api-get-started)
- DEV 编辑器支持 Markdown 和 canonical_url；官方说明可分享的未发布稿地址是公开但隐蔽的 URL，不能当授权私有存储。（B）[Editor Guide — DEV Community](https://dev.to/p/editor_guide)
- Reddit 发帖须匹配社区规则，开放内容类型因社区而异；Discord forum 的主题、指引与权限亦由具体服务器／频道决定。（B，基础研究记录）[Reddit 发帖与评论](https://support.reddithelp.com/hc/en-us/articles/360060422572-How-do-I-post-and-comment-on-Reddit)、[Discord Forum Channels FAQ](https://support.discord.com/hc/en-us/articles/6208479917079-Forum-Channels-FAQ)

其余平台只采用当前目录官方研究所支持的定位和基础形态，未核验登录后能力、固定字符／时长限制、推荐机制、发布 API 或账号资格：

| 平台 | 官方来源 | 本次证据边界 |
|---|---|---|
| 微信公众号 | [微信公众平台](https://mp.weixin.qq.com/) | 信息传播／创作管理入口；不推定个人账号 API |
| 小红书 | [分享开放平台](https://agora.xiaohongshu.com/) | 官方索引与实时入口元数据；不承诺当前可接 SDK |
| 哔哩哔哩 | [官方公司信息](https://ir.bilibili.com/cn/corporate-information/?tab=company-profile) | 视频社区元数据；无时长／接口实测 |
| 抖音 | [创作者中心](https://creator.douyin.com/) | 内容与数据管理入口元数据 |
| 微信视频号 | [视频号助手](https://channels.weixin.qq.com/) | 上传管理与数据查询入口元数据 |
| X | [How to Post](https://help.x.com/en/using-x/how-to-post) | 文字、链接、图片与视频形态；不固化限额或订阅权益 |
| 即刻 | [即刻 App](https://www.ruguoapp.com/) | 仅官方入口标题；短帖策略为 D 级 |
| 知乎 | [官方公司信息](https://ir.zhihu.com/cn/corporate-information/) | 问答／知识经验社区；不用自述排名 |
| 掘金 | [稀土掘金](https://juejin.cn/) | 技术内容分类与创作入口 |
| CSDN | [CSDN](https://www.csdn.net/) | 博客／开发者内容入口 |
| Medium | [Writing and publishing your first story](https://help.medium.com/hc/en-us/articles/225168768-Writing-and-publishing-your-first-story) | 草稿、文章、图片与嵌入形态 |
| Hashnode | [Hashnode CLI 官方文章](https://hashnode.com/blog/hashnode-cli) | 当前官方帖子／草稿／原文信息说明；不默认已开通 API 或付费 |
| Instagram | [Meta 官方内容形态说明](https://about.fb.com/news/2023/11/new-ways-to-create-content-on-instagram/) | 2023 基础形态文；不当作 2026 限额与算法规则 |
| Facebook | [Meta 官方内容形态说明](https://about.fb.com/news/2025/12/making-it-easier-to-create-discover-and-share-content-on-facebook/) | 2025 内容形态文；不代替账号／Group 权限核验 |
| 魔搭 | [ModelScope](https://modelscope.cn/) | 官方模型／数据集／在线 Demo 元数据 |
| Kaggle | [Models Documentation](https://www.kaggle.com/docs/models) | 实时元数据与官方索引；动态正文与配额未取得 |
| 百家号 | [百家号](https://baijiahao.baidu.com/) | 创作发布入口元数据 |
| 今日头条 | [头条号](https://mp.toutiao.com/) | 仅官方创作者入口标题；形式沿当前目录 |
| 脉脉 | [脉脉](https://maimai.cn/) | 职业交流定位；不采用历史人数宣传 |

官网属于当前项目自身实现，不需要用外部平台资料证明其已有正文、媒体和回读功能；相关 A 级出处见“当前基础”表。没有在本次方案中承诺任何平台 API、账号登录、付费计划、自动发布资格或运营效果已经验证。

### 建议对齐的三个决定

1. **岗位形态**：采用“28 个长期岗位档案＋按需任务＋共享编排”，每个实际账号／目的地／语言保持独立上下文和风格；不为体现岗位数量而养 28 个常驻进程。（推荐）
2. **成品标准与覆盖**：28 个岗位全部具备深度适配、核验、润色和完整发布包能力；每次母版按相关性选平台，真实作品或媒体不够就明确阻塞／跳过。目录归档项保留能力与历史，不自动恢复运营。（推荐）
3. **自主边界**：在本次预算内自动准备、质检、有限返修和润色；最终完整包、实际外发、事实／记忆提升分别保留明确审核。P0 先保证内容与审核闭环，官方 API 作为逐平台后续连接工作。（推荐）

这三个决定对齐后，才能确定实施任务卡与迁移版本。本次只形成可审阅方案，没有提前创建员工、修改权限、产生草稿或对外发布。

## 收尾报告

- 已完成：当前编辑合同衔接分析；3 个候选架构及推荐；4 个具体场景；28 个稳定 ID 的原生适配／润色／前提矩阵；岗位流程、跨形式与原生包、最终包独立终检与报告哈希绑定、记忆学习、版本／去重／权限、具体预算单位与最坏预留／未知用量合同、数据／API／错误、P0／P1／P2、不做清单、22 组验收计划与 3 个对齐决定。
- 未完成／未覆盖：新员工功能尚未实施、调用模型或实际跑验收；没有认证进入平台核验个人账号权限；没有实测运营效果。以上属于本次“先对齐方案”的明确范围，未用现有系统验收冒充新能力。
- 自主追加事项及理由：补入跨形式 lineage、原生包全字段哈希与受限社区回执边界，原因是现有形式与公开回执合同不足以直接承接 28 种目标的完整原生成品；根据独立审阅补齐润色后精确终检绑定和可执行的预算预留合同，防止旧报告误放行与未知费用被清零重试。
- 采用的假设：本人及获授权管理员使用；AI 产品与工程实践定位；单人运营、日常 0—3 母版、最多 28 目标／工单、最多 2 并发模型调用；调用／token／30 分钟期限的启动值详见预算表，均为 D 级可配置提议，尚无性能或价格实测；实际金额上限和供应商价格不编造。
- 置信度：方案结构与当前合同衔接为高；各平台内容风格策略为中，需用本人批准样例与实际成品迭代；账号权限、集成成本和运营效果未验证。
- 建议复核：28 行成品与风格是否符合本人的表达；最终包与外发分别授权的边界；跨形式及技术作品的真实输入要求。

## 自检表

- [是] 覆盖了本次方案任务的完整 28 岗位范围，没有以部分平台替代全量设计。
- [是] 自主完成可决定的技术与产品细节；只保留用户已要求的方案对齐，未提前实现。
- [是] 当前代码、官方资料与设计建议分开标记；所有新能力明确未实现、未验收。
- [是] 方案列出实际衔接冲突、数据／接口／失败路径与可执行验收标准，可供逐项工程评审。

<!-- promoted-source-body:end -->

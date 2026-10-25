# B 组：9 个平台研究与岗位合同

> **文档状态：研究／设计归档，新增员工能力尚未实现，待产品方案对焦。** 这是 2026-10-25 同次研究的完整正文晋升。研究所分析的代码基线是 main `4e521c6f9645d7ddde29aae27b0df24bc7610e2e`；正文中的覆盖率、历史动作和验收结果属于原作者的该次研究，不是本次文档发布后的新运行回执。文档进入仓库不创建岗位、compiler、worker、接口、模型任务或外部发布权限。
>
> 原文标为 JSON、provenance、原始抓取、缓存、独立审阅回执的文件名／目录名，均保留为**原研究取证标识**；它们未随本文入库，不是当前仓库文件或可点击下载。公开来源 URL、取得范围、证据 A／B／C／D 和样本访问缺口完整保留。仓库代码路径相对本仓库根目录。本文仅改正原工作区绝对路径／临时路径的可移植表达，并清理原文尾空格，未删减研究正文。
>
> 原始正文取证标识：`platform-research-group-b.md`；SHA-256：`42e29a2681ef3916a5c357116169834ebd08beefb9ecce2f8931eaf3cac1a9c3`。早期产品矩阵为概要；平台限制以三组档案中明确支持的官方来源范围及执行前重新核实的规则为准；编译／执行的详细合同见二次生产集成方案。原文拟议 API、类型与验收仍为 D 级，实际可调用接口见现有接入指南和 API 文档。

三组研究中的 AdaptationPlan／toolTask 字段属于**岗位需求的语义规格**；涉及精确 schema／API、静态编译蓝图与运行期输入 hash、worker 与管理员分工时，以[二次生产集成方案](../PLATFORM-SECONDARY-PRODUCTION.md)第 4—9、11 节为本批文档唯一的后续设计合同。旧字段、旧接口或通用自动准备措辞不并行实施；早期 priorOutputHashes 等语义需求须按该合同分别映射为编译期逻辑依赖和运行期 resolvedInputHash，不能把未来产物／package／终检 hash 回写静态蓝图。研究中的 review／receipt／productionTasks 等语义展示不定义最终哈希载荷；最终以 PublicationPackage → 包外 QualityReport → ReviewEnvelope 及静态 blueprint／运行期 input 的分离为准，旧示意不得把报告、approval 或未来产物 hash 塞回包或蓝图。历史研究中的“需补能力”清单也不表示本期 worker 已纳入；本期 allowlist 与不做项以最新集成为准，例如 notebook 仅静态预览、executeCode:false，不运行单元格，隔离执行需另立实施授权及验证合同。研究中的 documented_cli／参考 command 示例是历史或人工正式 CLI 说明，不是 worker 可执行清单；worker 只能从最新集成的固定 adapter 投影编译任务，不能回放 production.plan 返回的命令。该优先序说明不把任何设计变成已实现接口。

[产品与岗位方案](../CONTENT-OPERATORS-DESIGN.md) · [二次生产集成方案](../PLATFORM-SECONDARY-PRODUCTION.md) · [AI 接入指南](../AI-AGENT-GUIDE.md)

<!-- promoted-source-body:start -->
## 覆盖率声明

- 范围：LinkedIn、X、YouTube、TikTok、Instagram、Facebook、Reddit、Discord、Medium，共 9 个平台。
- 本地接口/工具映射范围内文件总数：15；精读：14；机检/JSON解析：1；抽样：0；范围内未读：0。共 4,020 行（含元数据文件）；逐文件 SHA 与阅读方式在 `原研究取证标识：platform-b-local-read-provenance.json`。
- 机检项：`data/platform-catalog.json` 全量JSON解析后检查本组9项，属于B级元数据；目录中的 `manual_not_connected` / `automaticPublication=false` 不能变成已接通。
- 范围裁剪：本研究追踪内容存储API、CLI目录/transport、视频preview读取实现和固定调用指南，不重审完整媒体执行引擎。post-quality/full-chain-film/studio执行内部未在本研究全读，不由其文档或目录宣称本轮生成、艺术质量或平台效果已验收。其余代码的完整交付覆盖由root的独立交付清单承担，不与本研究计数混算。
- 网页范围：32条有访问方式/URL/取得日期的来源；9个平台各至少2条有实质内容的官方来源。实际可读文字样本为LinkedIn/Reddit/Medium；X为公开嵌入caption；YouTube仅标题/描述；Instagram只读二手caption、视觉未读；Facebook只定位真实帖，正文/媒体未读；TikTok/Discord原帖未读。以下逐项披露，未冒充视觉观察或真实账号实测。

本文件先给9个平台研究，再给根据研究得到的专家岗位与二次制作设计。检索日期为 **2026-10-25**。平台策略均为D级方案；没有写入生产系统、创建账号、外发内容、调用模型或购买服务。

## 证据口径

- **A**：本地源码、接口或固定合同完整精读，结论仅限明确读取的层。
- **B**：官方公开正文或完整元数据读取；历史资料写明年代，不代替当前账号权限、推荐效果或真实运行。
- **C**：一个实际公开样本/可见片段，明确原帖、文字、图片/视频和评论的可访问范围，不能推广为全平台规律。
- **D**：设计、受众假设、质量分数、待验证策略或访问缺口。平台不是按这里的分数推荐内容。

## 影响设计的已见事实

- **A**：当前CLI/MCP可以发现若干视频只读/预览/技术QA能力；没有通用生成text/image/carousel/thread的execute能力。 本地：`src/agent.mjs`、`engines/video-edit/bundles/geo-growth/agent-capabilities.json`。
- **A**：当前编辑HTTP与service双层拒绝受限Agent编辑；article/image_text/video之外的原生形式缺结构，模型输出不能直接塞入现API。 本地：`src/http/editorial-routes.mjs:14`、`src/services/editorial-service.mjs:127`、`src/domain/editorial.mjs:10`。
- **B**：Medium不是AI规模化发稿自然获得推荐的适配面；LinkedIn强调真实本人经验；Reddit/Discord必须具体到社区/频道。 来源：[MD-AI · Artificial Intelligence (AI) content policy](https://help.medium.com/hc/en-us/articles/22576852947223-Artificial-Intelligence-AI-content-policy)；[MD-DIST · Medium Distribution Guidelines](https://help.medium.com/hc/en-us/articles/360006362473-Medium-s-Distribution-Guidelines-How-curators-review-stories-for-Boost-General-and-Network-Distribution)；[LI-AI · Best practices for content created with the help of AI](https://www.linkedin.com/help/linkedin/answer/a1123063)；[RD-SPAM · Spam](https://support.reddithelp.com/hc/en-us/articles/360043504051-Spam)；[DC-FORUM · Forum Channels FAQ](https://support.discord.com/hc/en-us/articles/6208479917079-Forum-Channels-FAQ)。
- **D**：建议将平台专家的产物定位为有原生结构的AdaptationPlan/ToolTask/FinalArtifact，平台策略选择、实际媒体加工、技术QA、语义/艺术QA、外发回读由不同责任完成；该编排尚未落地。

## 第一部分：先完成平台研究

### LinkedIn（linkedin）

**受众与背景**

B：平台官方定位是职业关系、行业洞察与有帮助的商业经验。D：鹏经理优先面向正在评估AI工作流的经营者、团队负责人、实施者；不能从平台名称推断其公司规模、预算或购买意愿。

**三个具体用户意图/场景**

- D：负责人想知道某个AI流程在真实业务中如何交接、在哪些条件下不适合。
- D：实施者需要可借鉴的步骤、失败原因和验证方法。
- D：同行想讨论一个具体专业判断，而非只看产品新闻稿。

**发现与分发边界**

B（LI-REC/LI-AI）：专业相关性、实际经验和有用讨论能帮助内容被更广人群理解；泛化AI腔与纯广告不符合其推荐建议。D：用一个明确职业问题建立话题，不把所有人的痛点写在第一句；没有证明外链放评论必定更好。

**原生形式选择**

B：本地目录登记social_post/document_carousel/article/video但未连接。D：默认短案例帖；连续步骤适合文档/图卡；完整推导用文章；有真实操作证据时才交短演示视频。文档轮播与多张图片必须分开建模，不能把PNG列表叫已完成LinkedIn文档发布。

**标题与开头**

D：用可验证的职业情境或决策张力开头，例如“把报告交给AI之后，谁来核对最后一条来源？”；先给实际问题与结论，再补上下文。无真实数字就不写节省百分比；不伪造“我刚和某CEO聊完”。

**语气**

B（LI-AI）：本人声音、观点、经验与专业身份是前提。D：清楚、诚恳、有判断，采用真实资料支持的第一人称；品牌账号则用团队口吻。避免每句断行、空洞励志故事和“AI将彻底改变一切”式判断。

**叙事与信息结构**

D：职业问题→本次具体做法→一处证据/示例→局限或代价→可以借用的方法→一个相关讨论问题。产品入口放在解释价值之后，读者即使不点链接也能拿走一个判断。

**证据与视觉/演示**

D：每个成效与功能句绑定Claim及来源；工作流截屏必须能看懂输入、输出和复核环节；客户案例需有公开范围授权。作者经验缺失时转成明确资料型解读，不能把模型生成经历包装为本人经历。

**互动**

B（LI-REC）：索取互动和无关推广评论不受鼓励。D：问题只邀请真实专业选择，例如“你的团队在哪一步需要人复核？”；回复先回答具体条件与失败边界，公开承认未知，不要求评论关键词才给基本信息。

**反模式**

B：互赞群、无关评论推销、复制内容、互动诱导。D：AI长文只缩短成几段、把行业通用好处当个人洞察、用大公司成功指标替代自己的证据，都应退回。

**规则**

B（LI-AI/LI-REC）：人工审阅编辑、权利与隐私、专业相关、透明说明重度AI辅助。D：将“必须本人确认经验与结论”设为内部硬闸；没有账号身份/规则记录时保留草稿。

**真实样本观察与访问限制**

C（LI-SAMPLE）：实际短帖先给研究预览阶段，再给三个终端动作及链接；可见评论关注工具形态选择和类型安全。启发是明确阶段与动作、准备边界答复；不能据此得出短帖必然高触达或应该复制其品牌语气。

**本平台来源与实际读取范围**

- **B · LI-AI**：[Best practices for content created with the help of AI](https://www.linkedin.com/help/linkedin/answer/a1123063)；取得于 2026-10-25；访问方式：`official_body`。支持：官方本次页面标明3周前更新。AI润色、校对可用，但要保留真实专业身份、本人观点与经验；应人工审阅修改；重度AI辅助建议透明披露。重复、空泛、无观点的内容可能较少向更广人群分发。 限制：不构成禁止一切AI；未核实个人账号权限、推荐表现。
- **B · LI-REC**：[LinkedIn Content Recommendations: What to Avoid](https://www.linkedin.com/blog/content-recommendations-avoid)；取得于 2026-10-25；访问方式：`official_body`。支持：职业新闻、行业洞察、职业建议和有用商业经验符合专业语境。纯推销、无关推广评论、互赞群、索取互动和无新见解复制被列为不宜广泛推荐。 限制：不推导固定发帖时间、字数、外链位置或推荐权重。
- **C · LI-SAMPLE**：[Anthropic public post: Introducing Claude Code research preview](https://www.linkedin.com/posts/anthropicresearch_write-beautiful-code-ship-powerful-products-activity-7298575727505915904-dvBL)；取得于 2026-10-25；访问方式：`public_post_text_and_some_comments`。支持：实际读到正文：宣布研究预览阶段，接着列出终端中的具体动作，再附产品链接；可见评论追问终端与IDE选择、类型安全。 限制：只观察这一历史品牌样本；未看图片/视频，不用点赞数证明写法有效，不把第三方功能当鹏经理事实。

### X（x）

**受众与背景**

D：目标是关心AI工具、构建过程和产品变化的builder、实际使用者与同行；平台整体用户构成不能由这份研究证明，账号受众仍需真实资料。

**三个具体用户意图/场景**

- D：快速判断这次更新到底改变了什么，值得不值得点开demo。
- D：跟踪某个真实构建过程、失败和修复，而非重复听愿景。
- D：针对一个有范围的技术/产品取舍补充证据或提出反例。

**发现与分发边界**

B（X-THREAD）：帖子会在不同时间线、单条分享和引用场景出现，thread并不保证读者从第一条连续看完。B（X-AUTH）：操纵热门话题和无关回复推广有明确限制。D：先把主结论写完整，再给thread展开；不编造算法权重、外链惩罚、频率秘籍。

**原生形式选择**

B（X-THREAD）：单帖、连接thread与后续更新。D：一句变化加真实demo片段、带证据的短thread、对相关问题的实质回复；长文只是载体，仍须判断账号权益及当前功能。

**标题与开头**

D：第一条写“谁遇到什么问题、这次做了什么、证据是什么”；例如“把一段真实操作拆成可核对步骤，比再写一个AI愿景有用。”仅作写法示例，实际稿应替换成获准事实。避免“你不会相信”“线程末尾揭晓”以及无证据倍数。

**语气**

D：直接、像正在做事的人，允许具体不确定性和简短观点。少用公司新闻稿、成功学句子及没有事实的争议；英文依目标读者自然重写，保留产品名/限制，不把中文比喻逐字翻译。

**叙事与信息结构**

D：单帖=变化/结论→一个证据→必要限制→可选链接。thread=独立第一条→编号清楚的新增信息→演示/证据→代价/失败→可选后续。每条有自己的信息量，删一条会影响逻辑才值得存在。

**证据与视觉/演示**

D：每个功能更新带可回读截图、短片或正式记录；进度需区分已实现、在试验、未完成。thread每条绑定自己的Claim和媒体，不让后文限制替第一条不实标题兜底。

**互动**

B（X-AUTH）：禁止批量无请求回复、无关链接推广及互动交换。D：只回应与原帖有关的具体问题；引用其他观点须准确呈现上下文、补自己的证据，不组织互相点赞。

**反模式**

B：copypasta、多账号相同内容协调放大、无关热门tag、回复广告。D：把长文机械切段、用空洞第一条吊胃口、每天重复同一demo、把未知结果写“已上线”都退回。

**规则**

B（X-AUTH/X-THREAD）：真实身份与合法自动化、内容真实性、thread拓扑和单帖可见性。D：执行时检查账号字数/媒体/接口范围；本研究不冻结字符数和订阅能力。

**真实样本观察与访问限制**

C（X-SAMPLE）：实际可读公开嵌入caption先说preview，接受众工作情境和具体项目/浏览器动作，最后一个链接；原X页面403。这里只能借鉴简明状态声明与场景，不评价视频节奏、评论或传播表现。

**本平台来源与实际读取范围**

- **B · X-AUTH**：[Authenticity](https://help.x.com/en/rules-and-policies/authenticity)；取得于 2026-10-25；访问方式：`official_body`。支持：禁止批量、重复、无关或未经请求的内容与互动；无关回复推广、无关热门标签、近似copypasta、操纵点赞转发等属于风险行为。 限制：不推导所有多账号或所有跨平台改写都禁止；本次不测账号与API。
- **B · X-THREAD**：[How to create a thread on X](https://help.x.com/en/using-x/create-a-thread)；取得于 2026-10-25；访问方式：`official_body`。支持：Thread是同一作者相连接的帖子，可承载上下文、更新和展开论点；单条帖子也能独立出现在时间线、分享或引用场景中。 限制：当前账号的字数、媒体、订阅权益和具体发布接口能力应执行前核实；不固化数字。
- **C · X-SAMPLE**：[OpenAI Linux preview post embedded in public Developer Community reply](https://community.openai.com/t/codex-in-chatgpt-desktop-app-for-linux-is-now-in-preview/1390027/9)；取得于 2026-10-25；访问方式：`public_embed_caption_original_forbidden`。支持：页面实际嵌入OpenAI 2026-08-11帖子，原文链接https://twitter.com/OpenAI/status/2087231350134980830。先说明preview阶段，再写受众工作场景与项目/浏览器动作，末尾单链接。 限制：原始X链接403；仅阅读公开嵌入文本，没有视频/评论/转发链实测，不据此陈述OpenAI现有系统支持事实。

### YouTube（youtube）

**受众与背景**

D：目标分别是来完成某个任务的搜索观众、来判断产品是否适用的评估者，以及在Shorts第一次认识该问题的人；三者需要不同承诺和上下文。不能把所有内容都剪成同一30秒。

**三个具体用户意图/场景**

- D：按步骤复现一个真实流程，知道输入条件和失败时怎么办。
- D：在较长demo中看见完整因果链、边界与产物，判断要不要使用。
- D：用一个Shorts快速理解一个错误/前后差异，再选择是否继续看完整解释。

**发现与分发边界**

B（YT-DISC）：推荐按观众历史/兴趣及选择观看、持续观看、满意度等匹配，题材需求、竞争、季节也影响曝光。D：同一素材按搜索问题或浏览发现选择包装；不把SEO词堆叠、上传时刻或Shorts格式当必然推荐。

**原生形式选择**

D：长demo/教程要完整解决问题，可含章节和清楚描述；Shorts只讲一个可独立兑现的点。目标画幅与长度须结合账号当前政策、源素材和内容决定；目录只有video/short_video登记，不等于已验证每种生产预设。

**标题与开头**

B（YT-TITLE）：准确标题和缩略图要代表真实内容。D：先定一个可以在视频中兑现的观众承诺，例如“如何核对AI报告的一条来源”；开头先展示问题或可核对结果，再解释步骤。缩略图可读、有单一视觉重点，不做假界面或前后效果。

**语气**

D：口语解释、每步说清为什么、在哪里操作和看哪个结果；新手教程少省略前置，技术demo少重复常识。不给每个转场加营销口号，不假装真实人发言或使用别人的声音。

**叙事与信息结构**

D：承诺/实物证据→前置条件→任务步骤及屏幕证据→一次失败或限制→结果核对→下一步。Shorts重写为一个问题→一次演示→一个结论；从长片截取只有在上下文完整且字幕/节奏重编后成立。

**证据与视觉/演示**

D：旁白与画面能对齐，操作记录/时间戳与实测媒体对应；所有数字和功能绑定Claim。时长、字幕时钟、画幅和片尾链接都基于最终文件；技术通过不替代内容正确或艺术质量。

**互动**

D：描述中列真实前置、来源、相关完整资料；评论优先解决具体环境、步骤和边界。只邀请与本次任务有关的问题，不用假抽奖/索取互动替代内容。

**反模式**

B（YT-TITLE/YT-AI）：标题缩略图误导、逼真合成未披露不合要求。D：片头长自夸、画面只是幻灯片而承诺真实demo、只有语音没有关键界面证据、任意截成Shorts都应退回。

**规则**

B（YT-AI）：依据逼真合成/实质修改性质决定披露，提纲/字幕辅助并非一概披露。D：额外记录音乐、画面、人物和声音权利；具体账号上传/可见性与当前格式限制尚未核实。

**真实样本观察与访问限制**

C（YT-SAMPLE）：只读到视频标题与检索公开描述，表明研究预览并列具体任务例子及尝试入口。未播放或取得转录，故这不能支撑镜头节奏、字幕质量或用户留存结论。

**本平台来源与实际读取范围**

- **B · YT-TITLE**：[Thumbnail & title tips](https://support.google.com/youtube/answer/12340300?hl=en)；取得于 2026-10-25；访问方式：`official_body`。支持：标题应准确、简短、重要词靠前；缩略图清楚且与真实内容匹配。可按观众意图选择可搜索的明确标题或激发兴趣的标题，再用自己的来源别分析调整。 限制：不采用平台案例百分比作为鹏经理表现保证，不以单一CTR阈值判所有频道。
- **B · YT-AI**：[Disclosing use of altered or synthetic content](https://support.google.com/youtube/answer/14328491?hl=en)；取得于 2026-10-25；访问方式：`official_body`。支持：逼真生成或实质改变人物行为/真实事件/场景等内容需要披露；普通提纲、标题或字幕辅助及小幅美化并不自动触发同一披露要求。 限制：必须按本条视频实际媒体性质判断；本次未登录上传页。
- **B · YT-DISC**：[Search & discovery tips — Video](https://support.google.com/youtube/answer/11914225?co=YOUTUBE._YTVideoType%3Dvideo&hl=en)；取得于 2026-10-25；访问方式：`official_body`。支持：发现面向每个观众的兴趣与历史，结合是否选择观看、观看持续和满意度等；题材需求、竞争与季节也影响曝光。官方未宣称特定内容格式天然优先。 限制：这是机制方向，不是可计算的权重公式、必爆模板或固定发布频率。
- **C · YT-SAMPLE**：[Introducing Claude Code — Anthropic](https://www.youtube.com/watch?v=AJpK3YTTKZ4)；取得于 2026-10-25；访问方式：`search_index_description_only`。支持：公开检索返回2025-02-24视频标题与描述：说明研究预览、终端场景、任务例子与尝试链接。直接页面仅可获取标题/页脚。 限制：没有播放、逐镜观看或转录；只分析包装与描述，不能推断镜头、留存、口播或艺术效果。

### TikTok（tiktok）

**受众与背景**

D：目标是尚未认识鹏经理、会被具体视觉问题吸引的国际短视频用户，以及通过搜索找一个how-to答案的人；不能假定他们熟悉产品名、长篇背景或中文业务术语。

**三个具体用户意图/场景**

- D：快速看到AI流程到底做了哪一个动作，结果是否可信。
- D：用一次简短演示解决具体问题，例如识别一条没有来源的报告结论。
- D：从创作过程中的可见失败/改进获得一个能自己尝试的方法。

**发现与分发边界**

B（TT-SEARCH）：搜索确实用于发现与学习，官方Search Insights描述主题与内容缺口，但地区/账号可用性需另核实。D：先找真实问题再选表达，不凭空编“热门趋势”；For You权重、最佳标签数和频率未在本研究核实。

**原生形式选择**

D：首选一个问题一支竖屏短视频；确有分步视觉价值才选photo post；不是把YouTube横屏缩小置中。B（TT-CODES）广告指导支持竖屏、UI安全区、声音与结构；自然内容迁移只能视为设计假设。

**标题与开头**

D：屏幕第一眼出现具体矛盾或真实结果，例如“这份AI报告漏了哪一步？”；同时显示可读证据，快速交代今天只解决什么。不是只放“等到最后”，不把六秒等广告统计当自然内容硬闸。

**语气**

D：短、口语、演示者在做一件事；国际读者不理解的名词要立即用画面解释。可有轻松感，但不得把企业真实问题演成夸大焦虑；用授权自己的原声或明确同意的音色。

**叙事与信息结构**

D：可见问题/结果→一次操作→证据对照→一个可复用判断→必要的后续入口。每次换镜或字幕都要帮助理解；不为了快节奏破坏完整台词或把实测过程拉速后假装实时。

**证据与视觉/演示**

D：屏幕证据应真实、可读、与caption对应；前后对比必须同条件，演示模拟需标明。音乐商业使用、第三方片段和真人/声音授权分别记录；不能从平台音源存在推断拥有商业许可。

**互动**

D：caption补关键词和限制，回复观众实际问题；只有有新证据或新问题才做后续回应视频。热点、音频或挑战必须与内容适用且权利允许，不刷互评或引导群体互动。

**反模式**

D：套横屏成片、纯文字铺满画面、只喊AI效率没有操作、假实时加速、搬运热门镜头改字幕、追无关趋势都退回。B（TT-LABEL）贴AI标签不能使误导或侵权内容自动合规。

**规则**

B（TT-LABEL/TT-POST）：逼真合成需披露；Direct Post需要应用/scope/用户授权且未审核有可见性限制。D：执行前再核当前AIGC/商业内容/音乐规则和账号地区，本方案不假装API已接通。

**真实样本观察与访问限制**

D：从官方Embed Videos得到@scout2015真实示例链接，但正常公开打开被restricted，其他TikTok页面被robots拒绝；未看视频、caption或评论。此处调性是有官方创作指引支持的待验证设计，不是假称已完成平台样本研究。

**本平台来源与实际读取范围**

- **B · TT-SEARCH**：[Get inspired with Creator Search Insights](https://newsroom.tiktok.com/creator-search-insights?lang=en)；取得于 2026-10-25；访问方式：`official_body`。支持：2024官方说明搜索用于发现与学习，Search Insights可查看搜索主题与内容缺口，且存在地区可用性条件。 限制：旧上线说明不等于当前具体账号可用；不把搜索主题热度当必然流量。
- **B · TT-CODES**：[Creative Codes: 6 principles for creating effective ads](https://ads.tiktok.com/business/en-US/creative-codes)；取得于 2026-10-25；访问方式：`official_body_ad_guidance`。支持：官方广告创作指引强调平台原生表达、竖屏、画面避开UI、早交代价值、主体与收束、声音和动态编辑。 限制：证据范围是广告创作指导；迁移到自然内容是D设计，不能把广告统计或六秒等阈值当自然推荐硬规则。
- **B · TT-LABEL**：[New labels for disclosing AI-generated content](https://newsroom.tiktok.com/new-labels-ai-generated-content?lang=en-150)；取得于 2026-10-25；访问方式：`official_body_historical_with_current_support_search`。支持：2023官方原文要求逼真AI图像/音频/视频披露，并说明完整生成/显著AI修改可用标签。当前帮助页检索正文也描述逼真AIGC披露，但直接帮助URL重定向为空壳。 限制：不声称贴标即可发布任何内容；当前帮助正文直接提取受限，发布前应复核当前社区/商业内容规则。
- **B · TT-POST**：[Get Started — Direct Post](https://developers.tiktok.com/docs/en/content-posting-api-get-started)；取得于 2026-10-25；访问方式：`official_body_prior_review`。支持：官方Direct Post文档说明视频/照片发布需要应用配置、发布scope批准和用户授权；未审核客户端有可见性限制。 限制：本次没有注册应用、审核scope、连接账号或发布；不可用平台存在API推断鹏经理已经接通。
- **D · TT-SAMPLE-GAP**：[Official embed demo sample access attempt](https://www.tiktok.com/@scout2015/video/6718335390845095173)；取得于 2026-10-25；访问方式：`unavailable`。支持：从官方Embed Videos文档得到真实样本链接，正常公开打开被工具标记restricted；其他TikTok页面被robots拒绝。 限制：未观看原帖、未读完整caption/评论；不把官方示例代码当视频内容样本，不绕过访问限制。

### Instagram（instagram）

**受众与背景**

D：目标是通过视觉过程理解AI产品/创作方法的关注者与第一次看到单张/单支内容的人；信息必须在手机上先看得懂，不要求先读官网完整长文。

**三个具体用户意图/场景**

- D：看到一个真实工作流/制作过程的前后关系，判断是否值得保存。
- D：跟着多页图卡理解一套具体方法，而不是逐页看广告口号。
- D：通过Reel短演示快速知道一个动作与结果，并进一步提问。

**发现与分发边界**

B（IG-BEST）：专业仪表盘有随账号变化的创作/互动/触达指引；B（IG-ORIG）：官方2024对原作、重复转载与推荐资格作区分。D：按真实账号受众与素材选择Reel或carousel，不把旧官方上线说明变成2026推荐权重，也不保证轮播必比视频好。

**原生形式选择**

D：Reel讲一个可见动作；carousel用逐页证据或步骤；单图传达一个独立观点/实物，不把长文章截图分十页。Stories/广播等是否纳入取决真实账号权限与任务，目录登记不等于已开通。

**标题与开头**

D：Reel首帧是可辨认的真实演示或问题；carousel封面告诉读者将学会/判断什么，例如“报告发布前，我会核对这几个位置”仅在作者确实这样做且获准时使用。封面不得承诺页内未给出的结果。

**语气**

D：视觉先行、caption补上下文和局限，语气像实际创作者说明“怎么做”；保留专业性但不做PPT演讲。不能编幕后经历，不能以仿他人作品的精确风格替代自己的素材和观点。

**叙事与信息结构**

D：carousel=封面承诺→场景/误区→每页一个可看清步骤/证据→结论与边界→一个相关问题；Reel=可见问题→操作/过程→验证结果→简短补充。图卡顺序和每页文案共同决定理解，不按篇幅平均切页。

**证据与视觉/演示**

D：图卡与短片中的产品画面、前后对照、数据都用实际资产和Claim；截图必要遮私，不用AI重画伪装产品现状。每页/每个媒体有原作与授权记录，alt描述该页真实信息。

**互动**

D：caption提出能帮助理解的方法问题；认真回复“这一步怎么做/适用什么条件”；不把“保存、评论关键词、转给N人”设为获取正文的条件。账号洞察只有接入并读取真实值后才能用于调整。

**反模式**

B（IG-ORIG）：低价值搬运、clickbait/engagement bait可能不适合推荐。D：加边框/换字幕冒充再创作、满屏小字、图卡只改品牌色、Reel只是横片缩小、AI图冒充实测屏幕都退回。

**规则**

B（IG-BEST/IG-ORIG）：原创、推荐资格与社区规范是不同维度。D：发布前额外检查Meta当前AI/商业关系/版权与账号格式限制；本次没有读取账号Account Status或专业仪表盘。

**真实样本观察与访问限制**

C：Techmeme公开展示并链接Zuckerberg Vibes原帖caption，文字很短地说明形式与创作/混剪动作；原Instagram帖子DPCWz1SEepM正常打开429，另一个reel也throttled。没有看carousel每页、视频、布局或评论，故视觉调性样本仍缺，不能从二手caption推断艺术表现。

**本平台来源与实际读取范围**

- **B · IG-BEST**：[Introducing Best Practices, an Education Hub for Creators on Instagram](https://about.fb.com/news/2024/10/best-practices-education-hub-creators-instagram/)；取得于 2026-10-25；访问方式：`official_body`。支持：专业仪表盘Best Practices按创作、互动、触达、变现、指南组织，包含账号个性化建议并持续更新。 限制：本次没有账号仪表盘数据；不冻结通用发布时间、标签数、Reels时长。
- **B · IG-ORIG**：[Ayudando a los creadores a encontrar nuevas audiencias](https://about.fb.com/ltam/news/2024/05/ayudando-a-los-creadores-a-encontrar-nuevas-audiencias/)；取得于 2026-10-25；访问方式：`official_body_spanish_historical`。支持：官方2024说明在推荐区域用原作替换相同转载，降低重复聚合账号的推荐；推荐准则还排除clickbait、engagement bait与没有实质附加价值的搬运。 限制：2024说明仅支持原创与资格区分，不作为2026所有推荐细节、政治内容设置或阈值的完整现状。
- **C · IG-SAMPLE-PARTIAL**：[Zuckerberg Vibes Instagram post caption mirrored by Techmeme](https://www.techmeme.com/250926/h1230)；取得于 2026-10-25；访问方式：`indirect_caption_original_429`。支持：Techmeme确实链接并展示https://www.instagram.com/p/DPCWz1SEepM/的短caption，先引入产品形式，再写创作/混剪行为。原帖正常打开429。 限制：仅二手公开嵌入caption，未看多页视频/画面/评论；不把它列作已完成Instagram视觉样本验收。另一个reel正常打开也throttled。

### Facebook（facebook）

**受众与背景**

D：至少分开已关注Page/Profile的人与一个具体Group成员。前者可有持续产品背景，后者首先关心本社区主题；不能从Facebook平台名假定所有Group都欢迎产品推广。

**三个具体用户意图/场景**

- D：关注者想了解一个对自己有用的真实使用场景或更新。
- D：主题Group成员想得到具体问题的答案、案例或可复用经验。
- D：看到Reel的人想在一次短演示中理解问题和结果，而非看跨平台搬运。

**发现与分发边界**

B（FB-ORIG/FB-SPAM）：官方优先原创、降低低价值转载和spam行为；caption无关、过量标签与虚假互动受到针对。D：分开Page/Feed/Reel/Group的目标和互动方式，不套用Instagram caption或宣称跨发自动保留同样触达。

**原生形式选择**

D：Feed案例文字配一张真实图、Reel单点演示、在具体允许的Group中回答问题。Group帖是有本地规则的社区沟通，不是额外分发数量；同一个账号下也应按目的地分别制定稿件。

**标题与开头**

D：先用普通语言写一个具体使用困境与帮助，例如“先核对来源，再把这份报告交给团队”；Reel第一帧可见问题/产物，Group标题回应那里的实际问题。caption应解释同一媒体，不贴不相关的百科长文。

**语气**

D：自然、可理解、有温度且有实事；Feed可解释来龙去脉，Group先回答当前问题再说明自己与产品关系。避免企业公文腔、低价值争吵和为了引流硬扯生活话题。

**叙事与信息结构**

D：Feed=具体情境→做法/真实图→谁适用/何时不适用→相关问题；Reel=问题→操作→核对→结论；Group=对当前问题的直接答案→可验证依据→身份关系→适用边界。不同目的地保留各自上下文。

**证据与视觉/演示**

B（FB-ORIG）：第三方素材的低价值字幕/边框/调速不等于原创。D：记录自己制作或实质新增解释的依据，第三方授权和原创判断分别检查；真实客户/人物和音乐许可不能被转场或旁白替代。

**互动**

B（FB-SPAM）：协调虚假互动有明确风险。D：回复真实使用疑问；Group遵守版主对链接和自推广的规则，不跨Group发同一模板，也不把自动评论当经营结果。

**反模式**

B：重复spam、无关caption、过量无关标签、低价值转载。D：Instagram稿原样搬运、几段第三方片段配TTS就叫原创、到陌生Group只扔链接、把夸张互动当真实需求都退回。

**规则**

B（FB-ORIG/FB-SPAM）：原创、真实性、spam与版权分开检查。D：当前Page/Profile/Group权限、商业/AIGC标签和具体群规发布前核实；本次未登录/未加入Group。

**真实样本观察与访问限制**

C仅元数据：大学档案记录2025-09-25 Zuckerberg Vibes真实Facebook帖并给原链接；原帖打开throttled，档案正文403。已定位实际样本但未读正文/画面，所以不从它推导Facebook文案风格。上面的写法是D待验证设计。

**本平台来源与实际读取范围**

- **B · FB-ORIG**：[Rewarding Original Creators on Facebook](https://about.fb.com/news/2026/03/rewarding-original-creators-on-facebook/)；取得于 2026-10-25；访问方式：`official_body`。支持：2026官方说明自己拍摄/制作是原创；引用第三方素材须有真正新信息、分析或实质叙事改进。表情反应、拼接、复述画面、边框、字幕、调速等低价值处理不构成足够原创。 限制：授权/版权与推荐原创是不同要求；不套用该来源增长统计作为预测。
- **B · FB-SPAM**：[Cracking Down on Spammy Content on Facebook](https://about.fb.com/news/2025/04/cracking-down-spammy-content-facebook/)；取得于 2026-10-25；访问方式：`official_body_updated_2025_10_22`。支持：官方针对无关或干扰性长caption、过量标签、重复spam网络与虚假互动，强调与内容相关的真实讨论。 限制：不能由此推断所有长文/所有标签有问题；本次未核实Page、Profile或Group发布权限。
- **C · FB-SAMPLE-GAP**：[Zuckerberg Facebook post announcing Vibes — university archive record](https://epublications.marquette.edu/zuckerberg_files_transcripts/2178/)；取得于 2026-10-25；访问方式：`metadata_only_original_throttled_transcript_403`。支持：大学档案标明2025-09-25真实Facebook帖子并给出原链接https://www.facebook.com/zuck/posts/pfbid031BwYgipVBCe79VJUZxppYAhA4rJXGJXrCMZVDQVUj8gmUCuyyP3dkWKtvUBKii15l。 限制：原帖正常打开throttled，档案正文403；只验证样本存在与出处，未阅读正文/画面，不能据此得出风格结论。

### Reddit（reddit）

**受众与背景**

B（RD-POST/RD-SPAM）：需要先选择相关社区并遵守社区规则。D：目标不是抽象“Reddit用户”，而是一个subreddit中正在讨论具体AI/工具/工作流问题的人；商业产品读者与本地开源爱好者不能混为一谈。

**三个具体用户意图/场景**

- D：向懂行的人求证一种技术/产品取舍，欢迎反例而不是只要称赞。
- D：分享可复现的方法或工具，并让社区判断与现有选择相比是否有价值。
- D：回答已有问题，提供适用条件、失败边界和证据，而非导流。

**发现与分发边界**

B：站点以社区和讨论为发帖上下文；具体格式/规则因社区而异。D：先读当前规则、置顶、相关讨论再决定独立帖/megathread/评论或不发。没有证明标题模板、karma技巧或跨sub批发会提升质量。

**原生形式选择**

D：自包含技术讨论、项目展示、问题答复、受邀且规则允许的AMA；媒体/链接是否可用由目的地检查。B（RD-DEST）本次LocalLLaMA showcase有自己的开源/本地化范围；不能把鹏经理闭源商业宣传硬塞进去。

**标题与开头**

B（RD-POST）：标题应准确描述正文。D：像论坛主题写实际问题/做了什么及条件，例如“我们如何验证AI报告的来源，有哪些容易漏掉的情况”；如果是自己产品就明说，不写第三方热情推荐或“发现神器”。

**语气**

D：坦诚、同侪、具体，先说自己与项目的关系以及什么没做；能接住批评和技术追问。对未知问题承认未知，不用销售话术和AI生成的过度热情，不能扮演普通用户替自己背书。

**叙事与信息结构**

D：具体问题与关系披露→做了什么/如何复现→与替代方案的实质差异→测试与限制→精确反馈问题→必要链接。评论优先直接答问题，不把每条答复变成产品介绍。

**证据与视觉/演示**

C（RD-SAMPLE/RD-DEST）：真实样本中的评论会追问兼容、实现与验证；showcase明确要求测试依据。D：提供实际版本/条件/复现材料，开源/本地运行/免费等词只能用于确实满足的范围，作者自报指标不冒充独立实验。

**互动**

B（RD-SPAM）：重复无请求批量互动和持续产品推广bot被禁止。D：一人/一个透明账号在相关话题回应，不制造支持者；版主移除/要求修改就记录原因和规则，不换号、不改链接伪装。受众反馈分类保存问题，不做用户画像。

**反模式**

B：mass-post、unsolicited chat/PM、karma操纵与无关推广。D：先发广告再问“怎么看”、假用户体验、把同文复制到多个sub、隐藏商业关系、宣称未开源项目开源，都退回。

**规则**

B（RD-SPAM/RD-POST）：站点规则+社区规则共同约束，没有全站通用自推广比例。C（RD-DEST）：当前读到的LocalLLaMA showcase排除closed-source商业服务；这是具体目的地规则，不是Reddit全站商业禁令。

**真实样本观察与访问限制**

C（RD-SAMPLE）：公开Codag帖由作者真实痛点引入，给出开源工具/演示对象，再向agent/pipeline开发者求反馈；评论询问MCP/GGUF和API设计，作者说明不支持的边界并贴后续issue。未播放demo，不能保证其产品兼容性，也不能将这次互动当推广公式。

**本平台来源与实际读取范围**

- **B · RD-SPAM**：[Spam](https://support.reddithelp.com/hc/en-us/articles/360043504051-Spam)；取得于 2026-10-25；访问方式：`official_body_updated_2026_10_22`。支持：官方禁止无请求的重复/批量互动与连续产品推广bot，要求在有真实兴趣的相关社区参与，具体社区版主可按本地规则判断。 限制：没有全Reddit通用自推广比例；不以刷karma或换号规避限制。
- **B · RD-POST**：[How do I post and comment on Reddit?](https://support.reddithelp.com/hc/en-us/articles/360060422572-How-do-I-post-and-comment-on-Reddit)；取得于 2026-10-25；访问方式：`official_body_updated_2026_10_05`。支持：发帖前选相关社区并读规则，标题准确描述正文，媒体/AMA等可用形式因社区而异；发帖后可回复讨论。 限制：不能把站点支持的媒体选项当每个社区都允许；不固化实时长度、karma或年龄阈值。
- **C · RD-SAMPLE**：[I built a tool to visualize LLM workflows as interactive and shareable graphs](https://www.reddit.com/r/LocalLLaMA/comments/1qw6rwc/i_built_a_tool_to_visualize_llm_workflows_as/)；取得于 2026-10-25；访问方式：`public_body_and_visible_comments`。支持：真实帖子从作者自己迷失代码流程的具体问题开始，说明开源VSCode工具和演示对象，邀请做agent/pipeline的人反馈；评论追问MCP、GGUF、兼容与设计选择，作者澄清当前缺口并后续贴issue。 限制：仅一个历史开发者样本；第三方兼容性/数字未验证，不移植成鹏经理承诺；未看demo视频本身。
- **C · RD-DEST**：[Bi-Weekly Megathread Project Showcase — LocalLLaMA](https://www.reddit.com/r/LocalLLaMA/comments/1x9yg86/biweekly_megathread_project_showcase/)；取得于 2026-10-25；访问方式：`public_post_body_destination_rule_sample`。支持：公开megathread实际要求用清楚英语说明做什么、替代方案差异、测试验证，并写明该展示面向开放权重/开源/可本地部署，closed-source商业项目会被移除。 限制：这是该目的地在本次可读页面的规则，不能推广到全站，也不能用历史帖子绕过当前规则。

### Discord（discord）

**受众与背景**

B（DC-FORUM）：交流发生在有权限/指南的服务器和频道，文本频道偏即时、Forum偏持久主题。D：目标是已加入或经授权能参与的具体AI项目/客户社区成员，不是公开媒体的随机流量。

**三个具体用户意图/场景**

- D：在支持频道解决一个正在阻塞任务的实际问题。
- D：给已有成员一个与他们使用有关的更新，清楚说明影响与下一步。
- D：在Forum中整理可持续讨论的技术问题或反馈，避免淹没实时聊天。

**发现与分发边界**

B（DC-FORUM）：Forum可按标题搜索与标签过滤，权限和频道指南影响可见与参与。B（DC-INSIGHT）：可用真实服务器insights观察成员浏览、发言与留存。D：内部导航、已有讨论和成员关系优先，不把Discord当SEO文章批发渠道；没有读服务器数据不能编发现路径成效。

**原生形式选择**

D：短频道消息、针对parent的thread回复、标题/标签清楚的Forum主题、获准的公告。Forum与临时thread不同；是否能建主题/加附件/发公告/提及角色需真实权限检查。

**标题与开头**

D：频道消息第一句写影响与动作，如“这个步骤遇到空结果时，先核对来源状态”；Forum标题写环境/症状/问题，避免“重大更新！！！”这类对新读者无意义的标题。公告只有确实影响成员才发送。

**语气**

D：像负责支持或建设社区的同伴，简短、具体、知道前文；答复承认自己的权限和知识边界。产品自我介绍只给必要信息，不把长品牌文案贴进聊天流。

**叙事与信息结构**

D：支持回复=复述具体症状→可验证检查/解决步骤→预期输出→仍失败时需要哪些非敏感信息；Forum=问题标题→环境/复现→已做尝试→证据→希望讨论什么；公告=变化→谁受影响→操作→相关thread。

**证据与视觉/演示**

D：错误码/版本/步骤来自用户授权资料或真实结果，引用消息保留链接与上下文但不导出成员PII。截图/日志先遮秘密；社区内容只能按获准范围用于该任务，不能自动送进公共官网/其它平台。

**互动**

B（DC-RULE）：禁止unsolicited bulk messages、自助用户bot与虚假互动。D：默认不@everyone或批量DM，遵守slow mode、频道指南与thread上下文；官方bot/webhook与成员身份不混用，发帖失败保留403/429等原始结果供核对。

**反模式**

B：self-bot、spam、虚增成员/互动。D：把Medium长文整篇贴聊天、复制到多个server、无关邀请链接、用户刚求助就营销、丢失parent上下文、提及角色吸引流量都退回。

**规则**

B（DC-FORUM/DC-RULE）：服务器/频道权限、发帖指南和平台社区规范共同适用；开发的bot/应用另有官方developer规则。D：这次没有加入/登录/连接服务器或机器人，具体频道规则与权益未核实。

**真实样本观察与访问限制**

D：检索找到第三方gist里的一条SolveIt公告消息链接，但原始频道消息不是可读公共正文。没有登录加入或读取消息，也没有把gist的AI摘要冒充原帖。实际目标频道样本与语气观察明确缺失，首批内容需获准样本补证。

**本平台来源与实际读取范围**

- **B · DC-FORUM**：[Forum Channels FAQ](https://support.discord.com/hc/en-us/articles/6208479917079-Forum-Channels-FAQ)；取得于 2026-10-25；访问方式：`official_body`。支持：Forum频道将主题变成持久独立帖子，支持标题搜索、标签、发帖指南与权限；文本频道偏即时讨论，thread与forum不同。 限制：功能条件依赖Community服务器与频道配置，本次没有核实实际服务器/频道权限。
- **B · DC-RULE**：[Discord Community Guidelines](https://discord.com/guidelines)；取得于 2026-10-25；访问方式：`official_body_effective_2025_09_29`。支持：禁止无请求批量消息、spam、自助用户bot、虚假互动和成员数操纵；开发的bot/应用另受Developer规则约束。 限制：不把官方bot与self-bot混同；本次不连接bot或发送消息。
- **B · DC-INSIGHT**：[Understanding Server Insights](https://discord.com/community/understanding-server-insights)；取得于 2026-10-25；访问方式：`official_body`。支持：官方社区指引区分浏览者、发言者和新成员留存，建议看频道使用情况与新人路径；过多频道会分散讨论。 限制：不采用文中的建议比例当本产品KPI保证；无真实服务器数据。
- **D · DC-SAMPLE-GAP**：[Public message link access scope](https://discord.com/channels/1303610061167263814/1310989166875508849/1419529205292728452)；取得于 2026-10-25；访问方式：`not_read_login_scope`。支持：检索发现第三方gist中的真实消息链接，但不是可读的原始公共消息正文；没有登录、加入服务器或提取成员内容。 限制：没有拿AI摘要/第三方复述冒充Discord原帖样本；原生调性观察仍缺实际目标频道可授权样本。

### Medium（medium）

**受众与背景**

B（MD-DIST）：平台以人的叙事、知识与个人表达为目标，重视第一手经验和读者价值。D：目标是愿意花时间理解真实AI工程/经营经验的英文读者；不是为了把中文稿多发一个站点。

**三个具体用户意图/场景**

- D：读一篇可复用的方法/教训，了解为什么有效、付出了什么代价。
- D：跟随一个真实作者的观察和判断，看到无法从新闻稿获得的细节。
- D：基于证据理解一次失败、迁移或设计取舍，而非只看产品卖点。

**发现与分发边界**

B（MD-DIST）：Network/General/Boost是不同分发层，官方将AI生成、低价值、PR营销/销售/引流为主要目的的内容列作General排除因素；Boost不是满足清单即可保证。D：将本平台定位选择性、人主导文章；不要承诺AI多写多发能获得站内推荐。

**原生形式选择**

D：优先真实案例、方法教程、反思文章；图片/代码/嵌入只有解释论证时使用。不是把article变成文档截图，更不为凑三形式硬发图文/视频。已有中英文对照可作资料，但本次官方指南称非英语暂不General/Boost、转载翻译不Boost；需在实际发稿时复核。

**标题与开头**

B（MD-DIST）：title/subtitle/cover必须准确给出故事上下文，避免泛化、神秘和夸张。D：用具体问题、方法与限制表达，如“核对AI报告来源时，我们发现最容易漏的是上下文”；没有亲历资料则不能使用“我们发现”。

**语气**

B（MD-DIST）：可信第一手经验、非衍生视角和写作工艺重要。D：作者在场，有具体观察、判断和不确定性；写给读者而不是写销售页。AI可帮助组织/语言，但不能捏造人类经历或通过“去AI味”隐瞒生成性质。

**叙事与信息结构**

D：真实情境/问题→为何原办法不够→分阶段方法→关键证据或失败→结果与代价→适用边界/可带走的做法。段落和长短服从论证，代码/图表在需要处解释；结尾可以给资料，不把整篇变成注册漏斗。

**证据与视觉/演示**

C（MD-SAMPLE）：Airbnb文章用阶段方法、代码、验证循环、长尾人工处理支撑叙事，可见读者追问测试意图与成本。D：鹏经理文章应拿自己的材料建立同样可核对的因果链，第三方数字只能带归属引用，不能当自己结果。

**互动**

D：回答方法、验证、成本和边界问题，纠错应建立新修订与说明；不批量给文章留模板评论。未经授权的客户素材不进入故事；评论需求只能归纳问题，不采集用户个人画像。

**反模式**

B（MD-AI/MD-DIST）：无披露生成文字、AI洗稿/幻觉、SEO导流、泛化PR营销不符合相关政策/分发条件。D：只翻译官网、拼新闻摘要、把AI冒充亲历作者、宣称“加声明就可Boost”都退回。

**规则**

B（MD-AI）：多数AI生成且少修改/核实的写作不能Partner付费墙；生成文字前两段披露、AI图片caption披露，纯grammar/outline/fact-check有FAQ豁免。B（MD-DIST）：披露不保证General/Boost。D：始终记录作者贡献与AI使用类别，由人确认真实性。

**真实样本观察与访问限制**

C（MD-SAMPLE）：已读可公开正文和少量响应，观察到背景→四阶段方法→验证/重试→长尾人工→结果/下一步；评论追问测试意图保持与LLM成本。只是一个工程案例，不能推出所有读者偏好或用其自报迁移效率担保鹏经理成效。

**本平台来源与实际读取范围**

- **B · MD-AI**：[Artificial Intelligence (AI) content policy](https://help.medium.com/hc/en-us/articles/22576852947223-Artificial-Intelligence-AI-content-policy)；取得于 2026-10-25；访问方式：`official_body`。支持：多数AI撰写且少修改/核实的文章不得Partner付费墙；未披露生成文字仅Network分发；使用生成文字须前两段披露、AI图片须caption标注，纯语法/提纲/事实核查辅助有FAQ豁免。 限制：披露不保证General/Boost；不得虚构事实、洗稿或批量SEO导流。
- **B · MD-DIST**：[Medium Distribution Guidelines](https://help.medium.com/hc/en-us/articles/360006362473-Medium-s-Distribution-Guidelines-How-curators-review-stories-for-Boost-General-and-Network-Distribution)；取得于 2026-10-25；访问方式：`official_body_updated_2026_06_29`。支持：官方区分Network/General/Boost，重视真实第一手经验、读者价值、原创视角、来源与写作；AI生成、PR营销、销售/引流为主要目的等被列作General排除项。 限制：这些条件不保证Boost；转载翻译不符合Boost要求；本任务不承诺付费墙/流量。
- **C · MD-SAMPLE**：[Accelerating Large-Scale Test Migration with LLMs — Airbnb Tech Blog](https://medium.com/airbnb-engineering/accelerating-large-scale-test-migration-with-llms-9565c208023b)；取得于 2026-10-25；访问方式：`public_article_text_and_visible_responses`。支持：可公开读正文：背景问题、分阶段方法、验证与重试、扩展上下文、长尾人工处理、结果和下一步；代码示例支持过程，评论追问测试意图保留与成本。 限制：只作为这篇真实工程叙事样本；迁移数字为作者自报，未独立复现，也不暗示所有Medium读者偏好同一种长度。

## 第二部分：现有二次制作链，逐项区分“可读、可预览、可写、可执行”

这里的A证明当前源码/合同，不证明本次已运行。内容存储、媒体加工、艺术判断、原生平台发布是不同动作。所有9个平台目前均未连接自动外发。

### EDITORIAL_VARIANT — existing_http_admin_storage_not_generation

- **A** 现有入口：`POST /api/stories`、`POST /api/stories/{storyId}/editions`、`POST /api/editions/{editionId}/variants`。
- 输入：`{"story":["workingTitle","claimIds","topicIds"],"edition":["locale","format","title","summary","body","blocks","claimIds","assetRefs","sourceEditionId","supersedesEditionId"],"variant":["destinationId","title","summary","body","blocks","assetRefs","adaptationNote","supersedesContentId"]}`。
- 前提：管理员local/session；每次写有Idempotency-Key；edition写须If-Match story ETag，variant写须If-Match edition ETag；只接受当前字段。
- 产物：不可变edition/variant快照、绑定Claim/媒体/账号/目的地身份；不是生成模型结果或外部平台发布回执。
- 限制：src/http/editorial-routes.mjs context拒绝受限agent；service.#write同样只接受local/session；native thread/slides/chapters等不能直接作为新字段塞入，未知字段被拒。
- 代码/合同：`src/http/editorial-routes.mjs:14`；`src/services/editorial-service.mjs:127`；`src/services/editorial-service.mjs:390`；`src/services/editorial-service.mjs:422`；`src/domain/editorial.mjs:10`。本研究运行验证：未执行。

### MEDIA_ASSET — existing_http_admin_media_storage

- **A** 现有入口：`POST /api/media/assets`、`POST /api/media/assets/{id}/review`、`GET /api/media/assets/{id}/bytes`。
- 输入：`{"upload":"二进制正文；Content-Type/Content-Length及可选x-media-name/x-content-sha256，实际合同以当前API为准","review":"管理员当前审阅资料；不得由模型伪造权利或隐私确认"}`。
- 前提：管理员当前授权；真实文件、来源与权利资料；媒体引用绑定sha256。
- 产物：实际媒体assetId/sha256供image/video/poster/subtitle角色引用。
- 限制：这是存储/审阅，不生成图片视频、不授权素材、不证明艺术质量；本研究仅追踪路由和引用合同，没有重新调用上传或重新审计所有媒体执行内部。
- 代码/合同：`src/http/editorial-routes.mjs:105`；`src/domain/editorial.mjs:105`。本研究运行验证：未执行。

### VIDEO_GUIDE — registered_local_read

- **A** 现有入口：`growth.video.workbench.guide`、`growth.repo.readiness`。
- 输入：`{"guide":{},"readiness":{}}`。
- 前提：通过鹏经理CLI目录发现当前ID；guide检查固定文档及产品身份；readiness为声明的只读能力。
- 产物：完整指南、sha256、版本和限制；就绪资料不能代替本次生成。
- 限制：没有新模型/渲染/发布。guide实际代码已读；readiness仅核目录合同，未在本研究重跑或全读它的环境探测实现。
- 代码/合同：`src/agent.mjs:16`；`engines/video-edit/scripts/agent-capabilities.mjs:116`；`engines/video-edit/bundles/geo-growth/capabilities/workbench-guide.mjs:47`。本研究运行验证：未执行。

### VIDEO_CATALOG — registered_trpc_read

- **A** 现有入口：`growth.video.gen.catalog`。
- 输入：`{"kind":"video|image|audio (optional)","mode":"string optional","includeUnavailable":"boolean optional","limit":"1..200 optional"}`。
- 前提：当前隔离运行时/服务端授权与依赖。
- 产物：服务端当前模型目录，不提交生成。
- 限制：目录条目不等于当前模型可生成、不等于商业许可或供应商额度；本次未调用目录服务。
- 代码/合同：`engines/video-edit/bundles/geo-growth/agent-capabilities.json:315`；`src/agent.mjs:57`。本研究运行验证：未执行。

### VIDEO_SHOTS — registered_trpc_read

- **A** 现有入口：`growth.video.production.shots`。
- 输入：`{"projectId":"required string"}`。
- 前提：已有真实服务端项目。
- 产物：项目镜头与资格状态。
- 限制：不会创建项目、触发正式前期或启动渲染；源码研究只核声明和transport，不声称该项目当前资格通过。
- 代码/合同：`engines/video-edit/bundles/geo-growth/agent-capabilities.json:351`。本研究运行验证：未执行。

### VIDEO_PLAN — registered_local_preview

- **A** 现有入口：`growth.video.production.plan`。
- 输入：`{"title":"optional","projectId":"optional","platform":"optional","shotlistPath":"artifact-root relative","routePath":"artifact-root relative","outDir":"artifact-root relative"}`。
- 前提：真实分流/正式镜头/素材合同，按当前指南核对；路径受运行者artifact root约束。
- 产物：previewOnly/checklist/ready/execution.command+args，不执行；ready只说明本地清单。
- 限制：没有制作、渲染、付款或正式资格；不能写platform=tiktok就声称预设验证。生成默认参数不应覆盖专家已冻结的时长、声音与账号要求。
- 代码/合同：`engines/video-edit/bundles/geo-growth/capabilities/video.mjs:359`；`engines/video-edit/docs/ai-video-workbench-guide.md:48`。本研究运行验证：未执行。

### CLI_PRODUCTION — documented_existing_executor_not_exposed_as_execute_capability

- **A** 现有入口：`scripts/tools/full-chain-film.mts`、`video.studio.start (documented service entry)`。
- 输入：`{"cli":"应使用production.plan给出的command/args逐参数核对，绝不shell拼用户原话；正式前期/brief另传现有合同","studio":"当前指南记录intent/metadata限制及durationSec30差异"}`。
- 前提：真实前期、人物/声音/商品/素材授权、明确费用范围、当前依赖与能力；先恢复已有成功任务。
- 产物：实际生成/后期产物与阶段账本；需要真正执行和核验后才能算本次结果。
- 限制：本研究未完整审计full-chain-film或studio执行实现、未执行它们。这里A仅指当前指南和preview代码确实指向这些已有入口；平台适配自动执行器、非30秒/长教程能力需D设计与真实验收。
- 代码/合同：`engines/video-edit/docs/ai-video-workbench-guide.md:44`；`engines/video-edit/docs/ai-video-workbench-guide.md:54`；`engines/video-edit/bundles/geo-growth/capabilities/video.mjs:375`。本研究运行验证：未执行。

### VIDEO_STATUS — registered_local_read

- **A** 现有入口：`growth.video.production.status`。
- 输入：`{"projectId":"current real project","workDir":"artifact-root relative"}`。
- 前提：已有实际项目阶段账本。
- 产物：invoked/ok/failed/degraded/cached汇总与失败原因、提交次数分类。
- 限制：账本没有金额就不能估算费用；阶段成功不代替平台适配或外部发布。
- 代码/合同：`engines/video-edit/bundles/geo-growth/capabilities/video.mjs:203`。本研究运行验证：未执行。

### VIDEO_QA — registered_local_read_quality_contract

- **A** 现有入口：`growth.video.delivery.inspect`、`growth.video.post.quality`。
- 输入：`{"projectId":"current real project","outDir":"artifact-root relative","kind":"post.quality supports auto|post|generation"}`。
- 前提：最终当前文件、清单/指针与实际加工凭据。
- 产物：inspect核字节，complete固定false并要求post.quality；post.quality指南合同核当前媒体技术，艺术质量仍unverified。
- 限制：deliveryInspect实现已完整读；post.quality仅核目录和全文指南合同，其内部解码/验收实现本研究不重审。不能让技术通过代签标题兑现、语义、艺术和平台native质量。
- 代码/合同：`engines/video-edit/bundles/geo-growth/capabilities/video.mjs:255`；`engines/video-edit/docs/ai-video-workbench-guide.md:184`。本研究运行验证：未执行。

### 目录名称与真实调用入口

**A**：鹏经理入口是 `node scripts/agent.mjs list|describe|invoke`；`src/agent.mjs` 加载已审核原生能力并把MCP名称前缀改为 `pengmanager_`。可调用ID必须来自这个清单及其inputSchema，不能把员工/技能/页面目录中的名称当工具ID。当前视频生产工具是读取/预览/技术验收；真正生成仍由已有正式服务/CLI承担。

**A**：当前编辑HTTP在 `context()` 拒绝 `principal.method=agent`，service的 `#write()` 再次只接受 `local/session`。因此现有限制Agent token不能导入策略、写edition/variant或媒体。未来要有范围受控writer/任务执行适配，不能擅自借用管理员身份，也不能把403吞成已保存。当前 `EDITORIAL_FORMATS` 只有 `article|image_text|video`，未知字段拒绝；thread/slides/chapters等原生字段是新设计，不能假称现有API直接支持。

## 第三部分：根据研究设计9个独立专家岗位

以下使命、决策、schema、rubric、记忆、刷新频率和任务编排均为 **D级设计，尚未实现或导入生产**。每份100分rubric建议80分以上并通过全部硬闸才可进入精确审核；这是内部设计阈值，不能抵消事实/权限/授权/披露缺失，也不是平台算法。技术通过与语义/艺术通过单列。

### LinkedIn专家

**D · 使命**：把有证据的经营/制作过程转换为让专业人士能判断并讨论的案例，而不是代写虚构履历。

**D · 必须自己做的专家决策**

- 选择给经营负责人还是技术实施者看，并列出不兼顾的受众。
- 判断采用本人案例、团队说明、行业解读或完整文章；证据不够时缩小主张。
- 选择一个可讨论的专业取舍；决定图卡/文档是否真的比纯文字解释清楚。
- 核对AI辅助披露、本人经验确认、链接目的与评论答复责任。

**D · 原生输出合同草案**（不是现API已支持字段）

```json
{
  "format": "professional_post|document_carousel_brief|article|case_video",
  "audienceRole": "string",
  "professionalQuestion": "string",
  "opening": "string",
  "sections": "[{purpose,text,claimIds}]",
  "ownerPerspective": "{providedBy,confirmed,sourceRefs}",
  "proofAssetRefs": "[{assetId,sha256,explanation}]",
  "documentSlides": "[{order,title,oneTakeaway,visualBrief,claimIds}]",
  "discussionQuestion": "string",
  "aiDisclosure": "{decision,reason,text}",
  "replyBrief": "[{likelyQuestion,answerBasis,unknowns}]"
}
```

**D · 质量量表**

| 检查项 | 分值 | 可复核要求 |
| --- | ---: | --- |
| 专业问题具体 | 20 | 读者能说出适用岗位和要做的决定 |
| 真实本人/团队观点 | 15 | 每个第一人称经验有本人确认 |
| 可核对证据 | 25 | 成效与功能均绑定有效Claim |
| 过程与边界 | 15 | 解释为什么这样做及至少一个限制 |
| 原生易读 | 10 | 开头独立可读，图卡一页一个判断 |
| 权利与互动 | 15 | 授权披露到位，没有互动诱导 |

**D · 岗位独立记忆**

D：accountId×destinationId×locale保存已确认作者声音、目标岗位、获准第一人称经历、术语偏好、人工改稿差异和高价值讨论问题；不记无授权客户信息，不把单条高赞样本升级成平台规律。

**D · 规则更新**

D：发稿前核对LinkedIn AI/推荐指南版本；每30天重新读取官方来源作为维护建议，重大更新或账号提示立即重审。无账号analytics时不生成“最佳时间/长度”结论。

**D · 二次制作计划**

1. 锁定母稿editionHash、合法Claim和允许公开的实例，保留英文目标读者语境。
2. 重新选择专业论点和证据顺序，输出文字稿或逐页图卡说明，不做逐句翻译。
3. 图片/视频生成走下述媒体链；文档轮播PDF属于缺失能力，不能把图片上传回执冒充PDF产出。
4. 通过单独的平台rubric后，再由获准管理路径创建渠道variant并进入精确快照审阅。

**实际链路映射**：`EDITORIAL_VARIANT` → `MEDIA_ASSET` → `VIDEO_PLAN` → `VIDEO_QA`；视频实际执行如需要还依赖 `CLI_PRODUCTION`，不是调用preview即完成。

**D · 具体ToolTask例子与可用性**

这些是计划载荷，`${...}`须在未来受控执行器中解析。`missing`项没有可调用ID，`existing_admin_api`也不向受限Agent开放。完整输入、依赖、失败条件与产物在同名JSON的`operator.toolTasks`。

| 任务 | 可用性 | 真实入口/状态 | 预期产物 |
| --- | --- | --- | --- |
| `linkedin.native-adapt` | `missing` | `没有当前可调用工具；D设计` | linkedin-native-contract.json, linkedin-adaptation-plan.json |
| `linkedin.native-visual-layout` | `missing` | `没有当前可调用工具；D设计` | rendered-native-visuals, per-page-proof |
| `linkedin.independent-editorial-quality` | `missing` | `没有当前可调用工具；D设计` | hash-bound-platform-review-with-reasons |
| `linkedin.persist-channel-draft` | `existing_admin_api` | `POST /api/editions/{editionId}/variants` | immutable-variant-snapshot-with-hash |
| `linkedin.native-publish-and-readback` | `missing` | `没有当前可调用工具；D设计` | real-platform-ids-and-urls, exact-destination-content-readback |

**能力缺口**

- D：平台专家调度、原生post/document格式与字数校验尚未登记。
- D：PDF文档轮播排版/渲染/逐页复核与上传回读没有现成CLI能力映射。
- A：受限Agent bearer不能写编辑API，需新设计的范围受控写入路径。

**D · 接入后验收场景**：D：给同一份真实AI工作流过程分别产出负责人案例帖和实施者文章，核对论点/顺序确实不同且Claim一致；删除作者经验资料应阻止第一人称故事。

### X专家

**D · 使命**：从真实构建证据中挑选一个值得公开讨论的变化，并决定单帖、thread或回复，不制造发布节奏噪音。

**D · 必须自己做的专家决策**

- 先判断是否有新信息，没有则取消独立发帖。
- 决定一个独立帖能否说清；确需上下文才用thread。
- 为每条thread确定自己的结论、证据和必须保留的限制。
- 按账号权益检查当前字符/媒体约束，拒绝无关推广和群体互动任务。

**D · 原生输出合同草案**（不是现API已支持字段）

```json
{
  "format": "post|thread|reply",
  "updateStatus": "released|preview|experiment|proposal",
  "primaryPost": "{text,claimIds,assetRefs}",
  "posts": "[{order,clientId,parentClientId,text,claimIds,assetRefs}]",
  "contextUrl": "optional public URL",
  "firstPostStandaloneCheck": "{passed,missingContext}",
  "replyBrief": "[{question,answerBasis,uncertainty}]",
  "accountConstraintSnapshot": "{checkedAt,source,limits}",
  "publicationState": "prepared_only"
}
```

**D · 质量量表**

| 检查项 | 分值 | 可复核要求 |
| --- | ---: | --- |
| 首帖独立准确 | 20 | 不依赖后文才理解真实状态与限制 |
| 每条有新增信息 | 20 | 没有机械分段和重复号召 |
| 证据 | 25 | 每个更新和成效有绑定 |
| 连接顺序 | 15 | thread关系无环且可追溯 |
| 简洁且自然 | 10 | 无空洞口号和无关标签 |
| 真实互动/权利 | 10 | 不批量骚扰、不交换互动 |

**D · 岗位独立记忆**

D：accountId×locale保存已发变化、未完成承诺、可公开demo散列、读者常见疑问和作者短句风格；每个thread保留父子关系，避免独立重发；不存个人用户画像或互赞名单。

**D · 规则更新**

D：每次外发前动态核对账号格式限制与当前X authenticity/developer规则；每30天规则refresh为建议，账号受限或格式失败时立即停下相关发送并保留错误，不换号。

**D · 二次制作计划**

1. 从母内容找出唯一新变化并写独立结论，附Claim映射与released/preview边界。
2. 必要时产生原生posts数组，不能直接把article body按字符截断。
3. 若选demo短片，先复用获准现有素材，再走正式剪辑/字幕/封面；不为社交重复生成同一镜头。
4. 完成逐条长度/链接/父子关系/事实检查后进入人工发布包；实际发送后需每条真实postId与URL回读。

**实际链路映射**：`EDITORIAL_VARIANT` → `MEDIA_ASSET` → `VIDEO_PLAN` → `VIDEO_QA`；视频实际执行如需要还依赖 `CLI_PRODUCTION`，不是调用preview即完成。

**D · 具体ToolTask例子与可用性**

这些是计划载荷，`${...}`须在未来受控执行器中解析。`missing`项没有可调用ID，`existing_admin_api`也不向受限Agent开放。完整输入、依赖、失败条件与产物在同名JSON的`operator.toolTasks`。

| 任务 | 可用性 | 真实入口/状态 | 预期产物 |
| --- | --- | --- | --- |
| `x.native-adapt` | `missing` | `没有当前可调用工具；D设计` | x-native-contract.json, x-adaptation-plan.json |
| `x.independent-editorial-quality` | `missing` | `没有当前可调用工具；D设计` | hash-bound-platform-review-with-reasons |
| `x.persist-channel-draft` | `existing_admin_api` | `POST /api/editions/{editionId}/variants` | immutable-variant-snapshot-with-hash |
| `x.native-publish-and-readback` | `missing` | `没有当前可调用工具；D设计` | real-platform-ids-and-urls, exact-destination-content-readback |

**能力缺口**

- D：现有article/image_text/video没有原生thread posts数组、顺序与部分发送恢复状态。
- D：账号特定字符计数、媒体约束和多帖回读适配器未实现。
- A：现有编辑API只存一份body和blocks，不自动生成thread或发布到X。

**D · 接入后验收场景**：D：同一母稿分别编译单帖和4条thread；删除第3条后拓扑/逻辑检查应失败，第一条不得宣称仍在preview的功能已正式发布；模拟部分发送只能查原postId，不能重发整个thread。

### YouTube专家

**D · 使命**：负责观众承诺、任务教学和视频包装的一致性，决定完整demo与Shorts各自需要的再创作。

**D · 必须自己做的专家决策**

- 先判搜索教学、产品评估还是Shorts单点解释，并只设一个主要观众承诺。
- 判断现有录屏/原片能证明什么，缺关键步骤则提出补证，不编UI。
- 决定横竖画幅、字幕方式、章节、封面和描述；账号当前限制另行核实。
- 对标题/封面/开场/正文逐项核对兑现情况，合成披露按实际媒体判定。

**D · 原生输出合同草案**（不是现API已支持字段）

```json
{
  "format": "long_demo|tutorial|shorts",
  "viewerPromise": "string",
  "intentMode": "search|browse|shorts",
  "titleCandidates": "[{text,whyAccurate}]",
  "thumbnailBrief": "{focalPoint,text,sourceAssetRefs,noFabrication}",
  "timeline": "[{startMs,endMs,purpose,screenEvidence,narration,claimIds}]",
  "chapters": "[{startMs,title}]",
  "description": "{summary,prerequisites,steps,sources,disclosure,links}",
  "captionRefs": "[{assetId,sha256,locale,clockBasis}]",
  "mediaSpec": "{aspect,durationTarget,accountLimitsRef}",
  "qualityState": "technical_and_editorial_separate"
}
```

**D · 质量量表**

| 检查项 | 分值 | 可复核要求 |
| --- | ---: | --- |
| 承诺兑现 | 20 | 标题/封面/开场承诺在片中可定位 |
| 真实演示 | 25 | 步骤与产物有真实画面证据 |
| 解释结构 | 15 | 前置、失败和结果核对齐全 |
| 声音与字幕 | 15 | 字幕时间与最终文件一致且可懂 |
| 包装清楚 | 10 | 缩略图可读且不捏造效果 |
| 来源与披露 | 15 | Claim/音乐/人物/AI披露适用 |

**D · 岗位独立记忆**

D：channelId×locale×series保存观众基础、术语解释习惯、已讲前置、真实常见问题、被纠正步骤、模板与标题测试的真实结果；不把一次CTR/留存变化归因给唯一因素。

**D · 规则更新**

D：制作前刷新YouTube title/disclosure/format规则与账号可用能力；更新字幕、改剪辑、换封面会生成新的审核快照。30天刷新为内部建议，无定时任务已创建。

**D · 二次制作计划**

1. 从母稿提炼观众问题与可兑现承诺，生成timeline及录屏/源片缺口清单。
2. 已有源片优先复用；新生成需正式前期和真实授权。读取growth.video.workbench.guide、readiness/catalog/shots；production.plan只产生参数化计划。
3. 现有CLI正式剪辑/后期处理字幕、封面、BGM；实际执行需未来受控执行器。长视频/非30秒不能假定Studio metadata已兑现，须核对正式时长。
4. delivery.inspect核字节，post.quality核当前媒体技术；另做画面与教学/标题兑现审阅。成片、海报、字幕入媒体资产后再建video variant。

**实际链路映射**：`VIDEO_GUIDE` → `VIDEO_CATALOG` → `VIDEO_SHOTS` → `VIDEO_PLAN` → `VIDEO_STATUS` → `VIDEO_QA` → `MEDIA_ASSET` → `EDITORIAL_VARIANT`；视频实际执行如需要还依赖 `CLI_PRODUCTION`，不是调用preview即完成。

**D · 具体ToolTask例子与可用性**

这些是计划载荷，`${...}`须在未来受控执行器中解析。`missing`项没有可调用ID，`existing_admin_api`也不向受限Agent开放。完整输入、依赖、失败条件与产物在同名JSON的`operator.toolTasks`。

| 任务 | 可用性 | 真实入口/状态 | 预期产物 |
| --- | --- | --- | --- |
| `youtube.native-adapt` | `missing` | `没有当前可调用工具；D设计` | youtube-native-contract.json, youtube-adaptation-plan.json |
| `youtube.guide` | `existing_read` | `growth.video.workbench.guide` | current-guide-markdown-with-sha |
| `youtube.video-plan` | `existing_preview` | `growth.video.production.plan` | preview-checklist, execution.command, execution.args |
| `youtube.formal-media-execute` | `documented_cli` | `scripts/tools/full-chain-film.mts (generation); existing formal editing path chosen from current guide for source-footage reedit` | final-real-media, stage-ledger, delivery-manifest |
| `youtube.technical-quality` | `existing_read` | `growth.video.post.quality` | current-technical-verdict |
| `youtube.independent-editorial-quality` | `missing` | `没有当前可调用工具；D设计` | hash-bound-platform-review-with-reasons |
| `youtube.persist-channel-draft` | `existing_admin_api` | `POST /api/editions/{editionId}/variants` | immutable-variant-snapshot-with-hash |
| `youtube.native-publish-and-readback` | `missing` | `没有当前可调用工具；D设计` | real-platform-ids-and-urls, exact-destination-content-readback |

**能力缺口**

- A：原生指南标明Studio新建/补跑intent仍按durationSec30构建，非30秒需核对正式前期；不是现成通用长教程执行器。
- D：章节/描述/标题候选/缩略图语义验证、Shorts原生发布包尚无专属schema或工具。
- A：post.quality合同只给技术结果，artisticQuality仍unverified；观众承诺与艺术评审需要新增独立角色。
- D：ASR/字幕本地工位目录存在不等于已暴露为本Agent可直接生产的工具，本研究没有调用模型或新跑视频。

**D · 接入后验收场景**：D：从同一真实流程做完整教程计划与独立Shorts计划；不允许仅改标题和比例。制造“标题承诺三步、正文只有两步”应退回；改最终视频时钟必须让旧字幕审核失效；非30秒项目须记录下游实际时长。

### TikTok专家

**D · 使命**：把一个有证据的动作重做成手机上看得懂的原生短片，明确其与广告指引迁移的证据边界。

**D · 必须自己做的专家决策**

- 判断这一点是否能用真实画面展示；不能展示就换为有证据的解释，不生成假UI。
- 选择搜索问题型、可见对照型或过程型开场，确认不是无关热点。
- 决定是否需要竖屏重新构图、字幕重写、音轨清理与单点结尾；照片帖另设说明。
- 检查AIGC、商业关系、音源和人物授权，明确当前地区/账号能力尚未核实。

**D · 原生输出合同草案**（不是现API已支持字段）

```json
{
  "format": "short_video|photo_post",
  "oneQuestion": "string",
  "openingFrame": "{visualProof,onscreenText,claimIds}",
  "beats": "[{purpose,sourceRange,visual,narration,caption,claimIds}]",
  "safeAreaSpec": "{aspect,uiOverlayRef,checkedAt}",
  "soundPlan": "{originalVoice,musicRights,permissionRefs}",
  "caption": "{searchPhrase,context,limits,disclosure}",
  "aiDisclosure": "{required,reason,labelText}",
  "adaptationEvidence": "{sourceHash,changedFraming,changedNarrative,unchangedClaims}",
  "sampleVerification": "pending_actual_target_examples"
}
```

**D · 质量量表**

| 检查项 | 分值 | 可复核要求 |
| --- | ---: | --- |
| 首屏能懂 | 20 | 无需背景即可知道具体问题 |
| 单点完整 | 20 | 只讲一件事且结尾兑现 |
| 真实证明 | 25 | 没有假实时或伪造对比 |
| 手机画面/字幕 | 15 | 竖屏重构、可读且不压UI |
| 声音 | 10 | 可懂、有权利、没有静默替声 |
| 披露与目的 | 10 | AI/商业信息正确且无无关趋势 |

**D · 岗位独立记忆**

D：accountId×locale×region保存已确认的受众理解门槛、常见搜索问题、实际授权音源范围、画面安全区和获准开场例子；趋势带取得时间与适用范围，过期后不自动复用。当前无真实账号数据。

**D · 规则更新**

D：每次外发核对AIGC与商业音乐/账号地区；每30天读官方指南作为建议。广告指引与自然内容实测分别保存，不能把一次播放表现写成自然算法公式。

**D · 二次制作计划**

1. 锁定母稿Claim与源媒体散列，挑一个可视觉证明的动作，先写独立beat计划。
2. 复用已有真实镜头，按正式剪辑链重构竖屏、字幕、封面和声音；平台名只是production.plan参数，不代表TikTok预设/账号限制已通过。
3. 新生成走本仓正式前期并核准固定项；不为了适配短视频偷偷换人、换音色或改变商品事实。
4. 技术QA与内容rubric分开，生成媒体资产及平台caption草稿；未有真实样本/账号权限前保留需要复核项，外发仍是独立任务。

**实际链路映射**：`VIDEO_GUIDE` → `VIDEO_PLAN` → `VIDEO_STATUS` → `VIDEO_QA` → `MEDIA_ASSET` → `EDITORIAL_VARIANT`；视频实际执行如需要还依赖 `CLI_PRODUCTION`，不是调用preview即完成。

**D · 具体ToolTask例子与可用性**

这些是计划载荷，`${...}`须在未来受控执行器中解析。`missing`项没有可调用ID，`existing_admin_api`也不向受限Agent开放。完整输入、依赖、失败条件与产物在同名JSON的`operator.toolTasks`。

| 任务 | 可用性 | 真实入口/状态 | 预期产物 |
| --- | --- | --- | --- |
| `tiktok.native-adapt` | `missing` | `没有当前可调用工具；D设计` | tiktok-native-contract.json, tiktok-adaptation-plan.json |
| `tiktok.guide` | `existing_read` | `growth.video.workbench.guide` | current-guide-markdown-with-sha |
| `tiktok.video-plan` | `existing_preview` | `growth.video.production.plan` | preview-checklist, execution.command, execution.args |
| `tiktok.formal-media-execute` | `documented_cli` | `scripts/tools/full-chain-film.mts (generation); existing formal editing path chosen from current guide for source-footage reedit` | final-real-media, stage-ledger, delivery-manifest |
| `tiktok.technical-quality` | `existing_read` | `growth.video.post.quality` | current-technical-verdict |
| `tiktok.native-visual-layout` | `missing` | `没有当前可调用工具；D设计` | rendered-native-visuals, per-page-proof |
| `tiktok.independent-editorial-quality` | `missing` | `没有当前可调用工具；D设计` | hash-bound-platform-review-with-reasons |
| `tiktok.persist-channel-draft` | `existing_admin_api` | `POST /api/editions/{editionId}/variants` | immutable-variant-snapshot-with-hash |
| `tiktok.native-publish-and-readback` | `missing` | `没有当前可调用工具；D设计` | real-platform-ids-and-urls, exact-destination-content-readback |

**能力缺口**

- D：自然TikTok真实目标账号样本、地区能力、热门音频商业授权尚未核实。
- D：photo post原生结构、音源许可检查、UI安全区自动校验与AIGC/商业标签字段未集成。
- A：现有工具不会因为platform=tiktok而自动发布；Direct Post连接/审核/回读未做。

**D · 接入后验收场景**：D：横屏demo输入必须产生新的竖屏构图与字幕安排，不能只改输出尺寸；若字幕遮住关键按钮或音源许可空缺应退回；没有真实AIGC判断依据不得自动勾选或省略标签。

### Instagram专家

**D · 使命**：围绕一个读者能看清的视觉论点重新安排图卡或Reel，把视觉解释质量作为独立职责。

**D · 必须自己做的专家决策**

- 先判图卡/单图/Reel哪一种最能表达证据，而不是所有格式都做。
- 为每页或每个beat写明一个要理解的点和所需真实画面。
- 决定哪些内容留在caption、哪些必须在图中看见，控制阅读负担。
- 检查原作、素材许可、AI/商业披露与真实账号的推荐资格/格式。

**D · 原生输出合同草案**（不是现API已支持字段）

```json
{
  "format": "reel|carousel|photo",
  "visualThesis": "string",
  "cover": "{promise,visual,claimIds}",
  "slides": "[{order,role,headline,body,assetRef,alt,claimIds}]",
  "reelBeats": "[{purpose,sourceRange,visual,captions,claimIds}]",
  "caption": "{context,insight,limits,question,disclosure}",
  "layoutSpec": "{aspect,safeAreas,typography,source}",
  "originalityStatement": "{whatWasCreated,newValue,rightsRefs}",
  "reviewFrames": "[{artifactSha256,frameOrSlide,checks}]"
}
```

**D · 质量量表**

| 检查项 | 分值 | 可复核要求 |
| --- | ---: | --- |
| 每页/首帧可懂 | 20 | 手机上能说出这页讲什么 |
| 视觉层级 | 20 | 有焦点、无溢出、少而清楚的文字 |
| 原创与事实 | 25 | 有独立解释且实际产品画面不伪造 |
| caption与alt | 15 | 补上下文/局限并可访问 |
| 顺序和媒体完整 | 10 | 顺序正确且无缺页/缺镜 |
| 权利与披露 | 10 | 原作/音乐/人物/AI声明有依据 |

**D · 岗位独立记忆**

D：accountId×locale保存品牌视觉规范、允许字体/配色、已验证caption语气、获准素材、读者常见提问和人工逐页修改；保留账号与目标格式，不能把Instagram改稿规则覆盖LinkedIn文档。

**D · 规则更新**

D：首次启用与每次格式/账号变动时读真实专业仪表盘/Account Status；每30天官方指南refresh为建议。没有当前账号证据时写unverified，不给最佳比例/标签数结论。

**D · 二次制作计划**

1. 从母内容选一个视觉论点，写逐页/逐beat方案，决定保留哪些Claim而不是按段落截屏。
2. 现有image_text可承载顺序图片块和assetRefs，但需新增原生slides/版式与导出合同；Reel按正式视频链剪辑/字幕并独立审看手机构图。
3. 生成/上传实际获准素材、核对散列和alt；图卡原稿、最终图片、caption一起参与精确快照。
4. 平台专家审阅原生性，视觉审阅者逐页/逐帧核实；仍需真实账号权限与发布回读。

**实际链路映射**：`MEDIA_ASSET` → `EDITORIAL_VARIANT` → `VIDEO_GUIDE` → `VIDEO_PLAN` → `VIDEO_QA`；视频实际执行如需要还依赖 `CLI_PRODUCTION`，不是调用preview即完成。

**D · 具体ToolTask例子与可用性**

这些是计划载荷，`${...}`须在未来受控执行器中解析。`missing`项没有可调用ID，`existing_admin_api`也不向受限Agent开放。完整输入、依赖、失败条件与产物在同名JSON的`operator.toolTasks`。

| 任务 | 可用性 | 真实入口/状态 | 预期产物 |
| --- | --- | --- | --- |
| `instagram.native-adapt` | `missing` | `没有当前可调用工具；D设计` | instagram-native-contract.json, instagram-adaptation-plan.json |
| `instagram.guide` | `existing_read` | `growth.video.workbench.guide` | current-guide-markdown-with-sha |
| `instagram.video-plan` | `existing_preview` | `growth.video.production.plan` | preview-checklist, execution.command, execution.args |
| `instagram.formal-media-execute` | `documented_cli` | `scripts/tools/full-chain-film.mts (generation); existing formal editing path chosen from current guide for source-footage reedit` | final-real-media, stage-ledger, delivery-manifest |
| `instagram.technical-quality` | `existing_read` | `growth.video.post.quality` | current-technical-verdict |
| `instagram.native-visual-layout` | `missing` | `没有当前可调用工具；D设计` | rendered-native-visuals, per-page-proof |
| `instagram.independent-editorial-quality` | `missing` | `没有当前可调用工具；D设计` | hash-bound-platform-review-with-reasons |
| `instagram.persist-channel-draft` | `existing_admin_api` | `POST /api/editions/{editionId}/variants` | immutable-variant-snapshot-with-hash |
| `instagram.native-publish-and-readback` | `missing` | `没有当前可调用工具；D设计` | real-platform-ids-and-urls, exact-destination-content-readback |

**能力缺口**

- D：原生carousel slides、页序/单页文字预算、批量图卡排版与视觉QA尚未登记工具。
- D：实际视觉样本未读、目标账号Account Status与格式限制未核实。
- A：现有image blocks仅保证资产引用与文本约束，不自动证明图卡美观或Instagram原生适配。

**D · 接入后验收场景**：D：同一技术母稿产生可独立读懂的carousel和Reel提案，逐页正文不是长文等分；故意交换页序、缺alt、用AI假界面或字太小均应退回；改图片散列需重新审核。

### Facebook专家

**D · 使命**：按Page、Profile与具体Group分别决定读者价值和原创表达，阻止把跨平台搬运数量当运营质量。

**D · 必须自己做的专家决策**

- 明确目的地类型与现有成员背景，决定是否适合发布或只回答已有问题。
- 决定Feed图文、Reel还是Group答复；不要默认全部分发。
- 判断第三方引用是否有实质新解释，版权与推荐原创分别登记。
- 选择与媒体相关的caption/问题并检查群规、身份披露和账号当前权限。

**D · 原生输出合同草案**（不是现API已支持字段）

```json
{
  "format": "feed_post|reel|group_answer",
  "destinationContext": "{kind,communityTopic,ruleSnapshot,memberNeed}",
  "opening": "string",
  "bodyBlocks": "[{purpose,text,claimIds}]",
  "mediaRefs": "[{assetId,sha256,newValue}]",
  "captionMediaRelevance": "{passed,reason}",
  "affiliationDisclosure": "string",
  "originalityEvidence": "{ownProduction,addedAnalysis,thirdPartyRights}",
  "discussionPlan": "{question,answerBasis,noBulkPromotion}"
}
```

**D · 质量量表**

| 检查项 | 分值 | 可复核要求 |
| --- | ---: | --- |
| 原创/新增价值 | 25 | 不是第三方片段低价值加工 |
| 目的地相关 | 20 | 回应Page受众或具体Group问题 |
| 实际帮助 | 20 | 不点链接也能获得做法 |
| caption匹配 | 15 | 媒体/文字同主题且无堆标签 |
| 真实互动 | 10 | 无互赞或批量推广 |
| 权利与披露 | 10 | 身份、AI/商业和素材清楚 |

**D · 岗位独立记忆**

D：accountId×destinationId×locale保存各Group规则与审核日期、成员常见问题、允许链接/自推广范围、Page连续叙事及人工反馈；不得把一个Group允许事项传播成全平台许可。

**D · 规则更新**

D：每个Group发稿前重新读当次规则，账号/目的地变化立即重审；每30天刷新Facebook originality/spam官方来源是维护建议。没有群规/身份明确记录的任务停在准备状态。

**D · 二次制作计划**

1. 母稿只作为事实与素材来源，按Page或特定Group重新选问题和展开顺序。
2. Feed图文走实际素材与blocks；Reel走正式视频链重剪；Group答复先验证话题/身份披露，必要时判定不发。
3. 每个目的地单独建variant并绑定account/destination snapshot，不能把一个Facebook结果当所有Group已发布。
4. 原创语义/规则审核与媒体技术验收分别记录，真实外发需对应目的地帖子URL/ID和回读。

**实际链路映射**：`EDITORIAL_VARIANT` → `MEDIA_ASSET` → `VIDEO_GUIDE` → `VIDEO_PLAN` → `VIDEO_QA`；视频实际执行如需要还依赖 `CLI_PRODUCTION`，不是调用preview即完成。

**D · 具体ToolTask例子与可用性**

这些是计划载荷，`${...}`须在未来受控执行器中解析。`missing`项没有可调用ID，`existing_admin_api`也不向受限Agent开放。完整输入、依赖、失败条件与产物在同名JSON的`operator.toolTasks`。

| 任务 | 可用性 | 真实入口/状态 | 预期产物 |
| --- | --- | --- | --- |
| `facebook.native-adapt` | `missing` | `没有当前可调用工具；D设计` | facebook-native-contract.json, facebook-adaptation-plan.json |
| `facebook.guide` | `existing_read` | `growth.video.workbench.guide` | current-guide-markdown-with-sha |
| `facebook.video-plan` | `existing_preview` | `growth.video.production.plan` | preview-checklist, execution.command, execution.args |
| `facebook.formal-media-execute` | `documented_cli` | `scripts/tools/full-chain-film.mts (generation); existing formal editing path chosen from current guide for source-footage reedit` | final-real-media, stage-ledger, delivery-manifest |
| `facebook.technical-quality` | `existing_read` | `growth.video.post.quality` | current-technical-verdict |
| `facebook.independent-editorial-quality` | `missing` | `没有当前可调用工具；D设计` | hash-bound-platform-review-with-reasons |
| `facebook.persist-channel-draft` | `existing_admin_api` | `POST /api/editions/{editionId}/variants` | immutable-variant-snapshot-with-hash |
| `facebook.native-publish-and-readback` | `missing` | `没有当前可调用工具；D设计` | real-platform-ids-and-urls, exact-destination-content-readback |

**能力缺口**

- D：原生Page/Profile/Group细分校验、群规快照/链接许可与回应上下文没有平台专属schema。
- D：Facebook实际样本文字和视觉未访问成功；不能在首次上线前声称调性已由样本证实。
- A：编辑服务支持不同destination保存稿件，但没有Facebook原生发布与回读适配器。

**D · 接入后验收场景**：D：同一母稿的Page稿和Group答复应分别回应不同背景；Group禁止自推广时应给不发布结论；低价值第三方重剪不能因已获素材许可就通过原创检查。

### Reddit专家

**D · 使命**：先判断社区是否欢迎这类参与，再以透明关系与可核对证据发起真实讨论，必要时决定不发。

**D · 必须自己做的专家决策**

- 判定具体subreddit、当前话题、规则与发帖/评论/megathread入口。
- 判断产品性质是否满足目标社区范围；不满足则no_publish并给可解释原因。
- 选择一个社区能回答的具体问题，公开作者/团队关系。
- 准备技术追问、反例和失败复现；没有事实则不说已支持。

**D · 原生输出合同草案**（不是现API已支持字段）

```json
{
  "format": "community_post|megathread_entry|comment|no_publish",
  "destination": "{subreddit,url,ruleSnapshotHash,checkedAt,allowedFormats,commercialPolicy}",
  "affiliation": "{relationship,disclosure}",
  "title": "string",
  "body": "{problem,method,comparison,validation,limitations,feedbackQuestion}",
  "claimBindings": "[{claimId,hash,section}]",
  "reproductionAssets": "[{assetId,sha256,scope}]",
  "replyContext": "{parentUrl,question,answerBasis}",
  "decisionReason": "string"
}
```

**D · 质量量表**

| 检查项 | 分值 | 可复核要求 |
| --- | ---: | --- |
| 目的地规则 | 30 | 当前规则与产品性质匹配 |
| 相关性 | 20 | 回应社区实际讨论 |
| 关系透明 | 20 | 不伪装用户/隐藏利益关系 |
| 证据和限制 | 20 | 复现条件与未知范围明确 |
| 讨论问题 | 10 | 能回答具体问题且不索取互动 |

**D · 岗位独立记忆**

D：accountId×subreddit×locale保存规则快照、允许内容范围、版主明确反馈、当前未解决问题与我们已承诺的后续；不记成员敏感资料、不存刷karma策略，不把一个sub许可当全站许可。

**D · 规则更新**

D：每次发稿检查当下规则/置顶与相关重复主题，旧规则快照失效就重新判定。站点spam每30天刷新为建议；社区移除或限制立即把该目的地任务置hold并保留原因。

**D · 二次制作计划**

1. 先执行目的地适配判定；例如当前LocalLLaMA showcase对closed-source商业服务不合适就产出no_publish，不能进入文案生成后硬发。
2. 从母稿抽取可复现方法，重新写社区问题、比较与限制，所有功能/测试声明回到Claim证据。
3. 支持的文字/图片/视频可通过现有edition/variant及媒体引用保存草稿；原生subreddit/flair/megathread/parent字段需新增结构化合同。
4. 审核通过后只输出实际目的地的发布包；回复和后续更新绑定原帖上下文，每条外发另有真实ID/URL与回读。

**实际链路映射**：`EDITORIAL_VARIANT` → `MEDIA_ASSET` → `VIDEO_QA`；视频实际执行如需要还依赖 `CLI_PRODUCTION`，不是调用preview即完成。

**D · 具体ToolTask例子与可用性**

这些是计划载荷，`${...}`须在未来受控执行器中解析。`missing`项没有可调用ID，`existing_admin_api`也不向受限Agent开放。完整输入、依赖、失败条件与产物在同名JSON的`operator.toolTasks`。

| 任务 | 可用性 | 真实入口/状态 | 预期产物 |
| --- | --- | --- | --- |
| `reddit.native-adapt` | `missing` | `没有当前可调用工具；D设计` | reddit-native-contract.json, reddit-adaptation-plan.json |
| `reddit.independent-editorial-quality` | `missing` | `没有当前可调用工具；D设计` | hash-bound-platform-review-with-reasons |
| `reddit.persist-channel-draft` | `existing_admin_api` | `POST /api/editions/{editionId}/variants` | immutable-variant-snapshot-with-hash |
| `reddit.native-publish-and-readback` | `missing` | `没有当前可调用工具；D设计` | real-platform-ids-and-urls, exact-destination-content-readback |

**能力缺口**

- D：社区规则提取/产品范围判定、flair/megathread/parent上下文与no_publish结果没有当前专用工具。
- A：目录虽登记Reddit，但automaticPublication=false；createDestination强制kind=community并绑定账号，不是已接通原生Reddit。
- D：不能以历史公开样本作为当前目标subreddit已经批准产品推广的证据。

**D · 接入后验收场景**：D：同一产品在禁止自推广的sub、允许特定showcase的sub与自己的已授权社区应产生不同决策；closed-source服务进入LocalLLaMA当前showcase应no_publish；删除关系披露或复现依据应不通过。

### Discord专家

**D · 使命**：在明确服务器、频道和上下文中提供帮助与更新，决定何时回复、开Forum主题、发公告或不打扰成员。

**D · 必须自己做的专家决策**

- 核对serverId/channelId/可选threadId、成员或bot身份与任务范围。
- 读已有上下文，判断回复现有thread还是建立持久Forum主题；可重复问题先指向已有有效答案。
- 为不同频道选择支持/反馈/公告语言，决定有无通知必要。
- 检查敏感资料、附件许可、通知范围和社区边界，不使用个人账号self-bot。

**D · 原生输出合同草案**（不是现API已支持字段）

```json
{
  "format": "channel_message|forum_post|thread_reply|no_send",
  "destination": "{serverId,channelId,threadId,channelKind,ruleSnapshotHash,permissionSnapshot}",
  "context": "{parentMessageUrl,summary,sourceVisibility}",
  "forum": "{title,tags,problem,environment,steps,evidence,question}",
  "message": "{text,attachments,claimIds}",
  "notificationPlan": "{mentionRequested:false,reason,approvedTargets}",
  "sensitiveDataReview": "{redacted,externalReuseAllowed:false}",
  "followup": "{expectedOutcome,nextCheck,owner}"
}
```

**D · 质量量表**

| 检查项 | 分值 | 可复核要求 |
| --- | ---: | --- |
| 目的地/权限 | 30 | 服务器频道身份明确且任务允许 |
| 帮助具体 | 20 | 能按步骤做或明确下个动作 |
| 上下文连续 | 20 | 回应原问题且无重复开帖 |
| 通知克制 | 15 | 无无请求DM/批量提及 |
| 事实与隐私 | 15 | 日志/附件安全且不编结果 |

**D · 岗位独立记忆**

D：accountOrBotId×serverId×channelId×locale保存频道指南、角色允许动作、已解决FAQ、未解决问题和获准术语；thread保留父链接。服务器之间隔离，私有社区内容不回流公共知识库或其它平台。

**D · 规则更新**

D：每次发送前检查当下频道权限/指南与bot官方策略；新角色或频道变化立即重新授权。平台规范每30天refresh为建议；不创建账号或自动加入server来补样本。

**D · 二次制作计划**

1. 从母稿只取该社区当前问题需要的事实，结合获准thread上下文重写支持/公告/Forum稿。
2. 现有community_channel destination已经承载serverId/channelId/threadId；保持真实ID，但不可把登记成功当消息发送成功。
3. 文字/附件先在编辑/媒体体系保存安全草稿；新原生消息合同要保存channelKind、parent、tags与通知计划。
4. 未来获准bot或人工执行后核对真实messageId/目标频道/附件，不以HTTP成功、空URL或undefined ID判已发送。

**实际链路映射**：`EDITORIAL_VARIANT` → `MEDIA_ASSET`；视频实际执行如需要还依赖 `CLI_PRODUCTION`，不是调用preview即完成。

**D · 具体ToolTask例子与可用性**

这些是计划载荷，`${...}`须在未来受控执行器中解析。`missing`项没有可调用ID，`existing_admin_api`也不向受限Agent开放。完整输入、依赖、失败条件与产物在同名JSON的`operator.toolTasks`。

| 任务 | 可用性 | 真实入口/状态 | 预期产物 |
| --- | --- | --- | --- |
| `discord.native-adapt` | `missing` | `没有当前可调用工具；D设计` | discord-native-contract.json, discord-adaptation-plan.json |
| `discord.independent-editorial-quality` | `missing` | `没有当前可调用工具；D设计` | hash-bound-platform-review-with-reasons |
| `discord.persist-channel-draft` | `existing_admin_api` | `POST /api/editions/{editionId}/variants` | immutable-variant-snapshot-with-hash |
| `discord.native-publish-and-readback` | `missing` | `没有当前可调用工具；D设计` | real-platform-ids-and-urls, exact-destination-content-readback |

**能力缺口**

- A：现有服务允许Discord community_channel locator，但没有当前Discord消息/Forum发送与回读工具。
- D：真实目标频道样本、权限快照、上下文读取和通知计划校验未接通。
- D：bot/webhook任务边界与最小权限要独立设计，不能用self-bot补缺口；本研究未调用Discord API。

**D · 接入后验收场景**：D：同一更新在支持thread、公告频道和Forum中应产出不同稿件或no_send；缺server/channel、无权限、含秘密或默认群体提及应失败；模拟403或缺messageId不能进入sent。

### Medium专家

**D · 使命**：帮助真实作者完成有第一手价值的英文叙事，明确AI使用与分发边界，拒绝把平台当AI文章流量工厂。

**D · 必须自己做的专家决策**

- 先判断是否有足够第一手作者材料；没有则no_story或标明资料型，不能捏造亲历。
- 判断是否具有非销售的独立读者价值以及适合Medium的论证长度。
- 确定AI是语法/提纲辅助、生成片段还是多数生成，执行不同披露与付费墙限制。
- 选择标题/副标题/图片/代码，使它们对应论证；明确不承诺General或Boost。

**D · 原生输出合同草案**（不是现API已支持字段）

```json
{
  "format": "human_led_story|tutorial|case_study|no_story",
  "authorContribution": "{author,firstHandMaterials,confirmedObservations,authorEdits}",
  "readerQuestion": "string",
  "title": "string",
  "subtitle": "string",
  "narrative": "[{sectionPurpose,text,claimIds,authorMaterialRefs}]",
  "illustrations": "[{assetId,sha256,alt,credit,aiCaption}]",
  "aiUse": "{category,generatedSections,disclosureText,disclosurePosition,paywallAllowed}",
  "distributionExpectation": "{networkPossible,generalNotGuaranteed,boostNotGuaranteed,reasons}",
  "sources": "[{claimId,url,attribution}]"
}
```

**D · 质量量表**

| 检查项 | 分值 | 可复核要求 |
| --- | ---: | --- |
| 真实作者贡献 | 30 | 亲历材料/观点经本人确认 |
| 独立读者价值 | 20 | 不以销售注册为主要目的 |
| 证据与来源 | 20 | 方法结果代价可追溯 |
| 论证工艺 | 15 | 叙事连续且有具体取舍 |
| 准确包装 | 10 | 标题副标题封面代表正文 |
| AI披露 | 5 | 分类、位置、图片caption与付费限制正确 |

**D · 岗位独立记忆**

D：authorId×publicationId×locale保存本人确认经历、术语/叙事节奏、允许公开材料、编辑反馈与各生成段落标记；不把一个publication规则当全Medium规则，不记录虚构经历作为记忆。

**D · 规则更新**

D：每次起稿/发布前读取AI与distribution当前正文，源文变化立即重审标题/披露/分发预期；每30天refresh为维护建议。publication投稿要求需逐个读取，账号Partner资格本次未核实。

**D · 二次制作计划**

1. 从母内容取Claim与真实作者材料，先做适合性判断；纯营销/多数AI生成不能伪装为可获得General的案例。
2. 生成论证提纲/资料缺口，真实作者提供或确认观察、方法、失败与代价；英文按读者语境重写，不直译。
3. 图/代码/来源用于解释，生成段落与AI图片标注可追溯；保存article edition/variant以及sourceEdition关系，但source链接不等于有了亲历。
4. 人确认作者贡献、事实、AI披露与读者价值后交人工原生编辑器发布包；明确站内分发/付费墙预期，不把发布成功当推荐成功。

**实际链路映射**：`EDITORIAL_VARIANT` → `MEDIA_ASSET`；视频实际执行如需要还依赖 `CLI_PRODUCTION`，不是调用preview即完成。

**D · 具体ToolTask例子与可用性**

这些是计划载荷，`${...}`须在未来受控执行器中解析。`missing`项没有可调用ID，`existing_admin_api`也不向受限Agent开放。完整输入、依赖、失败条件与产物在同名JSON的`operator.toolTasks`。

| 任务 | 可用性 | 真实入口/状态 | 预期产物 |
| --- | --- | --- | --- |
| `medium.native-adapt` | `missing` | `没有当前可调用工具；D设计` | medium-native-contract.json, medium-adaptation-plan.json |
| `medium.independent-editorial-quality` | `missing` | `没有当前可调用工具；D设计` | hash-bound-platform-review-with-reasons |
| `medium.persist-channel-draft` | `existing_admin_api` | `POST /api/editions/{editionId}/variants` | immutable-variant-snapshot-with-hash |
| `medium.native-publish-and-readback` | `missing` | `没有当前可调用工具；D设计` | real-platform-ids-and-urls, exact-destination-content-readback |

**能力缺口**

- D：作者贡献/AI使用分段/披露位置/付费墙资格没有现有专属schema或工具。
- A：编辑API能保存article与code/image blocks，但不会自动写作、校验Medium分发资格或发布到Medium。
- D：原生publication投稿/编辑器适配与真实站内analytics未接通；不设计绕过AI识别或付费墙策略。

**D · 接入后验收场景**：D：母稿只有销售描述时应no_story或重找独立价值；删除真实作者材料不能继续第一人称叙事；多数AI生成稿必须禁用Partner付费墙并说明分发限制；生成图片无caption要失败。

## 第四部分：给root整合的跨岗位接入约束

**D · 共享合同**

Operator接收mother editionHash、Claim hashes、获准媒体、作者/账号声音、目的地/规则快照、目标用户与任务、原始要求与预算；输出必须有no_publish/no_story/no_send能力及原因。研究证据/B与样本/C先于平台策略/D，事实输入与风格输出分开。

AdaptationPlan必须有：`operatorId`、`platformId`、`strategyVersion`、`sourceIds`、`sourceEditionId`、`sourceEditionHash`、`claimBindings`、`accountSnapshotHash`、`destinationSnapshotHash`、`ruleSnapshotHashes`、`audience`、`readerIntent`、`format`、`whyThisFormat`、`originalValue`、`mustPreserve`、`mustNotInvent`、`contentOutlineOrBeats`、`mediaRequests`、`toolTasks`、`budgetReservations`、`qualityRubric`、`humanMaterialGaps`、`publicationMode`。

ToolTask必须有：`taskId`、`kind`、`registeredCapabilityIdOrDocumentedEntry`、`availability=existing_read|existing_preview|existing_admin_api|documented_cli|missing`、`inputsAndExpectedSchema`、`dependsOn`、`expectedArtifacts`、`cacheKey`、`idempotencyOrResumeIdentity`、`requiredAuthority`、`costBudgetUnits`、`deadline`、`failureStopConditions`、`receiptChecks`。

**D · 两种候选**

| 方案 | 优点 | 成本/风险 | 选择 |
| --- | --- | --- | --- |
| 单个通用改写agent加平台名 | 实现成本低，统一事实输入简单 | 会把thread、社区回复、图卡和人主导故事都压平成body；规则/语气/记忆串台；难以解释为什么选择形式 | 不推荐作为最终执行架构 |
| 独立平台专家 + 共享事实/媒体证据 + 受控任务执行与独立QA | 平台判断和原生结构可审查；可明确no_publish；共享Claim不共享虚构经历，支持独立规则与记忆 | 需要新增编排/原生schema/预算及工具权限；实现与维护成本更高 | 推荐，分阶段落地但不提前声称已接通 |

**D · 完整流程**

1.从真实母稿与获准资料冻结输入，读目的地官方规则和已有上下文。

2.平台专家先决定适合性、受众问题、原生形式、论点/节奏与证据；不适合则有理由不发。

3.生成结构化二次制作计划，逐任务核当前工具目录。不存在的生成/编排/版式能力标missing，禁止冒充。

4.实际生产使用现有正式引擎；文字/图卡原生编译器、范围受控写入与任务编排作为新增项；不把read/preview当execute。

5.媒体字节/技术检查与事实/原生结构/语义/艺术审核分开，所有审核绑定最终文件和正文散列。

6.管理员当前存储路径或未来获准writer持久化，UNKNOWN_FIELD/403必须保留并报告，不能假借admin身份。

7.外发是后续独立权限和状态机；所有9当前manual_not_connected，发布包生成不能标已发布；真实平台ID/URL/目标/内容回读后才记录结果。

**D · 优先级与不用它的后果**

| 优先级 | 具体范围 | 用户不用它会怎样 |
| --- | --- | --- |
| P0 | 32来源登记与9份完整研究按版本导入，保留样本访问缺口；每平台独立operator契约、输入事实/作者材料/目的地规则隔离；原生结构与no_publish/no_story/no_send，不把形式都压成文章；工具可用性与范围授权检查；final hash绑定独立QA；text/video/gallery/thread不同任务的真实结果与失败回执 | 目录登记会被误报成已执行；原生形式丢失；事实/授权和最终稿无法对应。 |
| P1 | 原生thread/carousel/document/chapters/community payload编译与预览；由实际源媒体驱动的二次剪辑/排版与逐页/逐帧审核；规则变更审查与人工改稿反馈进入本平台记忆 | 有观点但做不出可用的原生材料，或改稿经验跨平台串台。 |
| P2 | 只用真实已授权analytics做受众实验与策略更新；样本访问补证和跨日期内容质量回归；无数据不自动推导最佳时间/频率 | 长期只靠假设，无法判断内容是否真正帮助目标读者。 |

**D · 失败、超时与并发**

D：rule/account/source hash变化使计划过期；403/权限缺失不换身份；工具缺失不降级成假产物；外部动作超时先查原receipt而非盲重发；并发编辑用当前ETag，任务以母稿hash+平台+目的地+策略+参数建立缓存/幂等身份；预算未知单列且不等于零。

**不做的范围**

- 本研究没有新写/修改产品源码，没有把9专家装进生产。
- 没有账号登录、应用注册、scope申请、加入社区、发帖、模型调用或费用支出。
- 不承诺推荐/爆款/固定增长或绕过AI识别/平台限制。
- 不以目录存在、plan.ready或技术QA通过代替本次生成、艺术验收或远端发布。

## 收尾报告

- 已完成：9平台13维研究、32来源与访问边界；9份平台专家决策/原生schema/100分rubric/隔离记忆/规则维护/二次制作计划；9种现有入口映射与缺口、优先级/候选比较/失败并发边界。
- 未完成/未覆盖：真实账号权限、数据与外发效果未测试；TikTok/Discord样本正文不可读；Instagram视觉、Facebook正文/媒体缺口；YouTube未播放、X原页不可读；整套引擎执行内部与实际模型生成不在本研究范围，不能推断运行或艺术效果。
- 自主追加事项及理由：增加现有Agent编辑权限双层拒绝、长视频30秒默认差异、Medium分发/付费墙和LocalLLaMA目的地不匹配检查，防止设计把目录或文案当已落地能力。
- 采用的假设：目标是对AI工具/实际经营或创作流程感兴趣的读者，具体账号人群尚无analytics证据。；本组默认英文为主要适配语言，Discord可按实际社区中英切换；不把逐句翻译当平台适配。；现有Claim/edition/asset体系继续作为事实与字节的唯一索引；新原生字段需独立合同或明确迁移，不静默舍弃。。
- 置信度：官方政策与本地接口合同高；样本风格是局部C；新operator/生产整合D，平台实测未完成。
- 建议复核：Medium人主导/AI披露/分发预期是否接受；scope受控writer与原生thread/gallery/chapters schema的具体实现；首次发布前补目标账号和视觉/社区样本。

## 自检表

- [是] 覆盖本组9平台全部约定研究维度、契约与映射，没有隐藏容易遗漏项？
- [是] 未把能自主完成的研究推给用户，无不必要询问？
- [是] 来源/代码/样本/设计证据区分，实际访问缺口如实列明？
- [是] 可按本地read provenance与公开URL逐项复查，未声称未做的实现或验收？

<!-- promoted-source-body:end -->

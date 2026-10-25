# C 组：9 个平台研究与岗位合同

> **文档状态：研究／设计归档，新增员工能力尚未实现，待产品方案对焦。** 这是 2026-10-25 同次研究的完整正文晋升。研究所分析的代码基线是 main `4e521c6f9645d7ddde29aae27b0df24bc7610e2e`；正文中的覆盖率、历史动作和验收结果属于原作者的该次研究，不是本次文档发布后的新运行回执。文档进入仓库不创建岗位、compiler、worker、接口、模型任务或外部发布权限。
>
> 原文标为 JSON、provenance、原始抓取、缓存、独立审阅回执的文件名／目录名，均保留为**原研究取证标识**；它们未随本文入库，不是当前仓库文件或可点击下载。公开来源 URL、取得范围、证据 A／B／C／D 和样本访问缺口完整保留。仓库代码路径相对本仓库根目录。本文仅改正原工作区绝对路径／临时路径的可移植表达，并清理原文尾空格，未删减研究正文。
>
> 原始正文取证标识：`platform-research-group-c.md`；SHA-256：`3047a2e223050294a32a67d1232f632f662ee307dc29c21f76746d93a05c226e`。早期产品矩阵为概要；平台限制以三组档案中明确支持的官方来源范围及执行前重新核实的规则为准；编译／执行的详细合同见二次生产集成方案。原文拟议 API、类型与验收仍为 D 级，实际可调用接口见现有接入指南和 API 文档。

三组研究中的 AdaptationPlan／toolTask 字段属于**岗位需求的语义规格**；涉及精确 schema／API、静态编译蓝图与运行期输入 hash、worker 与管理员分工时，以[二次生产集成方案](../PLATFORM-SECONDARY-PRODUCTION.md)第 4—9、11 节为本批文档唯一的后续设计合同。旧字段、旧接口或通用自动准备措辞不并行实施；早期 priorOutputHashes 等语义需求须按该合同分别映射为编译期逻辑依赖和运行期 resolvedInputHash，不能把未来产物／package／终检 hash 回写静态蓝图。研究中的 review／receipt／productionTasks 等语义展示不定义最终哈希载荷；最终以 PublicationPackage → 包外 QualityReport → ReviewEnvelope 及静态 blueprint／运行期 input 的分离为准，旧示意不得把报告、approval 或未来产物 hash 塞回包或蓝图。历史研究中的“需补能力”清单也不表示本期 worker 已纳入；本期 allowlist 与不做项以最新集成为准，例如 notebook 仅静态预览、executeCode:false，不运行单元格，隔离执行需另立实施授权及验证合同。研究中的 documented_cli／参考 command 示例是历史或人工正式 CLI 说明，不是 worker 可执行清单；worker 只能从最新集成的固定 adapter 投影编译任务，不能回放 production.plan 返回的命令。该优先序说明不把任何设计变成已实现接口。

[产品与岗位方案](../CONTENT-OPERATORS-DESIGN.md) · [二次生产集成方案](../PLATFORM-SECONDARY-PRODUCTION.md) · [AI 接入指南](../AI-AGENT-GUIDE.md)

<!-- promoted-source-body:start -->
## 覆盖率声明

- 声明范围内本地文件总数：16；完整精读 A：12；全量 JSON 解析/相关记录读取 B：3；相关章节 C：1；范围内未读：0。详见 `原研究取证标识：platform-research-c-local-coverage.json`。
- 3 个 B 文件为平台目录、行业能力清单、34,651 行完整能力目录；解析/路径存在/声明不等于源码语义审计。C 文件为原有平台员工方案，只读取相关岗位与合同。未重做全仓/第三方全调用链审计。
- 外部研究覆盖本组9个平台，每平台至少2条有意义primary资料；官方直接正文、官方索引正文、样本节选/元数据分开记录。原生样本不完整处在各平台与限制清单明确列出。
- 研究冻结：`2026-10-25T09:51:48Z`；岗位设计开始：`2026-10-25T09:54:30Z`。先研究，再形成以下 D 级设计。
- 源码 main：`4e521c6f9645d7ddde29aae27b0df24bc7610e2e`；当前没有实现岗位、调用模型/媒体/Notebook、登录、外发或购买。

# 平台深度研究与运营员工设计 · C组9个平台

本稿供 Root 整合28岗位与生产工具链方案。读者为本人及获授权管理员。每个平台是独立专业档案；相同母版不强制铺满9份。平台目录里的默认归档状态保持不变。

## 证据等级与本次真实限制

- **A**：本次完整读取的本地源码/文档；只支持读到的行为，不等于线上实测
- **B**：官方资料正文/明确标注的官方搜索索引，或全量JSON元数据解析
- **C**：实际公开个例/节选观察，不能代表平台总体或运营效果
- **D**：岗位/流程/Schema/工具任务与策略的拟议设计，尚未实施

- 百家号未取得合适可读原生样本；两轮检索均无结果，未补造。
- Kaggle与头条样本只取得索引/结构/节选，原生页动态正文为空，未读取完整代码/媒体。
- ModelScope部分动态指南只有标题，采用明确标记的官方索引及真实模型README；不据旧教程给当前SDK命令。
- Hashnode两条编辑器/feature路径404；有效官方CLI/Action正文已取，未把旧索引假装直接页成功。
- DEV新披露公告与canonical旧AI政策存在需注意的范围差异；本设计不自行废止较窄限制。
- 所有账号资格、实际编辑器、登录、套餐与发布权限未核实；没有模型/媒体/Notebook运行或运营效果实验。

## 先处理平台专属边界，再分配工作

- **devto**：AI文章目的筛选/披露/作者理解；评论仅允许本人原文的基础翻译、语法或无障碍辅助；新旧官方文冲突不自动放宽（B规则＋D执行策略）
  - [Guidelines for AI-assisted Articles on DEV - DEV Community](https://dev.to/guidelines-for-ai-assisted-articles-on-dev/)；取得 2026-10-25T09:46:12.237Z；body_extracted。
  - [Introducing AI Disclosure on DEV: Tools for Nuance, Clarity, and Better Feeds - DEV Community](https://dev.to/devteam/introducing-ai-disclosure-on-dev-tools-for-nuance-clarity-and-better-feeds-34mk/)；取得 2026-10-25T09:44:47.893Z；body_excerpt。
  - [Code of Conduct - DEV Community](https://dev.to/code-of-conduct)；取得 2026-10-25T09:31:55.970Z；body_extracted。
- **kaggle**：AI不能从母版起草论坛讨论/评论；保留本人原文翻译/语法例外；真实artifact和Writeups按各自规则（B官方索引，当前直接页正文不可得；D保守实现）
  - [Kaggle Community Guidelines](https://www.kaggle.com/community-guidelines)；取得 2026-10-25；indexed_body_only。
  - [Introducing Writeups!](https://www.kaggle.com/discussions/product-announcements/593763)；取得 2026-10-25；indexed_body_excerpt。
- **maimai**：禁止AI接管账号/模板化批量运营；保留本人单篇研究/编辑与手动执行；身份、隐私、利益诉求逐项核（B规则＋D执行策略）
  - [脉脉社区管理规范](https://maimai.cn/n/platform/rich-text/que1)；取得 2026-10-25T09:34:56.373Z；body_extracted。
  - [关于脉脉社区信息安全的公告 - 脉脉](https://maimai.cn/article/detail?efid=eCHpmEenLcjacMdYib-8MA&fid=1897970440)；取得 2026-10-25T09:34:56.381Z；body_extracted。
- **baijiahao,toutiao,maimai**：当前默认归档为产品状态；研究不自动恢复账号（B目录元数据＋D不擅自恢复策略）

## 共用输入与最终包合同（D，未实施）

| 字段 | 类型/合同 |
|---|---|
| `sourceEdition` | {id,hash,locale,format}；准确不可变来源，不接受只给摘要的母版 |
| `approvedFactBundle` | [{claimId,approvedText,sourceUrl,sourceHash,validUntil,publicLevel,qualifiers}]；新增事实回待核，不自批 |
| `authorAndRights` | 作者角色/可用第一人称/代码、数据、图片、声音、模型与客户材料授权 |
| `artifactInventory` | [{artifactKind,fileRef,sha256,bytes,mime,revision,licenseRef,validationReceiptId,status}]；真实文件与计划分开 |
| `targetSnapshot` | {platformId,accountId,destinationId,identityVersion,visibility,locale,policyVersion}；平台、账号、目的地不能互代 |
| `ruleSnapshot` | {officialSources,retrievedAt,accessLimits,reviewedVersion,uncertainties,blockedBehaviors}；索引正文与直接正文分开 |
| `reproductionEvidence` | 代码/输入/环境/实际日志/输出/失败及口径；无运行证据明确 unrun，不从文字生成数字 |
| `styleMemory` | 仅本账号/目的地/语言/形式/规则范围的已审版本 |
| `budget` | {maxCalls,maxTokens,maxCostMicros,currency,deadlineAt,maxInFlight,pricingSnapshot}；本研究不设供应商价格、不启动调用 |

| 字段 | 类型/合同 |
|---|---|
| `schema` | pengmanager.native-publication-package/vNext（拟议，不是当前 API 已支持类型） |
| `binding` | {storyId,editionId,editionHash,targetSnapshot,profileVersion,ruleVersion,inputHash,nativeForm} |
| `content` | 完整最终 title/body/orderedSections/typedNativeFields；每平台 nativeOutputSchema 见岗位 |
| `files` | [{fileRef,sha256,bytes,mime,role,order,rightsReview,previewRef}]；技术实物也要实际字节 |
| `provenance` | [{outputField,sourceFactOrArtifact,evidenceLevel,qualifier}] |
| `productionTasks` | 逐项策略→输入→所需能力→检查→实际结果；状态 planned/blocked/running/succeeded/failed/unknown |
| `review` | {packageHash,independentReportRefs,checkerVersion,checkedPackageHash,finalHumanApproval}；报告不自签 passed |
| `outcome` | ready_for_human_review / blocked / skip / export_only，原因和未核实项必填；不含外发成功状态 |

- 标题、正文、线程/图像顺序、字幕、文件与原生设置变化都会使旧终检/批准失效
- 没有外部实际结果，不能把 draft/export/本地文件/HTTP 200 记 published
- 普通受限 bearer 不能自行创建/批准现有 v2 内容；新 worker 最小权限尚需设计实施
- 同一语言/形式中立版本不得因平台稿而互相替代；跨形式保留显式 lineage，不挪用翻译 sourceEditionId

专业决策顺序：

1. 平台规则与当前任务目的是否允许（含AI/论坛/批量限制）
2. 作品/素材/作者角色/权利是否真实且适合
3. 读者任务→原生形态→具体切入与论证
4. 准确来源/限定词→实际附件与生产任务
5. 依赖/资格/预算/执行权限；缺失就blocked或export
6. 独立事实、原生形态与真实文件核验
7. 有限返修→最终润色→最终包独立重读
8. 本人审核完整包→另行授权的外发与真实回读

## 1. GitHub · github

**岗位：软件发布与维护沟通编辑。研究状态：`official_rules_and_public_sample_grounded`。**

### 先读到的官方依据与边界

| 来源 | 取得时间 | 访问与证据 | 只支持的结论 |
|---|---|---|---|
| [About releases - GitHub Docs](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases) | 2026-10-25T09:31:55.966Z | body_extracted；B | Release 基于 Git tag，可包含发布说明和真实二进制资产；管理 release 需要仓库写权限。 |
| [About the repository README file - GitHub Docs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) | 2026-10-25T09:31:55.970Z | body_extracted；B | README 用于说明项目用途、价值、开始使用、帮助和维护者；为访客入口。 |
| [Best practices for community conversations on GitHub - GitHub Docs](https://docs.github.com/en/discussions/guides/best-practices-for-community-conversations-on-github) | 2026-10-25T09:46:12.241Z | body_extracted；B | Discussion 适合探索与反馈，Issue 适合具体待办/故障，PR 讨论拟议变更；先读 CONTRIBUTING。 |

### 平台研究：读者、形态、表达与规则

**受众要完成的事**：B：访客借 README 判断软件是否解决问题，并找到上手与支持入口；release 读者要定位可下载版本，维护者要把具体问题与开放讨论分开。D：本岗位优先服务准备安装、升级、复现或贡献的人，而不是把仓库当文章曝光位。

**发现机制与不确定性**：B：README 是仓库入口；tags/releases 标识版本，Discussions/Issues/PR 有不同上下文。D：先让仓库说明、版本和问题标题能被人读懂，再准备可选主题/描述建议；本研究不推断 Trending、star 或搜索排序权重。

**原生形式和具体容器**：B：README／文档 diff；绑定真实 tag 的 release 说明和真实资产；有明确分类与仓库语境的 Discussion；具体故障才用 Issue，拟议代码变更才用 PR。D：当前站内 GitHub Issue 适配器不能代替这四种发布。

**标题与开头策略**：D：README 首屏用“解决的任务＋最短真实使用结果”；release 标题沿实际项目命名与已存在 tag，不自造 vNext；Discussion 标题提出一个可回答的取舍，例如“在离线环境如何保留可验证的结果”。反例：没有版本却写“全新开源发布”，或把宣传标题当 bug。

**语气与作者角色**：D：具体、克制，先给用户能做什么，再讲实现选择；区分 supported、experimental、not tested。用项目实际维护者口吻，不冒称维护团队，不要求点赞、star 或给陌生仓库灌宣传 Issue。

**结构与论证**：D：README＝用途/边界→真实截图或最小样例→支持环境/前提→按当前仓库可核实的上手→验证结果→配置/失败处理→许可/贡献/支持。release＝实际版本和比较基线→用户可感知变化→不兼容项与迁移→修复→实测范围→资产/摘要→已知限制。Discussion＝现状→已试方法→具体问题。

**证据要求**：B：release 与 tag 对应。D：所有安装、迁移、性能和兼容性陈述要绑定 commit、日志、测试环境与文件；下载链接确有对应资产，许可与公开范围经本人审核；不能把私有仓库截图、CI 绿色或包 SHA 扩大成平台发布成功。

**社区与互动边界**：B：先读 CONTRIBUTING，再选 Discussion/Issue/PR。D：检索既有条目、给最小复现/预期/实际/版本；关联本人项目时披露关系；回复只处理对方问题，安全漏洞走项目规定的私密报告路径，具体外发另授权。

**反例/不应做的事**：

- 把任意品牌母版塞进 Issue，以 Issue URL 冒充软件 release
- 只有 README、无真实实现却宣称可安装软件；伪造 tag、下载、基准或维护状态
- 搬运别人的仓库/代码并改成自己的作品；隐藏许可证或去掉来源
- 把目录中的某工具存在当成已验证跨平台兼容；无关批量提及或求 star

### 实际公开样本观察（C，或明确未取得）

[GitHub CLI - Official README](https://raw.githubusercontent.com/cli/cli/HEAD/README.md)；取得 2026-10-25T09:37:22.826Z。C：实际 GitHub CLI README 先定义用途，再给文档、贡献、分系统安装和制品验证入口；体现“使用与维护”分工。这里只分析结构，不复述其版本号，不把一个官方大项目当成全平台样本或流量因果。

访问边界：raw README 实际正文。

### 平台专家如何工作（以下全部 D，未实施）

**职责**：让真实软件以准确版本、可用入口和维护上下文被理解；没有软件实物时交“不适合此原生形态”，不生成假发布。

**必须输入**：

- repoSnapshot:{owner,repo,visibility,commitSha,defaultBranch,license}，必须来自本次可核实仓库
- artifactKind:readme_diff|release|discussion|issue_repro；release 另需 tag、previousTag/基线与真实资产清单
- sourceChanges[]、actualRunReceipts[]、supportedEnvironments[]；没有运行证据时显式未验证
- authorRole、contributionRulesSnapshot、targetCategory/既有问题、公开事实与私密排除清单

**专家决策**：

1. 先判定作品/修订/讨论的正确容器；可读文章不等于软件发布
2. 把代码事实与用户行为变化对照，决定 README 还是 release；挑出迁移风险和已知限制
3. 按目标使用者重排上手路径，保留最小依赖与失败处理，不直接照搬母版叙事
4. 逐条绑定命令、结果和资产，决定哪些只能标未验证，哪些阻止发布
5. 独立检查最终 diff/正文/附件与目标；输出审核包，写仓库/建 release/发帖权限另行授予

**原生输出 schema**（准确字段设计，不是现有API已支持承诺）：

```json
{
  "discriminator": "nativeForm",
  "forms": {
    "readme_diff": {
      "required": [
        "repositoryUrl:https-url",
        "baseCommit:sha",
        "targetPaths:string[]",
        "unifiedDiff:utf8-file-ref",
        "renderedPreview:private-preview-ref",
        "examples:verified-example[]",
        "licenseReview:evidence-ref"
      ],
      "invariants": [
        "diff 必须能应用到精确基线，当前未应用",
        "引用文件与代码块有当前出处；公开范围由本人审核"
      ]
    },
    "release": {
      "required": [
        "repositoryUrl:https-url",
        "tag:string",
        "targetCommit:sha",
        "previousRef:string|null",
        "title:string",
        "releaseNotesMarkdown:string",
        "isPrerelease:boolean",
        "assets:verified-file[]",
        "verificationReceipts:evidence-ref[]",
        "knownLimitations:string[]"
      ],
      "invariants": [
        "tag/commit/资产均真实；无资产时如实为空",
        "不自动创建 tag、推送或发布；草稿/正式标志纳入审核"
      ]
    },
    "discussion": {
      "required": [
        "repositoryUrl:https-url",
        "categoryId:string",
        "title:string",
        "bodyMarkdown:string",
        "specificQuestion:string",
        "relatedThreads:https-url[]",
        "affiliationDisclosure:string|null"
      ],
      "invariants": [
        "分类与讨论权限需当次核实；发出的正文与包完全一致"
      ]
    }
  }
}
```

**工作流**：

1. 研究冻结/来源定位→仓库与作品资格检查
2. 差异与用户任务对照→选择容器
3. 提取可公开证据→写原生正文或精确 diff
4. 渲染预览/链接与命令静态核对→独立事实和资产审查
5. 有限返修→最终润色→重读最终文件与包哈希
6. 本人审核→授权的独立外发→实际 tag/commit/正文/资产回读

**Critic rubric**：

- `blocker`：没有真实仓库/作品/许可或精确版本；命令、结果、下载、tag 或作者身份虚构；私有数据/凭据进入公开 diff；最终包变化后沿用旧报告。
- `major`：没有迁移/支持环境/失败处理说明；把 Issue 与 release/Discussion 混用；正文变化与真实 diff 对不上。
- `minor`：重复说明、空泛口号、导航不清或代码块不可读。

**范围受控的记忆**：`accountId+repositoryId+nativeForm+locale`。

- 可保存：实际 README 风格、命名与 release 分组惯例；维护者已批准的贡献/支持路径与术语；真实的人类编辑理由与可验证失败案例。
- 不保存/不学习：令牌/私有代码内容跨仓共享；把旧 tag/支持版本当永久事实；将一仓贡献规则推广到所有仓。
- 更新：每次发版重新取 commit/tag/许可/贡献规则；风格每次从本人改稿形成候选，审核后新版本生效。

### 适配策略如何成为实际二次生产任务

同一份工程复盘，删除泛化品牌段落，改为真实软件差异、最短上手和升级决策；若只是在产品层谈想法，转 Discussion 草案或不投 GitHub，而不是造 release。

| 必需任务 | 当前可复用/实际缺口 | 证据与实现状态 |
|---|---|---|
| 冻结仓库与版本、实际运行证据与目标权限 | 只读 Git/当前仓库证据；本次未操作其他仓库 | D：拟议 repo-artifact adapter |
| 按真实改动制作 README diff/release notes，并渲染核对 | 当前 Edition/Variant 可承接正文；专用 diff/asset 包验证未实现 | A 文档现状＋D 扩展 |
| 可选真实演示截图/短片 | visualwrite.compose / subtitlewrite.sidecar 仅为 B 级工具目录映射，须工位发现接线；growth.video.post.quality 可核对媒体技术质量 | B 目录＋A 调用包装，不是现场产出证明 |

**需补能力**：

- 仓库 diff/README 渲染与链接验证适配器
- tag/commit/真实资产身份及权限校验、release/Discussion 精确发布与回读
- 代码包/二进制等非当前媒体类型的私有存储、预览、哈希审批和完整备份

**拟议验收**：

- 正常：真实仓库＋已验证 commit/tag/资产，生成与之相符 release 包；审核能逐项看全文、资产和迁移。
- 缺前提/错误：只有营销母版，没有仓库或 release 权限→skip/blocked；不得生成假 tag 或借现有 Issue 接口充数。
- 本次实际：研究/设计阶段，未执行。

## 2. Hugging Face · huggingface

**岗位：AI 作品可用性与复现编辑。研究状态：`official_rules_and_public_sample_grounded`。**

### 先读到的官方依据与边界

| 来源 | 取得时间 | 访问与证据 | 只支持的结论 |
|---|---|---|---|
| [Model Cards · Hugging Face](https://huggingface.co/docs/hub/model-cards) | 2026-10-25T09:31:55.970Z | body_excerpt；B | 模型卡为 README.md + YAML 元数据，说明用途、限制、训练与评测；元数据支持筛选和发现。 |
| [Dataset Cards · Hugging Face](https://huggingface.co/docs/hub/datasets-cards) | 2026-10-25T09:31:55.970Z | body_extracted；B | 数据集卡描述内容、许可、语言、偏差和来源；其标签、任务等元数据支持发现。 |
| [Spaces Overview · Hugging Face](https://huggingface.co/docs/hub/spaces-overview) | 2026-10-25T09:31:55.970Z | body_excerpt；B | Space 是承载实际应用代码的仓库；公开/受保护/私有的源码与应用可见范围不同，compute 创建有权益条件。 |
| [Spaces Configuration Reference · Hugging Face](https://huggingface.co/docs/hub/spaces-config-reference) | 2026-10-25T09:49:41.514Z | body_extracted；B | Space 配置放在根 README 的 YAML；title/sdk/app_file/models/datasets/tags 等有原生含义；suggested_hardware 不等于自动分配。 |

来源限制（`hf-model`）：Only fetched excerpt was read; not complete page.

来源限制（`hf-spaces`）：Only fetched excerpt was read; not complete page.

### 平台研究：读者、形态、表达与规则

**受众要完成的事**：B：模型/数据使用者借卡片理解任务、许可、限制和使用方式；Space 访客要体验实际应用。D：本岗位先回答“别人能拿这个做什么、需要什么、哪些结果已有证据”，再讨论传播。

**发现机制与不确定性**：B：模型/数据 YAML 的任务、语言、库、许可等支持 Hub 筛选；Space 有 title、short_description、models/datasets/tags 等元数据。D：据真实任务填可检索信息，不堆热门标签，不承诺首页推荐。

**原生形式和具体容器**：B：真实 model repo 的 model card、真实 dataset repo 的 dataset card、带应用代码和入口的 Space。D：另可准备技术文章，但技术文章不能记作模型或已部署 Demo；无实物时允许改选文章或 skip。

**标题与开头策略**：D：用真实作品名＋任务/约束说明使用价值；Space 开场给一份可实际提交的安全输入和可观察输出，模型卡首段讲模型身份/基座/任务。避免“我训练了”掩盖仅调用第三方模型，或把无评测产品叫 SOTA。

**语气与作者角色**：D：作者角色准确；模型提供者、微调者、量化者、应用编排者分别说明；能力和限制并列，英语说明优先让开发者能复现，中文补充不改变含义。

**结构与论证**：D：model card＝模型身份/任务→已完成来源/训练或转换过程→可执行用法→实际评测条件/结果→限制/偏差→许可/引用；dataset card＝来源/收集权利→字段/划分→使用→隐私/偏差→更新；Space＝任务→示例/输入限制→依赖/入口→硬件与状态→输出/失败→模型来源/费用/隐私边界。

**证据要求**：B：卡片元数据和 Space 实际应用可见性各有原生语义；建议硬件字段不会自动分配资源。D：模型文件/数据/入口脚本需实际存在并有版本/摘要；评测、训练、免费算力或实时可用不能由文案推断。

**社区与互动边界**：D：读取作品对应讨论，围绕可复现输入/输出、版本和已试方法答疑；明确应用与底座作者关系。反馈中删去个人数据/秘密；任何推理、构建、升级硬件或外发另按实际预算和授权。

**反例/不应做的事**：

- 没有权重却交“新模型”，没有数据却交数据集
- 把第三方能力或模型作者评测写成本人训练/测评
- 将保护源码的 Space 当成应用也私有；把 SDK/config 写好当已经构建成功
- 在 README/公开输入样例嵌密钥、真实客户信息；承诺永久免费 GPU

### 实际公开样本观察（C，或明确未取得）

[(no title)](https://huggingface.co/Qwen/Qwen3-4B/raw/main/README.md)；取得 2026-10-25T09:41:58.377Z。C：Qwen3-4B 实际卡片从任务/身份、基座和许可进入概览、Quickstart、使用模式及注意事项；可见模型说明和用法是同一个真实仓库的两面。只分析卡片结构，未运行模型或复核其数值评测。

访问边界：raw README 节选；页面提取会损伤部分代码符号，不能据此复制执行命令。

### 平台专家如何工作（以下全部 D，未实施）

**职责**：把真实 AI 作品做成可发现、可理解、可验证使用的原生包；每种实物有各自前提与失败状态。

**必须输入**：

- artifactType:model|dataset|space|technical_article；实际 repoId/revision 与作者角色
- modelFiles/dataFiles/appFiles:verified-file[]；来源/基座/许可/个人信息审核
- evaluationReceipts[]：环境、输入、版本、指标口径、真实输出；未做则为空并标明
- Space 的当前 SDK/构建和硬件权益、可见范围、隐私/费用与本次运行预算；不能默认拥有

**专家决策**：

1. 先判别模型、数据、应用还是文章，缺实物不填假卡片
2. 决定用户任务、输入输出与最短安全用法，技术母版只作为证据来源
3. 把已知训练/评测与未知项分开；根据实际 artifact 填元数据和限定词
4. 选择 Space 的可见性、依赖和最小资源建议，权益/费用未知则阻塞构建
5. 用当前产物和示例证据完成独立检查，再允许本人审核文件与设置

**原生输出 schema**（准确字段设计，不是现有API已支持承诺）：

```json
{
  "discriminator": "nativeForm",
  "forms": {
    "model_card": {
      "required": [
        "repoId:string",
        "revision:string",
        "modelFiles:verified-file[]",
        "cardMarkdown:string",
        "metadata:typed-yaml-fields",
        "baseModel:string|null",
        "licenseEvidence:evidence-ref",
        "intendedUses:string[]",
        "limitations:string[]",
        "evaluationEvidence:evidence-ref[]"
      ],
      "invariants": [
        "没有 modelFiles 则不能冒充模型发布",
        "未知训练/评测标未提供，不补造结果"
      ]
    },
    "dataset_card": {
      "required": [
        "repoId:string",
        "revision:string",
        "dataFiles:verified-file[]",
        "cardMarkdown:string",
        "dataDictionary:field[]",
        "sourceAndLicense:evidence-ref[]",
        "splits:verified-split[]",
        "privacyReview:evidence-ref"
      ],
      "invariants": [
        "来源/再发布权利与实际文件一致；合成/抽样如实披露"
      ]
    },
    "space_demo": {
      "required": [
        "repoId:string",
        "codeRevision:string",
        "sdk:string",
        "appEntry:verified-file",
        "dependencyFiles:verified-file[]",
        "exampleInputs:safe-example[]",
        "actualOutputEvidence:evidence-ref[]",
        "visibility:public|protected|private",
        "hardwareAndPlan:reviewed-config",
        "runStatus:unrun|failed|verified"
      ],
      "invariants": [
        "不把 unrun/构建成功当示例推理通过",
        "费用/权限/源码与应用公开范围进入审核"
      ]
    }
  }
}
```

**工作流**：

1. 作品/权利/作者角色检查→目标用户与原生类型选择
2. 真实文件盘点→版本、使用与复现证据冻结
3. 编写卡片或应用说明→选择示例/元数据/可见范围
4. 有授权才产生实际复现/构建工单，缺环境保持 blocked
5. 独立复核结果与许可→最终润色→最终包重检
6. 本人核对完整文件/设置→单次发布授权→实际页面/文件/示例回读

**Critic rubric**：

- `blocker`：假模型、假数据、假训练或虚构评测；缺权利/私密输入外泄；Space 计划/费用/权限不明却发起付费构建；实际应用与公开范围错配。
- `major`：缺可执行输入与输出解释；依赖/版本/限制未说明；metadata 与实际模型任务或作者角色冲突。
- `minor`：卡片冗余宣传、术语不一致、示例说明不清。

**范围受控的记忆**：`accountId+repoType+repoId+revisionFamily+locale`。

- 可保存：经本人确认的作品角色、卡片风格、示例偏好；实际失败输入与使用限制（去敏）；当次规则与权益核验引用，带失效日期。
- 不保存/不学习：训练/评测数字自动滚成永久事实；Hub token 或用户原始输入；不同模型许可/组织权益串用。
- 更新：每次 revision/SDK/许可/可见范围/运行权益改变重核；易变资源资格在任务启动和发布前核实。

### 适配策略如何成为实际二次生产任务

工程复盘改成“可操作 AI 演示＋来源清晰卡片”的证据链；现有私有控制台不能整体上传公开 Space，需另立可公开、无私密 API 的真实 Demo。没有这些前提只交文章候选或不投。

| 必需任务 | 当前可复用/实际缺口 | 证据与实现状态 |
|---|---|---|
| 核对真实模型/数据/应用文件与版本，选择卡片模板 | 当前 Edition/Variant 只承接可审核正文；artifact card 工单为拟议 | A 文档＋D 新工具 |
| 产生安全演示媒体、截图或字幕 | B 目录 visualwrite.compose / subtitlewrite.sidecar；当前媒体上传可接 PNG/JPEG/WebP/MP4/VTT，仍要实际字节与权利审核 | A 文档＋B 目录 |
| 验证实际推理/数据读取/Space 构建 | 视频工具不能代替模型/数据/Space sandbox；需新增隔离执行及预算/权限证据 | D 缺失 |

**需补能力**：

- 模型/数据/Space 类型的 artifact 验证、许可/权利与 repo revision 绑定
- Hub 元数据/配置与卡片专用 lint、真实示例复现 sandbox 和失败账本
- 源代码/数据大文件的私有存储/安全预览/完整备份及部署回读；Hub 官方接口授权单独接

**拟议验收**：

- 正常：实际授权 Demo 源码与可复现安全示例，卡片/文件/可见范围齐全且实跑回执一致。
- 缺前提/错误：只有 AI 产品文章却选择 model_card→ARTIFACT_MISSING；Space 权益未知→blocked，不承诺免费资源。
- 本次实际：研究/设计阶段，未运行模型或创建 Space。

## 3. ModelScope 魔搭 · modelscope

**岗位：中文 AI 作品落地与复现编辑。研究状态：`rules_and_artifact_grounded_dynamic_docs_limited`。**

### 先读到的官方依据与边界

| 来源 | 取得时间 | 访问与证据 | 只支持的结论 |
|---|---|---|---|
| [ModelScope Library - Official README](https://raw.githubusercontent.com/modelscope/modelscope/master/README.md) | 2026-10-25T09:37:22.831Z | body_excerpt；B | ModelScope 官方 SDK 连接模型/数据集仓库与推理、训练、评估；不证明本人的算力、作品或托管资格。 |
| [玩转 ModelScope 模型和数据集](https://www.modelscope.cn/learn/7279) | 2026-10-25 | indexed_body_only；B | 官方站内教程的索引正文说明仓库类型、卡片 YAML + Markdown、上传和来源等基本工作流；动态页正文未取得。 |

来源限制（`modelscope-sdk`）：Only fetched excerpt was read; not complete page.

来源限制（`modelscope-learn-index`）：Search result contains model-card/upload workflow; direct page body was unavailable. Exact current UI and account privileges remain unverified.

### 平台研究：读者、形态、表达与规则

**受众要完成的事**：B：官方 SDK 围绕模型、数据及推理/训练/评估；站内指南索引强调模型卡和实际分享。D：读者需要清楚中文任务描述、能到达的作品文件与本地/在线使用路径，角色不是简单把 HF 卡片翻成中文。

**发现机制与不确定性**：B：站内指南的索引正文提到模型种类、任务/框架/许可等信息；实际模型卡具有任务/基座等字段。D：用真实任务、适用场景和依赖构成发现入口；官方动态页面未完整取得，不据此许诺推荐、流量或固定资源权益。

**原生形式和具体容器**：B：真实模型/数据集仓库与卡片；官方 SDK 支持相关仓库交互。D：创空间应用作为有入口和依赖的实际 Demo，或单独技术文章；SDK/当前平台模板和资格需当次复核，不能照抄旧教程配置。

**标题与开头策略**：D：标题用作品真名＋中文可完成的任务；开头说明输入、能看到什么输出、依赖和边界。例如“用已有模型核对一份公开样例的结构化结果”是应用，不升级称“自研大模型”。

**语气与作者角色**：D：面向中文实践者，先解释首次出现的任务/术语，再给可以追踪的使用过程；明确模型原作者与应用作者，运行前提和失败条件不藏在尾注，不把海外模型镜像当本人研发。

**结构与论证**：D：问题/使用者→真实作品类型与关联模型→输入输出示例→使用路线/文件结构→环境与依赖/资源约束→实际结果与失败→来源/许可/数据处理→更新与反馈。模型/数据卡分别保留训练、字段、划分和评估的证据，不用故事稿填满技术栏。

**证据要求**：B：取得 Qwen 模型仓库真实 README；ModelScope 动态文档本体仅标题，部分指南来自官方站内索引。D：据真实文件验证 revision、框架、模型/数据来源和许可；中文用法须独立复现后才能称可运行，旧版教程不作为当前命令证明。

**社区与互动边界**：D：围绕具体模型 revision、输入、环境和报错准备支持上下文；提问先查相关文档/已有讨论；不承诺算力福利。技术文章和研究分享保留来源，不将别人的模型指标变成本人生产结果。

**反例/不应做的事**：

- HF YAML 不经核实整份当魔搭原生配置；旧创空间教程当当前 UI/SDK 合同
- 镜像/应用包装写成自研模型；虚构上传、评测或上线
- 没有模型/数据/入口脚本时交卡片当作品完成
- 以截图或说明文代替真实 Demo；把缓存目录/运行成功截图当权利和可复现证明

### 实际公开样本观察（C，或明确未取得）

[(no title)](https://modelscope.cn/api/v1/models/Qwen/Qwen3-4B/repo?Revision=master&FilePath=README.md)；取得 2026-10-25T09:37:22.831Z。C：魔搭上的 Qwen3-4B 原生模型仓库确有可读 README，含身份/许可/任务/基座、概览和用法。它与 HF 的内容相近，说明镜像资料可能复用；不足以推断魔搭所有稿件应有同一种中文语气或模板。

访问边界：模型仓库公开 README 端点节选；未下载权重或运行。

### 平台专家如何工作（以下全部 D，未实施）

**职责**：将真实 AI 作品转为适合中文使用者的使用、复现与反馈包，并保留作品来源和平台资格边界。

**必须输入**：

- artifactType:model|dataset|studio|technical_article；ModelScope 真实 namespace/repo/revision
- 模型/数据/应用实际文件及来源/许可；框架、操作系统、硬件和依赖
- 可公开的输入/输出、中文术语表、真实复现日志
- 当前官方模板/上传与创空间资格；动态正文缺失时保存未核实项，不填‘已支持’

**专家决策**：

1. 先选实际作品类型，判定资料能否支撑中文使用/复现，而非为了渠道补造模型
2. 决定中文上手路线：在线 Demo 与本地使用分开写，并暴露缺环境或权限
3. 校对来源、许可、基座、任务和真实评测；不把同卡片两站托管当两次独立评测
4. 对照当前目标模板产生文件/配置需求，未核实字段留阻塞项
5. 独立重读卡片和实际产物，再把可执行发布交给具体授权与真实回读

**原生输出 schema**（准确字段设计，不是现有API已支持承诺）：

```json
{
  "discriminator": "nativeForm",
  "forms": {
    "model_card": {
      "required": [
        "repoId:string",
        "revision:string",
        "modelFiles:verified-file[]",
        "readmeMarkdown:string",
        "validatedMetadata:typed-fields",
        "upstreamAttribution:evidence-ref[]",
        "usageExamples:safe-example[]",
        "runEvidence:evidence-ref[]",
        "limitations:string[]"
      ],
      "invariants": [
        "训练/评测未知必须明示；revision 与文件一致"
      ]
    },
    "dataset": {
      "required": [
        "repoId:string",
        "revision:string",
        "dataFiles:verified-file[]",
        "dataDictionary:field[]",
        "sourceLicensePrivacy:evidence-ref[]",
        "readmeMarkdown:string"
      ],
      "invariants": [
        "不能仅有数据说明而无实际可分享数据"
      ]
    },
    "studio": {
      "required": [
        "spaceId:string",
        "appEntry:verified-file",
        "dependencies:verified-file[]",
        "modelRefs:versioned-ref[]",
        "currentTemplateEvidence:evidence-ref",
        "exampleInput:safe-example",
        "exampleOutputEvidence:evidence-ref|null",
        "resourceEntitlement:reviewed-config",
        "runStatus:unrun|failed|verified"
      ],
      "invariants": [
        "当前模板/权限未核实或示例未运行不能称已上线",
        "真实托管与本文说明分开核验"
      ]
    }
  }
}
```

**工作流**：

1. 中文读者任务调研→实物/权利资格判定
2. 当前目标模板核对→安全输入与实际文件冻结
3. 按使用路线重编说明与示例→形成平台配置候选
4. 独立复现工单/已有真实证据核查→卡片、数据与许可审查
5. 最终润色→准确包重检→本人审阅→另行授权发布与回读

**Critic rubric**：

- `blocker`：无实物、无再发布权利或伪造国产/自研身份；未验证原生模板却自动部署；虚构评测、算力额度、运行成功；公开样例含真实秘密/客户数据。
- `major`：中文说明和实际 API/文件矛盾；入口或依赖缺失；关键失败路径不写；未区分镜像、原模型、微调和应用。
- `minor`：术语杂乱、中文直译腔、上手顺序不清。

**范围受控的记忆**：`accountId+artifactKind+repoId+locale`。

- 可保存：本人核准的中文术语、使用场景与具体文件组织；带日期/来源的当前平台规则与实际失败记录；该作品的来源关系，作为指向事实账本的引用。
- 不保存/不学习：token/权重或客户数据复制入文字记忆；将一份模型许可通用化；将站内推广数字或历史资源福利当默认权益。
- 更新：每次作品 revision、平台模板/SDK 或资源条件变化先更新规则候选再审；旧卡片不自动覆盖新作品。

### 适配策略如何成为实际二次生产任务

母版中的工程目标转成中文任务和使用路径，必要时提出真实 Studio 生产工单；没有可公开 Demo 代码或模型/数据时，保持技术文章或 skip。原素材跨平台复用要保留各站文件版本，不将一次运行伪造两站上线。

| 必需任务 | 当前可复用/实际缺口 | 证据与实现状态 |
|---|---|---|
| 判型、中文资料和当前目标模板研究 | 当前平台目录仅登记，自动发布为 false；本岗位扩展为 D 设计 | B 目录＋D 设计 |
| 编排真实 Demo 图片/操作片段/字幕 | 可条件复用 visualwrite.compose、subtitlewrite.sidecar 的本机工位；目录仅声明且依赖 unchecked | B 元数据，未证明当前执行 |
| 安装/推理/数据读取/Studio 实测 | 需要新 artifact sandbox；视频 post.quality 只能验媒体，不证明模型预测或数据集正确 | A 调用边界＋D 缺失 |

**需补能力**：

- 魔搭模型/数据/Studio 的元数据/模板验证与当前官方接口调研
- 源文件、权重/数据和依赖证明的安全私有 artifact 管理
- 实际 CPU/GPU/SDK 复现与费用闸、平台构建/可见性/结果回读

**拟议验收**：

- 正常：真实授权模型或 Demo，中文路线与实际 revision/依赖/运行证据相符，审阅者能找到真实文件与限制。
- 缺前提/错误：只有模型宣传材料、无文件或当前模板/资格未知→blocked/skip，不用旧配置伪装成功。
- 本次实际：研究/设计阶段，未访问登录态、下载权重或实跑。

## 4. DEV Community · devto

**岗位：开发者技术解释与复现实证编辑。研究状态：`official_rules_and_public_sample_grounded`。**

### 先读到的官方依据与边界

| 来源 | 取得时间 | 访问与证据 | 只支持的结论 |
|---|---|---|---|
| [Editor Guide - DEV Community](https://dev.to/p/editor_guide) | 2026-10-25T09:31:55.970Z | body_extracted；B | 原生 Markdown、front matter、最多4标签、canonical_url、图片 alt/标题层级；草稿链接公开但隐蔽。 |
| [Code of Conduct - DEV Community](https://dev.to/code-of-conduct) | 2026-10-25T09:31:55.970Z | body_extracted；B | 要求来源、尊重、隐私与 AI 使用披露；不能以隐私泄露或抄袭换互动。 |
| [Guidelines for AI-assisted Articles on DEV - DEV Community](https://dev.to/guidelines-for-ai-assisted-articles-on-dev/) | 2026-10-25T09:46:12.237Z | body_extracted；B | AI 稿需可负责/披露/核实；现有正文限制 AI 品牌推广与 AI 评论，仅允许评论基础翻译/语法等例外。 |
| [Introducing AI Disclosure on DEV: Tools for Nuance, Clarity, and Better Feeds - DEV Community](https://dev.to/devteam/introducing-ai-disclosure-on-dev-tools-for-nuance-clarity-and-better-feeds-34mk/) | 2026-10-25T09:44:47.893Z | body_excerpt；B | 官方新公告提供 Hand Written、AI-Assisted、Fully Autonomous 三档披露；并未明确撤销 canonical 指南其他限制。 |
| [Writing, Editing and Scheduling - DEV Help - DEV Community](https://dev.to/help/writing-editing-scheduling) | 2026-10-25T09:46:12.241Z | body_extracted；B | 当前帮助页说明跨发/原文 URL/系列/草稿编辑工作流并链接 AI 指南；不据其营销描述承诺搜索排名。 |

来源限制（`dev-disclose`）：Only fetched excerpt was read; not complete page.

### 平台研究：读者、形态、表达与规则

**受众要完成的事**：B：官方写作示例围绕开发、学习、工具文档与经验交流，并强调清晰 takeaway。D：本岗位服务正在解决一个开发问题或学习一个实际做法的读者；只有品牌曝光或 SEO 导流诉求的 AI 母版不应强发。

**发现机制与不确定性**：B：原生标签有主题/社区上下文，文章可关联系列与 canonical；官方有新 AI 披露选择。D：先读相关 tag 页，选与正文真正相符的标签和英语术语；不宣称标签数量、发布时间或阅读时长能保证流量。

**原生形式和具体容器**：B：Markdown 技术文章，支持 front matter、代码、图片 alt、合法嵌入、series/canonical。D：故障复盘、实作教程、变更解释各有不同叙事；当前 AI 评论限制不因支持文章而解除。

**标题与开头策略**：D：标题＝具体问题/场景＋可验证的方法或取舍；开头给发生的问题、读者前提和最后能理解/复现的事。示例方向“Why one bootstrap loaded two npm configs—and how the fix was verified”只在真实公开证据获准时使用；不编写“我刚测出十倍性能”。

**语气与作者角色**：D：英语直白、有同侪感；先解释为什么，再展示代码和失败路径；第一人称仅来自作者真实经历和理解。保留原作者声音，明确 AI 辅助，不用机器伪造“我工作多年学到的”。

**结构与论证**：D：读者问题→环境/版本与适用前提→最小可复现例→机制或方案比较→实际改动→验证/失败与限制→一个清晰 takeaway 和来源；篇幅大时按真实子问题拆系列，而非人为凑连续帖子。

**证据要求**：B：草稿 URL 可被持链接者访问，不能作为私有存储。D：代码、数字、截图和亲历叙述分别绑定真实证据，新增知识不能替作者假装已理解；canonical 指向真实同主题首发，不能填无关首页或猜测未来 URL。

**社区与互动边界**：B：canonical AI 指南仍写明评论仅可用 AI 做基础翻译/语法等；新披露公告未明确撤销该限制。D：岗位可以做评论上下文研究、风险标注和对本人原文的限定校对，不生成可直接发送的 AI 回复；争议不靠自动留言提升参与。

**反例/不应做的事**：

- AI 批量百科式教程、作者并不理解的教育内容
- 用 AI 稿主要做个人品牌、商业/课程推广或 SEO 链接建设
- 披露标签当绕过质量/评论限制的通行证；用旧/新官方文冲突自行放宽权限
- 将公开但隐蔽的草稿链接当私密；无 alt 图片、代码输出伪造、无关 tag

### 实际公开样本观察（C，或明确未取得）

[Best Practices for Writing on DEV: Topics - DEV Community](https://dev.to/devteam/best-practices-for-writing-on-dev-topics-1d0j)；取得 2026-10-25T09:41:58.377Z。C：官方 Topics 样本先交代开发社区语境，随后用标签、实际选题例子、独特经历和 takeaway 分节，并关联既有系列。可借其解释结构，不能把一个官方帖的风格或互动当平台算法结论。

访问边界：官方公开文章主体实际读取；评论只抽到部分，不分析总体互动。

### 平台专家如何工作（以下全部 D，未实施）

**职责**：把作者真正理解、有公开证据的工程经验写成有独特解释和复现价值的英文文章；纯宣传型 AI 母版准确拒投。

**必须输入**：

- sourceEdition 与 approvedFacts；authorUnderstandsTopic:true 需本人确认，不由模型自签
- 实际代码/版本/验证日志、作者亲历边界、公开图片与许可
- 目标账号/组织、相关 tag 页、真实 canonical/系列关系与平台当前 AI 规则
- aiContributionDeclaration、本人原评论（只有请求基础翻译/语法时提供）

**专家决策**：

1. 先判定是学习/实作价值还是品牌/SEO主导，后者 skip；检查 AI 规范冲突
2. 挑一个可解释的开发任务与独特证据，删掉通稿导流段
3. 选择教程、故障或变更解释结构，确保读者前提、代码、验证与限制完整
4. 核对 tag/series/canonical/图片可访问性与 AI 披露；不外传私密草稿
5. 最终文稿与规则检查交给独立上下文，本人批准后单次发布；评论能力限定为允许的原文校对

**原生输出 schema**（准确字段设计，不是现有API已支持承诺）：

```json
{
  "discriminator": "nativeForm",
  "forms": {
    "technical_article": {
      "required": [
        "title:string",
        "description:string",
        "bodyMarkdown:string",
        "tags:relevant-tag[0..4]",
        "canonicalUrl:https-url|null",
        "series:string|null",
        "cover:verified-image|null",
        "imageAltTexts:asset-alt[]",
        "codeEvidence:evidence-ref[]",
        "aiDisclosure:reviewed-tier",
        "authorUnderstandingEvidence:evidence-ref",
        "contentPurpose:technical_learning"
      ],
      "invariants": [
        "输出初态 draft，不自动 published:true",
        "每个代码/结果/第一人称陈述有证据",
        "不能以纯品牌/商业/SEO导流目的绕 AI 指南；规则矛盾则阻塞受影响行为"
      ]
    },
    "human_comment_copyedit": {
      "required": [
        "originalHumanText:string",
        "permittedEditType:translation|spelling_grammar|accessibility",
        "editedText:string",
        "changeLog:string[]",
        "semanticAddition:false"
      ],
      "invariants": [
        "不增加论点、经历、推荐或新的回答；无本人原文不能生成评论"
      ]
    }
  }
}
```

**工作流**：

1. 当次官方规则与 tag 语境→投稿资格/目的判断
2. 作者理解与事实冻结→选择开发问题和文章结构
3. 重写英文说明/代码与证据编排→Markdown/alt/canonical 检查
4. 独立事实核验→有限返修→最终润色与最终包重读
5. 本人审核全文/AI披露→独立外发授权→实际正文/设置回读；评论仅原文校对例外

**Critic rubric**：

- `blocker`：纯 AI 品牌推广/SEO 引流目的；AI 生成评论或伪造 firsthand/代码运行；私密信息送进平台草稿 URL；未处理规则冲突却扩大自动化。
- `major`：没有真实独特内容或可用解释；canonical/tag/series 错误；代码块、来源、alt 或 AI 披露不完整。
- `minor`：翻译腔、长铺垫、缺清晰 takeaway。

**范围受控的记忆**：`accountId+organizationId?+tagContext+locale+articleType`。

- 可保存：本人核准的英语口吻、技术术语和读者前提；作者明确理解的领域边界，引用事实账本而非自我扩展；合规编辑理由、具体 tag 规范与禁止使用的虚假经历句式。
- 不保存/不学习：把 AI 检查器分数当真实性证据；从点赞自动学习诱导话术；永久存入公开但隐蔽的草稿链接或跨账号资料。
- 更新：每次发布核当前 AI 指南/披露和目的；官方新旧冲突留规则版本与差异，人工核定前沿较窄行为边界。

### 适配策略如何成为实际二次生产任务

同一工程母版改为读者能复现的问题、代码与解释，补英文背景，删无关品牌推广；保留作者真实限定，并输出正确 AI 披露。不能将“最终润色”当取消披露的理由。

| 必需任务 | 当前可复用/实际缺口 | 证据与实现状态 |
|---|---|---|
| 技术文稿、代码证据与母版事实映射 | Edition/Variant 正文和 blocks 可承接；专门 worker 和 DEV 规则检查为拟议 | A 文档＋D 扩展 |
| 必要的原创图解/实际截图 | visualwrite.compose 为 B 目录候选；需实际渲染与 PNG/JPEG 字节/alt 审查 | B 目录，非已接通 |
| DEV Markdown、嵌入、canonical、披露与人工原文校对验证 | 无当前专用 DEV adapter；本次只设计 export 包 | D 缺失 |

**需补能力**：

- DEV 目的/AI披露与评论例外策略检查器
- Markdown/嵌入/链接/alt 的平台预览；代码复现证据引用
- 原生 typed 字段纳入包哈希/终检；未来官方接口资格与实际回读适配

**拟议验收**：

- 正常：有真实公开代码与实测、作者理解并确认的技术复盘，形成英文原生稿、相关标签、正确原文关系及披露。
- 缺前提/错误：同一母版仅为品牌引流，或要求 AI 从零回评论→skip/blocked；不靠标签和改语气过关。
- 本次实际：研究/设计阶段，未创建 DEV 草稿或评论。

## 5. Hashnode · hashnode

**岗位：持续开发博客与系列编辑。研究状态：`official_rules_and_public_sample_grounded`。**

### 先读到的官方依据与边界

| 来源 | 取得时间 | 访问与证据 | 只支持的结论 |
|---|---|---|---|
| [Hashnode CLI: publish and manage your blog from the terminal](https://hashnode.com/blog/hashnode-cli) | 2026-10-25T09:34:56.373Z | body_extracted；B | 官方 CLI 区分 draft 与直接发布、正文原样发送不解析 frontmatter；API 读写需出版物具 Pro 条件。 |
| [Publish to Hashnode - Official GitHub Action README](https://raw.githubusercontent.com/Hashnode/publish-github-action/main/README.md) | 2026-10-25T09:37:22.831Z | body_extracted；B | 官方 GitHub Action 支持另一套 frontmatter、稳定 slug、canonical/系列/封面和独立更新行为；不能与 CLI 混为同一合同。 |

### 平台研究：读者、形态、表达与规则

**受众要完成的事**：B：当前官方出版物本身以具体开发任务和明确步骤组织文章；CLI/Action 区分博客、稿件与系列等对象。D：本岗位面向愿意读完整开发过程、返回查阅或继续系列的读者，不把长文等同于更长的通稿。

**发现机制与不确定性**：B：现行官方工具承接 title、tag、series、canonical、SEO/分享字段；这些是可整理的原生信息。D：先让标题、摘要和系列关系如实表达内容；没有证据承诺搜索排名或把跨发 canonical 当必然增流。

**原生形式和具体容器**：B：博客文章与 draft；CLI 发送正文原文不读 frontmatter，GitHub Action 读自己的 frontmatter。D：按目标接口 profile 交付一份准确的正文＋typed 设置，不直接把 DEV front matter 当 Hashnode 通用格式。

**标题与开头策略**：D：以具体开发任务、问题与适用对象开篇；副标题补足范围，例如“从哪一步到哪一步、有哪些限制”。系列标题体现递进问题，每篇都要单独有用；不写无实际代码的‘完整指南’。

**语气与作者角色**：D：工程经验叙事保持连贯，先给能看见的结果和背景，解释取舍与失败；英语自然、名词稳定。本人未经历的内容不用 I/we 虚构，引用外部工作明确归属。

**结构与论证**：D：任务与输出→上下文/前提→实现步骤与关键解释→验证/边界→故障与取舍→相关系列/来源。大文章按真实问题拆成系列，代码和截图围绕论证，不用无关插图填版。

**证据要求**：B：当前官方 CLI 说明 API 读写关联 Pro 资格，post create 与 draft 有不同副作用；Action 以 slug 处理更新。D：实际 publication/author 权限、接口版本、canonical 与现有 slug 都需核实，不把可安装 CLI 当账号已接通。

**社区与互动边界**：D：围绕文章具体步骤、代码与边界互动；回答需真实上下文与适用规则，批评针对方法。团队博客署名与贡献角色要明确；不自动评论拉流量，不用删除重发掩盖修订。

**反例/不应做的事**：

- 同一 Markdown 给 DEV/Hashnode 原样复用，元数据界面与 API 合同混淆
- CLI 以为 frontmatter会解析，或把直接发布当草稿
- 重复创建草稿、slug 漂移导致覆盖/重复文章；虚构 canonical
- 默认有 Pro、团队发布权或买套餐；用长文篇幅掩盖无实质内容

### 实际公开样本观察（C，或明确未取得）

[Hashnode CLI: publish and manage your blog from the terminal](https://hashnode.com/blog/hashnode-cli)；取得 2026-10-25T09:34:56.373Z。C：实际官方 CLI 文章有具体任务副标题、前提、步骤、代码、发布前注意事项和 FAQ；它本身呈现一个可扫读的技术博客结构。只抽看该篇，不把官方产品文风推广为全站偏好。

访问边界：官方公开文章实际正文；样例命令未执行。

### 平台专家如何工作（以下全部 D，未实施）

**职责**：把真实开发实践写成有连续阅读价值的博客或系列，精确管理原文、目标 publication 与修订，不自动获得发布权限。

**必须输入**：

- publicationSnapshot:{id,host,ownerOrContributor,eligibilityCheckedAt}
- interfaceProfile:browser_export|official_cli|github_action 与版本/能力依据
- 真实母版、代码/图像/验证证据、系列/已有 slug/原文关系
- 完整正文、SEO摘要和作者风格；费用/秘密只在专用运行环境，不入包

**专家决策**：

1. 先判个人/团队 publication 与原文/转载关系，再决定单文还是系列
2. 根据读者任务删改背景，展开真实实现与取舍，给每篇独立 takeaway
3. 选择标题/副标题/代码图像/系列连接，保持稳定 slug
4. 按接口 profile 输出元数据，明确 draft 与 publish，资格未知则只导出
5. 独立检查正文与原生设置，避免更新错稿；最终再润色并重检

**原生输出 schema**（准确字段设计，不是现有API已支持承诺）：

```json
{
  "discriminator": "nativeForm",
  "forms": {
    "technical_article": {
      "required": [
        "publicationId:string",
        "publicationHost:hostname",
        "interfaceProfile:browser_export|official_cli|github_action",
        "title:string",
        "subtitle:string|null",
        "bodyMarkdown:string",
        "slug:string",
        "tags:string[]",
        "seriesId:string|null",
        "canonicalUrl:https-url|null",
        "cover:verified-image|null",
        "seo:{title,description,ogImage?}",
        "desiredState:draft",
        "authorSnapshot:identity",
        "updateTarget:{postId,version}|null"
      ],
      "invariants": [
        "接口 profile 决定导出格式，不能混用 frontmatter",
        "postId/slug 更新必须对应真实旧稿；未确定结果先查而非重发",
        "若计划用 API，当前 Pro/角色核验不能缺失"
      ]
    }
  }
}
```

**工作流**：

1. publication/角色/接口资格核对→真实原文/slug/系列检查
2. 选读者任务→完整英文改编与代码图像编排
3. 按 profile 生成 payload→私有预览正文及原生设置
4. 独立来源/事实/slug/canonical/图片检查→最终润色→终检
5. 本人批准→具体执行授权→actual postId/URL/正文/元数据回读，未知结果先调和

**Critic rubric**：

- `blocker`：串 publication/作者/更新目标；误将直接 post create 当草稿，或未经允许付费/外发；元数据/最终正文不受同一审批哈希约束；造经历/运行结果/原文关系。
- `major`：缺正文独立价值、案例细节或失败路径；CLI/Action/browser 导出合同混用；系列断裂、canonical/slug 错误。
- `minor`：长铺垫、重复 CTA、英语术语/图片说明不统一。

**范围受控的记忆**：`accountId+publicationId+locale+seriesId?`。

- 可保存：本人批准的副标题、博客口吻和术语；稳定 slug/系列关联只作带版本引用；接口 profile 与已核账号资格的当次记录。
- 不保存/不学习：PAT、付费状态永久假设；把草稿链接当秘密资料库；一个团队的权限与作者身份复用到另一博客。
- 更新：接口/套餐/角色改变、文章更新前重核；风格候选从人类改稿提升，不自动改写原文和 canonical。

### 适配策略如何成为实际二次生产任务

同母版在 Hashnode 可展开真实工程决策和系列上下文，配独立副标题、代码解释、原文关系与稳定 slug；本次输出导出稿，不安装 CLI 或创建外部草稿。

| 必需任务 | 当前可复用/实际缺口 | 证据与实现状态 |
|---|---|---|
| 文章/系列/原文关系与独立改写 | 现有 Edition/Variant 可保存正文，特殊字段未来要进 NativePackage | A 文档＋D 新合同 |
| 原创解释图与必要实际演示 | visualwrite.compose 为 B 目录候选；媒体权利与实际字节审核沿现有媒体流程 | B 目录＋A 文档 |
| Hashnode payload/profile lint 与 preview/readback | 无当前 Hashnode 适配器；官方 CLI/Action 存在不表示已集成 | D 缺失 |

**需补能力**：

- Hashnode 的接口 profile/Pro/作者角色与草稿/修订语义检查
- 系列/slug/canonical/SEO typed字段快照、预览和比对
- 有明确授权时的官方 draft/发布/更新与未知结果调和，不让第三方 Action 绕过审批

**拟议验收**：

- 正常：实际 publication、完整文章和真实系列/原文关系，按选定 interface profile 输出能逐项审阅的 draft 包。
- 缺前提/错误：无 Pro/权限证据却要求 API 自动发，或同 slug 已有不相关稿→blocked；可保留安全导出。
- 本次实际：研究/设计阶段，未安装工具、付费、登录或外发。

## 6. Kaggle · kaggle

**岗位：可复现数据科学作品与实验编辑。研究状态：`rules_grounded_sample_partially_accessible`。**

### 先读到的官方依据与边界

| 来源 | 取得时间 | 访问与证据 | 只支持的结论 |
|---|---|---|---|
| [Kaggle CLI - Official README](https://raw.githubusercontent.com/Kaggle/kaggle-api/main/README.md) | 2026-10-25T09:37:22.831Z | body_extracted；B | 官方 CLI 支持 datasets/models/kernels 及输出/讨论操作；能力存在不表示本系统已连接或获准付费运行。 |
| [Kernel Metadata - Kaggle Official CLI](https://raw.githubusercontent.com/Kaggle/kaggle-api/main/docs/kernels_metadata.md) | 2026-10-25T09:41:58.374Z | body_extracted；B | Notebook 上传需要实际 code_file 和 kernel 元数据，支持输入来源与 GPU/Internet/visibility 等设置。 |
| [Dataset Metadata - Kaggle Official CLI](https://raw.githubusercontent.com/Kaggle/kaggle-api/main/docs/datasets_metadata.md) | 2026-10-25T09:41:58.377Z | body_extracted；B | 数据集上传用实际文件与 dataset-metadata.json；许可、字段 schema、来源和更新信息各有意义。 |
| [Kaggle Community Guidelines](https://www.kaggle.com/community-guidelines) | 2026-10-25 | indexed_body_only；B | 论坛 AI 用途限翻译与拼写/语法；反对自荐刷票、无实质增量 fork、无关输入；合成数据需 Synthetic 标记。 |
| [Introducing Writeups!](https://www.kaggle.com/discussions/product-announcements/593763) | 2026-10-25 | indexed_body_excerpt；B | Kaggle 另有长文 Writeups，不能把论坛、notebook 与 Writeups 当一种内容或同一推广规则。 |

来源限制（`kaggle-community-index`）：Official page body is available in the live search index; both direct fetch and web open returned title/empty only. Not a logged-in account/permission check.

来源限制（`kaggle-writeups-index`）：Official staff announcement/comments distinguish Writeups from forum self-promotion; current authoring entitlement and its complete AI rules not verified.

### 平台研究：读者、形态、表达与规则

**受众要完成的事**：B：官方 CLI 与元数据围绕数据、模型、notebook 和输入/输出；社区规则要求这些作品与数据科学/AI/ML相关。D：读者要重用数据、复现分析或理解有证据的实验；普通品牌故事不应该伪装成 notebook。

**发现机制与不确定性**：B：数据/模型/代码、公开作品与讨论容器各自存在；实际样本区分 Input/Output/Logs。D：用真实任务、字段、数据来源和可复现结果帮助读者判断，不以拉票、无关挂载或重复 fork 获取声誉。

**原生形式和具体容器**：B：真实 dataset、notebook/script、model；另有官方 Writeups 长文形态，不能误称只能传数据。D：本岗位 P0 优先真实作品；Writeup 必须承接真实研究/解法，当前权限和完整规则未核实则只做导出。论坛原文的 AI 处理只限允许的翻译/语法。

**标题与开头策略**：D：标题＝真实任务/数据对象＋方法/比较条件；开头先给问题、数据和读者会得到的可复现实物。结果只能来自实际运行，不编造排行榜名次、提升比例或‘完美准确率’。

**语气与作者角色**：D：实验记录式、准确区分探索/验证与假设；说明划分、失败和不确定性；图表先解释口径，再讲结论。语言面向同行与学习者，不用玄学‘秘诀’或投票请求。

**结构与论证**：D：notebook＝目标/来源许可→数据字典与检查→数据划分/泄漏防护→最小 baseline→方法/对照→真实输出与误差分析→限制/复现环境→导出；dataset＝来源/收集许可→文件/字段/缺失→处理/划分→偏差/隐私→示例；Writeup＝真实问题/实验/结果/局限与关联实物。

**证据要求**：B：kernel 元数据需要实际 code_file，数据集需实际文件和 metadata；社区要求合成数据标明 Synthetic。D：代码 SHA、输入版本、运行日志、输出文件和指标必须同一次运行；静态单元格检查不能叫从头重跑成功。

**社区与互动边界**：B（官方索引全文，直接动态正文未取得）：论坛讨论/评论使用 AI 限原文翻译及拼写语法；反对无关自荐、拉票和无实质新增复制 notebook。D：岗位不生成论坛回答/评论；以本人原文校对或将真实作品交本人选择合规容器。

**反例/不应做的事**：

- 把一段文章或空 notebook 当已运行成果；编造分数/排名/输出
- 直接 fork 更名再公开，或挂未使用的数据/模型引流
- 将 AI 写的母版变成论坛回答或评论；把 Writeups 当规避规则入口
- 公开合成数据却不披露；许可/竞赛规则未审就共享数据；先看测试答案再报告验证成绩

### 实际公开样本观察（C，或明确未取得）

[Titanic Tutorial](https://www.kaggle.com/code/alexisbcook/titanic-tutorial/notebook)；取得 2026-10-25。C：Titanic Tutorial 的搜索索引显示 Notebook/Input/Output/Logs 分离，并能看到 submission.csv 的产物入口；这能支持“作品与运行产物分开验”的设计。直接页和 web open 只有空正文，未精读单元格、未验证真实运行时或评分。

访问边界：仅官方页面索引的结构/产物元数据；完整代码样本未取得。

### 平台专家如何工作（以下全部 D，未实施）

**职责**：交付有来源、许可、真实输入输出和可复现证据的数据科学实物；无作品或数据科学目的时准确 skip。

**必须输入**：

- artifactType:notebook|dataset|model|writeup；真实 public/private目标与所有者
- dataSnapshot[]:{source,version,license,sha256,schema,syntheticFlag,privacyReview}
- notebook/codeFiles、依赖/环境、随机种子/划分、baseline/metric定义、实际执行日志与输出；尚未执行明确 unrun
- 竞赛规则/共享范围/署名；论坛校对必须有本人原文，不从母版生成新论点

**专家决策**：

1. 先判数据科学相关性与实物/权利，不把宣传稿转成假 notebook
2. 检查数据出处、合成/敏感属性、划分及可能泄漏；设计最小复现工单
3. 选择 dataset/notebook/model/Writeup 容器并分别给前提；不把一次文章改写冒充四种作品
4. 只引用实际运行结果，区分已验证与待运行；输出/图表都绑定具体输入版本
5. 独立代码/数据/指标与文件检查；论坛只校对本人原文；最终人工审核公开范围与成本

**原生输出 schema**（准确字段设计，不是现有API已支持承诺）：

```json
{
  "discriminator": "nativeForm",
  "forms": {
    "notebook": {
      "required": [
        "codeFile:verified-ipynb-or-script",
        "kernelMetadata:{id,title,language,kernel_type,code_file,is_private,enable_gpu,enable_internet,dataset_sources,competition_sources,kernel_sources,model_sources}",
        "dependencyManifest:verified-file",
        "inputVersions:versioned-ref[]",
        "splitAndLeakageReview:evidence-ref",
        "runReceipt:{status,environment,startedAt?,finishedAt?,codeSha,inputsHash,exitCode?}",
        "outputs:verified-file[]",
        "metricRecords:observed-metric[]",
        "knownLimitations:string[]"
      ],
      "invariants": [
        "无真实 codeFile 不成立；未运行时 metrics 不伪填",
        "环境/GPU/Internet/可见范围须明确审核",
        "官方 metadata 导出需按当前已核版本转换，不盲照示例类型"
      ]
    },
    "dataset": {
      "required": [
        "dataFiles:verified-file[]",
        "datasetMetadata:{id,title,licenses,resources,keywords?}",
        "dataDictionary:field[]",
        "provenance:evidence-ref[]",
        "privacyAndLicenseReview:evidence-ref",
        "syntheticDeclaration:boolean",
        "versionNote:string"
      ],
      "invariants": [
        "文件与字段/schema一致；许可不能由模型选择成CC0",
        "合成来源在实际平台标签与正文正确披露"
      ]
    },
    "writeup": {
      "required": [
        "title:string",
        "bodyMarkdown:string",
        "researchOrSolutionEvidence:evidence-ref[]",
        "relatedArtifacts:verified-ref[]",
        "currentFormPolicy:evidence-ref"
      ],
      "invariants": [
        "不是 notebook 完成证明；缺当前权限/规则则仅导出"
      ]
    },
    "human_forum_copyedit": {
      "required": [
        "originalHumanText:string",
        "permittedEdit:translation|spelling_grammar",
        "editedText:string",
        "noNewArgument:true"
      ],
      "invariants": [
        "不从AI母版起草讨论或回复，不借翻译改写成新内容"
      ]
    }
  }
}
```

**工作流**：

1. 官方规则/目的资格→实物/数据权利检查
2. 数据/代码/环境冻结→设计实际复现与泄漏核查工单
3. 有授权才隔离执行，保存全部日志/输出/实际失败；无授权则停在计划
4. 写 notebook 解释/卡片/方法稿→与真实输出逐项比对
5. 独立代码/数据/许可/指标审查→最终润色→最终文件/包重检
6. 本人审数据与公开设置→单次授权上传/运行→平台版本/文件/输出回读；论坛只有限原文校对

**Critic rubric**：

- `blocker`：无真实数据/代码文件或伪造运行、分数、排名；数据无权共享/含隐私/竞赛不允许公开；泄漏使指标无效却当成果宣传；AI 新写论坛内容/评论；合成数据未披露。
- `major`：缺环境/随机种子/输入版本/划分说明；输出与 code/input 不同轮，图表口径不清；公开 fork 无足够本人新增或没署名。
- `minor`：冗余单元格、图轴/单位不清、解释和可重跑路径不连贯。

**范围受控的记忆**：`accountId+artifactId/competitionId+datasetVersion+locale`。

- 可保存：经核实的数据字典与来源引用；本人批准的实验解释、失败模式和评测口径；当前竞赛共享规则、平台限制和论坛AI边界。
- 不保存/不学习：测试集答案、受限竞赛/个人数据、凭据；把一个数据集许可套所有数据；排行榜/点赞即时值变永久能力事实。
- 更新：每次数据/代码/输入或规则变更重核；结果记忆只指向真实运行，不自动总结为因果；过期权限停止公开动作。

### 适配策略如何成为实际二次生产任务

只有当母版背后有真正的可公开数据或实验时，才转成 notebook/数据包，并把叙述落为可执行分析和实际结果；普通软件发布或品牌母版不投。若有真实研究但只需长文，明确选择 Writeup 且保持类型/规则差异。

| 必需任务 | 当前可复用/实际缺口 | 证据与实现状态 |
|---|---|---|
| 数据/代码/许可与实验设计、实际复现 | 当前视频工位不提供 Kaggle notebook 生产/沙箱；需独立数据科学工单 | D 缺失 |
| 图表/示意图与真实输出说明 | 可复用媒体库保存已验证图；visualwrite.compose 仅可排版已有真实数据的说明图，不能生成实验数字 | A 文档＋B 工具目录 |
| kernel/dataset metadata、ipynb安全预览和平台输入输出回读 | 当前媒体API不接受 ipynb/CSV/模型权重；新增artifact存储/验证/备份与官方授权适配 | A 文档边界＋D 缺失 |

**需补能力**：

- 安全 notebook/脚本/数据 schema 检查与隔离执行（默认禁网/禁秘密、资源预算）
- 训练/验证/测试划分和指标/输出血缘验证；合成数据与许可核验
- ipynb/CSV/模型文件私有存储与预览/备份、新原生包审批
- Kaggle 当前账号/竞赛/运行资格、官方上传/运行/版本与结果回读；论坛AI语法例外检查

**拟议验收**：

- 正常：获准公开的真实小数据、代码和 baseline，当前环境整本成功运行，输出/指标/metadata与输入版本一致。
- 缺前提/错误：仅工程宣传稿无数据或 notebook→skip；静态内容有分数但无运行证据→blocked；要AI写论坛回复→拒绝该行为。
- 本次实际：研究/设计阶段，未创建 notebook、上传数据或执行代码。

## 7. 百家号 · baijiahao

**岗位：大众应用解释与来源核查编辑（默认归档）。研究状态：`rules_grounded_native_sample_missing`。**

### 先读到的官方依据与边界

| 来源 | 取得时间 | 访问与证据 | 只支持的结论 |
|---|---|---|---|
| [百家号内容基础红线规则_搜索学堂_百度搜索资源平台](https://ziyuan.baidu.com/college/articleinfo?id=3537) | 2026-10-25T09:34:56.373Z | body_extracted；B | 官方说明反对题文不符、虚假/旧闻冒充新闻、抄袭、恶意营销；涉及专业资质需另审。 |
| [百家号素材审核规范 - 介绍](https://smartprogram.baidu.com/opensourcedocs/introduction/auditing_baijiahao/) | 2026-10-25T09:34:56.373Z | body_extracted；B | 该文限于智能小程序百家号流量接入素材，约束标题/图片相关性及推广；不能扩大为所有百家号正文的统一图片禁令。 |
| [百度搜索优质内容指南_搜索学堂_百度搜索资源平台](https://ziyuan.baidu.com/college/articleinfo?id=2947) | 2026-10-25T09:49:41.514Z | body_extracted；B | 2020 官方搜索优质内容指南适用百家号等合作内容；支持可读性/主题与图文相关的一般质量，不当2026算法公式。 |

### 平台研究：读者、形态、表达与规则

**受众要完成的事**：B：官方搜索质量指南把能否满足用户问题、完整清楚、主题/图文相关列作内容质量要素；百家号红线强调真实表达与有帮助的信息。D：本岗位面对不熟悉内部技术名词、想判断某个 AI 方法与自己何干的中文读者。

**发现机制与不确定性**：B：官方质量指南明确适用于百家号等合作内容，说明搜索情境；该文发布于2020年，本次只用于一般质量原则。D：围绕真实用户问题写明确标题、概念解释和可操作信息，不推断2026推荐权重、不保证收录/排名。

**原生形式和具体容器**：B：官方资料涉及文字、图片、视频与对应素材；当前目录 preferred article、默认归档属于产品选择。D：恢复任务先选文章，必要图片支持解释；若选视频，必须另有实际成片与当前账号形态核验。

**标题与开头策略**：B：官方红线反对题文不符、夸大、旧闻假装新消息。D：标题给一个具体问题/做法和适用条件，开头讲真实生活/工作场景；示例“让 AI 整理资料前，先核对这几类来源”中的数量只按真实正文计，不硬套爆款数字。

**语气与作者角色**：D：解释陌生术语、用普通中文，把推断与已实测分清；不用内部研发缩写堆砌身份，不写‘普通人必须学’、虚构收益或行业必然替代结论。

**结构与论证**：D：读者问题→必要概念与前提→真实示例/步骤→来源和结果边界→常见误区/适用与不适用→清楚结尾。图片每张对应解释环节、来源与权利，避免把代码长截图当大众可读图文。

**证据要求**：B：2023红线是本次可取得的官方资料；素材审核文属于小程序流量接入，不能扩大为全部百家号统一禁图规则。D：凡数据/案例/身份/时效/专业判断都附来源；作者没有相应资质的高风险领域不扩展；当前后台资格/AI声明未登录核实。

**社区与互动边界**：D：只围绕文章中的实际问题提供解释；对事实纠错保留修订依据。营销联系方式、客户咨询、争议/负面及专业高风险问题按既有人工边界处理；不把批量私信/评论当增长任务。

**反例/不应做的事**：

- 照搬公众号/技术长文，只有标题换通俗词
- 题文不符、旧闻装新、伪原创洗稿、数字/用户故事虚构
- 二维码/联系方式等恶意引流，或无资质扩展健康/金融等指导
- 把小程序素材限制当全站规则，或把2020质量文当2026算法公式

### 实际公开样本观察（C，或明确未取得）

C 缺口：两轮公开检索（含 site:baijiahao.baidu.com/s?id= 与通用原生域检索）未找到可直接读取的合适 AI/工程案例；未把搜索百科、第三方搬运或学习文档冒充百家号真实成品。当前不能从样本归纳其口语风格、互动或效果。

访问边界：unable_to_obtain_native_example。

投入前补齐：恢复运营时增加1篇本人可公开、真实可读的原生样本与账号编辑器实查；未完成前为规则研究充分、样本校准不足。

### 平台专家如何工作（以下全部 D，未实施）

**职责**：将可公开、有来源的实践写成大众能理解的具体文章，保持默认归档；只有本人明确恢复运营且补足当前资格与样本后投入。

**必须输入**：

- 明确恢复任务与具体 account/destination；当前身份/领域/规则审核
- 真实母版、approvedFacts、可公开截图/案例/来源、时效与专业范围
- 目标读者问题、术语解释表、文章/图片/视频类型与实际资产
- 账号当前编辑器/作品声明/AI标识等当次核验；原生样本缺口记录

**专家决策**：

1. 先判是否真的适合大众问题，内部架构/纯品牌段落可删，相关性不足 skip
2. 选择一个具体可解释应用与例子，避免夸大用户收益
3. 重做开头、术语、段落与图文顺序，所有关键结论保留边界
4. 核对来源/时效/标题和图片/专业资质，限定素材规则适用范围
5. 样本与账号规则未核清只交候选，不称 ready；最终由本人审核后单次外发

**原生输出 schema**（准确字段设计，不是现有API已支持承诺）：

```json
{
  "discriminator": "nativeForm",
  "forms": {
    "article": {
      "required": [
        "title:string",
        "body:string",
        "sectionOutline:string[]",
        "evidenceAnnotations:claim-mapping[]",
        "imageSequence:verified-image[]",
        "cover:verified-image|null",
        "attribution:string[]",
        "eventDates:verified-date[]",
        "currentNativeSettings:reviewed-fields",
        "restoreAuthorization:evidence-ref",
        "sampleCalibration:verified|missing"
      ],
      "invariants": [
        "标题承诺与正文/图片一致；没有新闻事实不包装成新闻",
        "sampleCalibration=missing 时不得冒称平台风格验收完成",
        "AI/原创/资质设置按当前实际表单核验，不预填假状态"
      ]
    },
    "video": {
      "required": [
        "actualVideo:verified-file",
        "cover:verified-image",
        "subtitles:verified-file|null",
        "description:string",
        "rightsAndPrivacy:evidence-ref",
        "technicalAndHumanReview:evidence-ref[]",
        "currentFormEligibility:evidence-ref"
      ],
      "invariants": [
        "脚本不等于成片；媒体与文稿同一准确包"
      ]
    }
  }
}
```

**工作流**：

1. 默认归档/本人恢复核验→平台当前规则与样本补齐
2. 母版与大众问题匹配→事实/时效/术语冻结
3. 重写文章、编排有用图片→来源与标题/图片匹配核验
4. 实际渲染媒体如获授权→独立事实/可读性与权益检查
5. 最终润色→最终包重读→本人审阅当前设置→单次授权外发与真实回读

**Critic rubric**：

- `blocker`：没有恢复授权或账号当前资格/敏感领域边界；标题/图片/案例虚假、侵权、私密信息；未披露样本/规则未核实却称已验收；素材/最终包变更沿用旧审批。
- `major`：术语不解释、问题无解答或信息不足；旧事件新语气；来源与正文不对应；过度推广引流，图文与读者任务不相关。
- `minor`：长段、空泛开场、重复口号、图片说明不足。

**范围受控的记忆**：`accountId+domainExpertise+locale+articleType`。

- 可保存：本人批准的朴素中文解释、读者常见误解；真实纠错与当次规则版本；恢复后的批准原生样本（只存授权引用/必要风格特征）。
- 不保存/不学习：不明收益/趋势数字、私信客户资料；把默认归档自动改为活跃；把第三方爆款公式当官方算法。
- 更新：恢复前完整核规则与实际样本；之后每次发布核当前编辑器/声明/资质，内容样本按人工修订迭代。

### 适配策略如何成为实际二次生产任务

把技术母版拆成普通读者的具体任务、前提、步骤和限制；若真实图示可帮助理解则另交图示工单，不能靠编用户故事增强可读性。归档状态保持不变。

| 必需任务 | 当前可复用/实际缺口 | 证据与实现状态 |
|---|---|---|
| 大众文章改编、术语/标题/来源审核 | 现有 Edition/Variant 可承接 article；岗位与目的判定为拟议 | A 文档＋D 设计 |
| 真实步骤图/封面/可读说明图 | visualwrite.compose/render 为 B 工具目录，当前工位需实际接线；上传仍走媒体真实性/权利审查 | B 目录＋A 文档 |
| 如明确选视频，实际后期与交付核验 | production.plan 仅预览；post.quality 检查技术质量；艺术/信息理解需人看 | A 包装源码/文档，未现场执行 |

**需补能力**：

- 当前百家号账号/编辑器/AI标识/可见性资格研究和1篇可读原生样本
- 面向大众的标题—正文—图片语义一致检查器与平台预览
- 完整 nativeSettings 入审批哈希；未来发布/回读适配

**拟议验收**：

- 正常：本人恢复且补样本，有真实应用与素材，文章能独立回答问题，标题/图像/来源一致，当前设置实际核实。
- 缺前提/错误：默认归档仍在、样本或当前规则未核完却要求批量分发→blocked；不编造已恢复。
- 本次实际：研究/设计阶段；未恢复账号、生成外部草稿或发布。

## 8. 今日头条 · toutiao

**岗位：大众图文与解释视频编辑（默认归档）。研究状态：`rules_grounded_sample_partially_accessible`。**

### 先读到的官方依据与边界

| 来源 | 取得时间 | 访问与证据 | 只支持的结论 |
|---|---|---|---|
| [今日头条社区规范/内容创作规范/平台不允许/平台不鼓励/评论管理/处置手段/头条创作者帮助中心-有问题，上百科](https://baike.toutiao.com/detail/236/238/0) | 2026-10-25T09:34:56.373Z | body_extracted；B | 官方现行页标2026-10-16：反对重复低质、虚假、抄袭、违规引流，要求作品声明；导航列图文/微头条/视频。 |
| [内容创作规则/规范/一、消重抄袭与申诉/1、违规内容/2、申诉规范/二、标题创作规范/1、标题夸张/2、标题与正文原意有偏差/3、标题格式不规范/三、发文数量规则/**1、发文数量限制**/2、发文量统计范围涵盖以下/3、发文量统计范围不包含以下/常见问题/头条创作者帮助中心-有问题，上百科](https://baike.toutiao.com/detail/211/212/570) | 2026-10-25T09:34:56.373Z | body_extracted；B | 官方标题规则区分夸张、故意悬念、强迫点击、范围/时态夸大、题文/封面不符；不照搬固定配额为运营目标。 |

### 平台研究：读者、形态、表达与规则

**受众要完成的事**：B：官方帮助中心区分图文、微头条、视频等形态，并对真实、题文一致和有信息增量提出要求。D：本岗位面对希望快速弄清一件事、一个方法或一段真实演示的中文读者；不是替所有工程母版制造新闻性。

**发现机制与不确定性**：B：多体裁入口、话题/内容与作品声明均需按当前形态处理。D：先选与内容匹配的具体形态和清楚主题；本研究不主张统一最佳字数、发布时间、推荐节奏或平台算法公式。

**原生形式和具体容器**：B：官方目录包含图文、微头条、中/小视频等不同体裁。D：P0 分别给完整图文稿或真实视频包；微头条只在一个清晰观察可独立成立时选，不能把文章截断或视频脚本当成品。

**标题与开头策略**：B：官方标题文具体反对省略关键主体制造悬念、强迫点击、夸大范围/程度和题文/封面错位。D：标题写清对象、发生了什么/能解决什么、必要条件；开头直接给可核实事实和读者相关性，不用‘刚刚’包装旧事件。

**语气与作者角色**：D：清楚、接近日常说话但有来源，不用‘全网炸了/所有人被淘汰’或空洞集体情绪。事实、作者判断和未验证推测分开，视频口播与图文都不增加母版没有的亲历。

**结构与论证**：D：图文＝明确结论/问题→真实背景/来源→重点步骤或解释→可见例证→适用与限制；微头条＝一个事实/亲历→一个判断/限定→一个具体可讨论点；视频＝可见结果→必要背景→连续演示→真实限制，字幕与画面同步。

**证据要求**：B：当前社区规范页标2026-10-16，另有详细标题样例；作品声明、专业资质、重复低质与推广规则独立。D：时间、人物/主体、图像和数字要可追溯；AIGC/虚构等当前设置当次核查，不用一张装饰封面充当演示证据。

**社区与互动边界**：D：围绕读者对步骤/证据的疑问互动；事实纠错要回链到具体来源，争议/财务/医疗/招聘等不进入自动回复。评论不诱导私信拿资源、互粉互赞，不把频次阈值当可批量刷文额度。

**反例/不应做的事**：

- 标题夸张、强迫点击、悬念缺主体；封面/标题/视频各说一件事
- 旧闻冒新、虚构新闻/观点/网友态度，压缩时去掉‘可能/仅本例’
- 连续重复/相似低质稿，纯广告/导流或无信息增量的商品参数拼凑
- 微头条只是长文第一段，视频只是脚本或图像轮播无真实任务

### 实际公开样本观察（C，或明确未取得）

[第七届 CCF 计算机科普内容征集活动](https://www.toutiao.com/article/7678637551170765347/)；取得 2026-10-25。C：公开科普活动文章索引先提出清楚主题，再列对象、作品类别、时间和来源主体；可观察完整信息骨架。直接取页与 web open 均无正文，不把索引节选称全文精读，也未验证作者账号、图片或效果。

访问边界：官方平台上的真实公开文章，仅索引节选；需后续原生编辑器/完整样本复核。

### 平台专家如何工作（以下全部 D，未实施）

**职责**：将真实事件或做法改编为有信息增量、标题和媒体相符的大众内容，保持归档默认与具体形态审查。

**必须输入**：

- 明确恢复任务、具体账号/体裁/目的地、当次政策和作品声明
- 母版/公开Claim/实际时间与主体、截图/成片/权利
- 选择 graphic_article|micro_post|video 的读者任务；真实观察与作者判断标注
- 当前界面限制、可见性/封面/合成标识等设置；不得依据旧帮助文自动填账号权益

**专家决策**：

1. 先判断内容相关性和时效，无法构成新闻则用解释/方法且写清日期
2. 选择图文、微头条或视频，重做信息密度和顺序，不自动跨体裁压缩
3. 用事实支持标题和封面，核必要限定词和图文/口播一致
4. 确定实际视觉资产与字幕需求、公开范围及专业资质边界
5. 独立标题/事实/媒体/设置核验后润色，最终包再读；本人审批与单次发布独立

**原生输出 schema**（准确字段设计，不是现有API已支持承诺）：

```json
{
  "discriminator": "nativeForm",
  "forms": {
    "graphic_article": {
      "required": [
        "title:string",
        "body:string",
        "orderedSections:section[]",
        "orderedImages:verified-image[]",
        "cover:verified-image|null",
        "eventAndClaimMap:evidence-map[]",
        "nativeDeclarations:reviewed-settings"
      ],
      "invariants": [
        "题文/封面一致；不把推断写为已发生新闻"
      ]
    },
    "micro_post": {
      "required": [
        "text:string",
        "oneCoreObservation:string",
        "factOpinionBoundary:string",
        "images:verified-image[]",
        "nativeDeclarations:reviewed-settings"
      ],
      "invariants": [
        "脱离母版仍完整可懂，未制造亲历"
      ]
    },
    "video": {
      "required": [
        "video:verified-file",
        "cover:verified-image",
        "title:string",
        "description:string",
        "captions:verified-file|null",
        "transcript:string",
        "technicalReport:evidence-ref",
        "humanViewReview:evidence-ref",
        "nativeDeclarations:reviewed-settings"
      ],
      "invariants": [
        "真实完整成片；视听/字幕/标题事实一致，不能仅脚本"
      ]
    }
  }
}
```

**工作流**：

1. 归档/恢复和当前规则检查→体裁/读者任务选择
2. 事实与日期冻结→开头/结构/标题候选→媒体生产任务拆解
3. 完成图文或实际视频→独立事实/标题/媒体匹配检查
4. 有限返修→最终润色→最终包重检与本人审设置
5. 具体授权外发→真实正文、媒体、公开时间与结果回读；未知先查不重发

**Critic rubric**：

- `blocker`：虚构事件/数字/主体/声称、无授权媒体或隐私；未恢复/无账号当前资格；标题或封面与实际内容矛盾；无实际成片却称视频完成。
- `major`：省略关键条件/时间、缺明确问题/信息增量；体裁不适合而机械截断；字幕/口播/图文事实不一致或声明未核。
- `minor`：啰嗦开场、段落节奏乱、图像难读、结尾互动问题空泛。

**范围受控的记忆**：`accountId+nativeForm+locale+topicDomain`。

- 可保存：本人认可的朴素语气与必要背景；逐条标题修正原因和限定词；真实媒体失败/读者误解与已核规则版本。
- 不保存/不学习：‘流量密码’或虚假热度、网友态度；跨体裁沿用不匹配比例和字幕设置；归档自动恢复或把建议频率变发文任务。
- 更新：每次体裁/规则/权益变化重核；标题与声明发布前复查；真实数据只有明确口径/窗口才可形成观察，不推断因果。

### 适配策略如何成为实际二次生产任务

同一工程复盘可拆成大众图文的一个清楚做法，或实景/录屏解释视频；微头条取一条真实观察并补完整上下文。不能把长文一键压成‘热点’，媒体生产先有实物。

| 必需任务 | 当前可复用/实际缺口 | 证据与实现状态 |
|---|---|---|
| 大众图文与标题—封面—正文对应检查 | 当前 image_text/article Variant 可承接正文与媒体顺序；员工规则检查拟议 | A 文档＋D 新能力 |
| 实际封面、字幕和后期媒体 | visualwrite.compose/render、subtitlewrite.sidecar/burn 为 B 目录映射，须当前工位检查与实际执行证据 | B 目录，不作已接通承诺 |
| 视频计划与当前成品核验 | growth.video.production.plan 仅预览，growth.video.post.quality 技术判定，另需人工观影；云端小机不执行重型媒体 | A 包装源码/文档 |

**需补能力**：

- 头条当前账号/体裁/作品声明与完整样本核验
- 图文/微头条/视频独立 typed 包与标题封面语义检查
- 本机媒体与云端候选准确hash交接、原生设置/媒体回读适配

**拟议验收**：

- 正常：本人恢复运营，真实方法及媒体齐全，所选体裁自成一体，标题/封面/字幕/实际结果相符。
- 缺前提/错误：无成片只脚本却要视频 ready，或去掉‘可能/仅本例’制造新闻→blocked；默认归档不自动改变。
- 本次实际：研究/设计阶段，未生成媒体、恢复账号或外发。

## 9. 脉脉 · maimai

**岗位：本人职业表达研究与编辑助手（禁止接管账号，默认归档）。研究状态：`official_rules_and_public_sample_grounded`。**

### 先读到的官方依据与边界

| 来源 | 取得时间 | 访问与证据 | 只支持的结论 |
|---|---|---|---|
| [脉脉社区管理规范](https://maimai.cn/n/platform/rich-text/que1) | 2026-10-25T09:34:56.373Z | body_extracted；B | 现行官方规范限制 AI 接管账号/模板化批量生产、虚构职场经历、站外导流和骚扰；身份/利益诉求与招聘另有规则。 |
| [脉脉社区“真实感专项”治理公告 - 脉脉](https://maimai.cn/article/detail?efid=2Iny9oDcAei3oS16d1Lc4A&fid=1878008868) | 2026-10-25T09:34:56.373Z | body_extracted；B | 官方小管家治理公告反对 AI 虚构工作体验与频繁矛盾人设；更新记忆不能造第一人称经历。 |
| [关于脉脉社区信息安全的公告 - 脉脉](https://maimai.cn/article/detail?efid=eCHpmEenLcjacMdYib-8MA&fid=1897970440) | 2026-10-25T09:34:56.381Z | body_extracted；B | 官方解释跨平台公开细节可形成身份关联；匿名形式不能作为隐私已安全的依据。 |

### 平台研究：读者、形态、表达与规则

**受众要完成的事**：B：官方规范鼓励真实职场信息和真实个人职业资料；治理关注虚构工作体验与人设矛盾。D：读者更需要判断一种工作方法、职业选择或团队取舍是否可借鉴；岗位从真实工作材料出发，不造‘职场故事’。

**发现机制与不确定性**：B：个人资料/职业经历与人脉关系是平台公开设计的一部分；当前规范限制不真实影响力和无关导流。D：以真实职业上下文、具体问题和可借鉴判断让合适同行理解，不假设人脉图/匿名身份能换来触达或隐私保障。

**原生形式和具体容器**：B：帖子/评论、职业信息与文章等公开形态存在，规范分别约束身份、营销和招聘利益诉求。D：岗位只做单篇研究、结构建议和本人原文编辑；不代管账号、不批量生成运营流水线，成品由本人逐稿确认。

**标题与开头策略**：D：从一个真实工作场景与具体取舍进入，例如‘一次跨团队交付中，哪些确认减少了返工’仅在本人确有对应经历与证据时采用；不捏造裁员、薪酬、内推、内部消息或夸大职位。

**语气与作者角色**：D：保持本人身份、时间线和职业口吻，用‘在这个具体条件下’替代普遍管理定律；个人判断明确是判断，不代表雇主或客户发言。不是把营销软文换成‘作为某大厂员工’。

**结构与论证**：D：本人确认的场景→约束/冲突→采取的真实选择→结果/代价与未解决点→能复用的经验或一个具体问题。需要长文则围绕完整方法，而非堆职业情绪；敏感信息做删减或不发，不用改名编细节保故事。

**证据要求**：B：现行规范明确提及 AI 批量模板化/接管运营、虚构经历、站外导流；官方安全公告说明公开细节可形成关联。D：事实、时间线、身份、许可和间接识别风险逐项由本人确认，匿名不等于已隐私安全。

**社区与互动边界**：D：只对具体方法/学习问题提供本人确认的回应；招聘、内推、客户、负面冲突、法律/薪酬及隐私问题按既有人工边界。不得群发私信、营销引流、拉票或用同义改写规避规则。

**反例/不应做的事**：

- AI 接管个人账号或模板化批量内容；把28目标编排直接连到脉脉外发
- AI 虚构职业经历、人设/时间线频繁矛盾；假招聘/假内推
- 披露雇主/客户信息或认为匿名就安全；站外链接/联系方式引流
- 鸡汤、无关段子、引战与‘内幕’叙事替代真实方法；未经认证的利益诉求

### 实际公开样本观察（C，或明确未取得）

[个人技术实践历程与 AI 技术的底层理解](https://maimai.cn/article/detail?efid=4O3WyBscf3Cv7c8XEMJ6tw&fid=1921965789)；取得 2026-10-25。C：公开个人技术学习文章用职业学习路径支撑一条基础能力判断，评论中出现明确的学习优先级提问与回应。只能观察这种‘经历—判断—具体问题’结构；不独立核实作者履历，不推广其技术结论，不用阅读量论证有效。

访问边界：实际公开文章与可见少量评论；未登录，未查看任何私人资料。

### 平台专家如何工作（以下全部 D，未实施）

**职责**：帮助本人把真实职业实践表达清楚并先处理身份/隐私/规则风险；不把助手设计成接管个人账号的运营机器人。

**必须输入**：

- 本人明确恢复与单篇任务授权；本人原始经历笔记/原文及事实确认
- authorIdentityAtEvent:{role,employerDisclosureAllowed,eventDates}；指向审批事实，不凭平台简介猜
- 可公开的方法/结果与雇主/客户/同事授权；直接及间接可识别信息清单
- 目标文章/动态与当前规则版本；涉及招聘/利益诉求的实际资格与本人处理边界

**专家决策**：

1. 先判默认归档是否恢复、是否是单篇有实质价值的职业任务；不启动持续代运营
2. 核对作者身份/时间线/第一人称经历；缺证据的经历删掉或退回，不用AI填补
3. 选一个工作取舍和可借鉴点，基于本人原文做结构/解释编辑
4. 执行隐私关联和保密审查，敏感内容可决定不发布；高风险互动交本人
5. 逐项呈现改写与原文差异，最终由本人确认声音/事实/设置；禁止自动外发与批量任务

**原生输出 schema**（准确字段设计，不是现有API已支持承诺）：

```json
{
  "discriminator": "nativeForm",
  "forms": {
    "professional_post": {
      "required": [
        "preparationMode:single_post_editor_assist",
        "originalHumanNotes:string",
        "proposedText:string",
        "experienceEvidenceMap:evidence-map[]",
        "authorConfirmation:required",
        "identityTimelineReview:evidence-ref",
        "privacyLinkageReview:evidence-ref",
        "removedSensitiveElements:reason[]",
        "externalLinkIntent:none",
        "executionMode:manual_only"
      ],
      "invariants": [
        "不能新增本人未确认经历/头衔/结果",
        "不是持续账号托管；不得由批量流水线直接生成并外发",
        "不为‘降低敏感’而虚构假公司/假数值，必要时不发"
      ]
    },
    "professional_article": {
      "required": [
        "originalHumanMaterial:string",
        "title:string",
        "body:string",
        "methodAndTradeoff:string[]",
        "evidenceAndPrivacyReview:evidence-ref[]",
        "authorConfirmation:required",
        "executionMode:manual_only"
      ],
      "invariants": [
        "完整真实方法而非软文；职业/利益诉求资格另审"
      ]
    }
  }
}
```

**工作流**：

1. 归档/本人单篇目标与当前规范检查
2. 本人原文/经历和身份时间线冻结→职业读者问题判定
3. 给结构与表达编辑→逐句显示新增/删减/证据映射
4. 独立身份/保密/间接识别/利益诉求检查→必要时不发
5. 本人逐稿确认后有限润色→最终包重读→本人自行执行与真实回读；不接管账号

**Critic rubric**：

- `blocker`：AI 接管/批量模板化运营或规避平台规则；虚构经历/职务/内推关系、未经许可泄露直接或间接信息；默认归档未恢复、本人未确认原始经历；招聘/客户/负面/隐私等越过人工边界。
- `major`：缺约束/取舍/实际结果或只剩空洞情绪；以雇主/行业身份作未经允许背书；原文编辑添加新观点/经历而未显式确认。
- `minor`：术语堆砌、长鸡汤开场、问题泛泛、第一人称口吻不自然。

**范围受控的记忆**：`本人accountId+职业角色/时间区间+topic+locale；默认最小保存`。

- 可保存：本人批准的表达偏好与不愿披露的类别；已批准事实的引用和明确有效期；删除/拒发理由，规则边界及人审决定。
- 不保存/不学习：雇主/同事/客户具体敏感经历与私信原文；AI补全职业历史或从一稿推断长期身份；跨社交平台拼接身份线索做画像/营销。
- 更新：每篇先由本人核当前身份与许可；职位/公司变化时旧第一人称模板失效，规则变化只影响新任务，不覆盖历史。

### 适配策略如何成为实际二次生产任务

先判断母版有没有本人真实职业取舍；有才基于本人笔记写成方法表达，无则不投。转化过程不增加名企身份、招聘机会或戏剧冲突；比起一键生成，更重要的是让本人逐句核对职业事实和隐私。

| 必需任务 | 当前可复用/实际缺口 | 证据与实现状态 |
|---|---|---|
| 单篇真实职业材料研究、结构建议和原文编辑 | 可安全导出审稿包；不新增脉脉自动外发/托管工具 | D 专属限制设计 |
| 隐私关联/身份时间线/利益诉求人工复核 | 现有互动L0与管理员审批边界可衔接；专门语义检查仍需新增 | A 文档＋D 检查器 |
| 如需示意图，只使用经批准的非敏感真实材料 | 媒体库可管理实际图片；不复用截图里的公司/客户标识，渲染不是隐私安全证明 | A 文档边界 |

**需补能力**：

- 脉脉单篇/禁止批量托管策略与编排级硬闸
- 第一人称经历/职位时间线及间接识别风险检查
- 本人逐句确认/原文差异与最小记忆；当前账号规则/资格/原生形态实查

**拟议验收**：

- 正常：本人确认的真实方法笔记，经单篇编辑后有证据/取舍/隐私核查，最终人工确认并由本人执行。
- 缺前提/错误：无本人经历却要求编大厂故事、自动管账号或批量改写→blocked；招聘/争议回复交本人。
- 本次实际：研究/设计阶段，未恢复账号、私信、发文或操作登录态。

## 跨系统衔接：把策略落实为真实产物（A/B现状与D方案分开）

A 为本次完整读到的包装/文档行为；B 为全量JSON解析的声明/引用；未运行相关工具；D 为新任务/适配器方案。

A 文档：当前 Edition/Variant 支持 article/image_text/video；顺序和媒体摘要入审核。媒资仅现有受支持类型，ipynb/CSV/代码包/模型权重未作为批准附件；不能塞任意路径或用 body 代替实物。新 native 包在实现专门验证/预览/备份/审批之前只能安全导出。

A 源码加载路径＋B JSON：嵌入引擎默认 core8+geo-growth16 共24条登记；鹏经理包装加 status/capabilities 两条。这里是静态源码发现，不是当前工位实际 tools/list 回执；80能力/334工具目录不表示所有ID可由CLI invoke。

| 已登记入口 | 只支持的行为 | 证据 |
|---|---|---|
| `growth.video.production.plan` | 给出计划/前置清单，不执行生成、不构成媒体成品 | A |
| `growth.video.production.status` | 读取阶段账本，无法从缺失结果生成费用或成功证据 | A |
| `growth.video.delivery.inspect` | 逐文件摘要/缺失核验，complete保持false，仍需post.quality | A |
| `growth.video.post.quality` | 读取当前清单、调用当前媒体核验，独立艺术/语义质量仍未验证 | A：包装和调用边界，底层全链本次未重审/未执行 |
| `growth.video.production.shots` | 目录声明为项目镜头/资格读取；非渲染 | B |
| `core.threads.get / core.threads.events / core.approvals.list` | 读取原生任务/事件/审批；不提供新平台批准权 | A 描述加载＋B登记 |

| 生产工具候选 | 用于什么 | 当前目录状态及限制 |
|---|---|---|
| `visualwrite.compose / visualwrite.render` | 真实解释图/封面/多规格图 | 目录 literal-reference-found，依赖unchecked，真实接线/产物unverified；不是当前CLI注册ID；先发现受控执行入口，不猜RPC或直接把ID传invoke（B） |
| `subtitlewrite.sidecar / subtitlewrite.burn` | 实际字幕/成片文本对应 | 目录含实现引用，依赖unchecked，产物unverified；不能用字幕生成结果冒充实际视频或模型/Notebook（B） |
| `coverwrite.plan / coverwrite.render / coverwrite.verify` | 封面策划/渲染/检查 | 当前目录codePresent=false、runtime-unverified；不得仅凭岗位工具名派发‘已接通’执行；要选实际可用 visual 工位或阻塞（B） |

ProductionTask 拟议字段：

```json
[
  "taskId",
  "sourcePackageHash",
  "platformId",
  "requiredOutputKind",
  "inputArtifactRefsAndHashes",
  "transformationSpec",
  "requiredCapabilities",
  "availableCapabilityEvidence",
  "policyAndRightsGate",
  "budgetReservationId",
  "executorIdentity",
  "idempotencyKey",
  "actualResultFiles",
  "actualRunReceipt",
  "qualityReport",
  "statusAndBlockReason"
]
```

让图文岗位明确第2张图要表达哪个已核实步骤、输入哪张真实截图、目标可读区域/语言、预期PNG/JPEG及sha；派给实际发现的visual工位，返回真实文件再入媒体审核。不能只返回‘建议配图’就标完成。

1. 先读目标工位当前describe/schema/状态，核可用入口与依赖；目录不等于可运行
2. 预留模型/渲染预算及人工/许可/资格，未知费用仍占用原预留
3. 仅在工单私有目录生产实际文件，保留准确输入/输出摘要与失败
4. 将实际受支持媒体上传控制面并审权利，保留本机与云端hash对应
5. 内容/媒体/原生设置完成后，由分离检查上下文重读最终包；技术质量不代替可读性/事实/艺术审查

需要单独新增的非媒体执行器：

- repo diff/release/资产核验与README预览
- model/dataset/Space/Studio artifact校验和隔离复现
- ipynb/CSV/模型文件安全预览、数据权利/泄漏/指标血缘与可控sandbox

## 当前本地依据和声明覆盖清单

| 文件 | 等级/方式 | 行数 | SHA-256 |
|---|---|---|---|
| `AGENTS.md` | A：Read to EOF | 50 | `385f500eb0aa6524cc410e72162ba57738638459f147149c9cbbc2ef4a9283e9` |
| `docs/AI-AGENT-GUIDE.md` | A：Read to EOF | 484 | `ad75ce5307f15cbc0f213a104a5b7977f0b9db188067845d8b947f2c007dc937` |
| `docs/CONTENT-PUBLISHING.md` | A：Read to EOF | 131 | `c364e6c840ac4e9e296c8efc0ad48a0216e526066efe29b714ec542d464cfcd1` |
| `docs/VIDEO-RUNTIME.md` | A：Read to EOF | 73 | `53f2d8e83812f1e6fb0f788d6a0d33734a45189286a2ee17e4c27e4677a0aaaa` |
| `src/domain/platform-catalog.mjs` | A：Read to EOF | 25 | `8d8489f4efae8d4651dcc9c74dd19b1ee7c446781e0ad5e2cb3082da97156962` |
| `src/agent.mjs` | A：Read to EOF | 81 | `2d76785f8d5718c55a51dd34802b9550b0b9f161bc9511bbaaabc8b545bd60b6` |
| `scripts/agent.mjs` | A：Read to EOF | 45 | `d907fb57483914c5ef0aa47abbbbae23ee6a55c2edd980a3e391db124c12c17d` |
| `engines/video-edit/scripts/agent-capabilities.mjs` | A：Read to EOF | 390 | `70488ed24cd6c4b1d32a3126e3ec542a788b30ffbba5e7891559dacd7a0ab49c` |
| `engines/video-edit/scripts/agent-capabilities.core.json` | A：Read to EOF | 113 | `48d78ddeca99bc02db78ccd20ea7f207ce3b6906ec896c7bff95826953d231cb` |
| `engines/video-edit/product.manifest.json` | A：Read to EOF | 34 | `c59dbbecf7b45598681fb38f8b7da8b5e5de976930434c3ac967b0acc6768521` |
| `engines/video-edit/bundles/geo-growth/capabilities/video.mjs` | A：Read to EOF | 404 | `ec94da910dbd60b307bc299654036a124a3bce171758efefa09d75b5baf1c127` |
| `engines/video-edit/bundles/geo-growth/capabilities/post-quality.mjs` | A：Read to EOF | 100 | `0a60deb4f0a7dd5b45afe7bbbf9958de5fd77e98efdbaa12c2f02534c5a3d05b` |
| `data/platform-catalog.json` | B：Full JSON parsed; relevant records inspected | 853 | `1082e1d62f12de58e2ca8f4875c83dfcf3c93a693adcc7ad5a1298de2c3aa271` |
| `engines/video-edit/bundles/geo-growth/agent-capabilities.json` | B：Full JSON parsed; relevant records inspected | 489 | `4576929566aca26d2a43b70f0cfbb859013bed66c5d23bb46032bbe8e95aaf7e` |
| `engines/video-edit/pengmanager-capabilities.json` | B：Full JSON parsed; relevant records inspected | 34651 | `c1e3f14b04b81ce504ed2a0154d4fb64b690b42c91167e209265fcf6593c5421` |
| `docs/CONTENT-OPERATORS-DESIGN.md` | C：Relevant rows and contracts; not a new complete proposal audit | 相关章节 | 见原文件 |

可定位的本地出处：

- `src/agent.mjs:17`：默认能力目录加载、运行时与本地/远端分发。
- `src/agent.mjs:24`：鹏经理额外status/capabilities入口。
- `engines/video-edit/scripts/agent-capabilities.mjs:115`：core/行业能力清单加载。
- `engines/video-edit/scripts/agent-capabilities.mjs:184`：输入及execute幂等校验。
- `engines/video-edit/scripts/agent-capabilities.mjs:350`：已登记能力查找与受控transport。
- `engines/video-edit/bundles/geo-growth/capabilities/video.mjs:255`：交付摘要检查complete仍false。
- `engines/video-edit/bundles/geo-growth/capabilities/video.mjs:359`：生产计划仅preview不执行。
- `engines/video-edit/bundles/geo-growth/capabilities/post-quality.mjs:43`：质量包装/当前清单与独立艺术审查边界。
- `docs/CONTENT-PUBLISHING.md:30`：当前language/form及不可变修订。
- `docs/CONTENT-PUBLISHING.md:36`：管理员写入与受限Agent区别。
- `docs/CONTENT-PUBLISHING.md:80`：当前接受媒体类型与真实文件要求。
- `docs/AI-AGENT-GUIDE.md:62`：受限bearer不能创建/批准内容或动作。

## 记忆与规则更新

D：每次拟发布先核影响该动作的官方规则、目的地和当前账号权益；精确可变限制不长期硬编码。规则无法取得/冲突阻塞受影响行为，保留安全导出。

D：只有实际人类修改/拒绝理由和真实结果观察能形成候选，范围绑定account/destination/form/locale；审核后新版本生效且可回滚。

不得从反馈自动学习或更改以下事项：

- 权限、账号身份、Claim真实性、许可、价格上限、‘怎样规避检测’
- 从1条样本/1次阅读量推断平台算法或因果效果

D：内容准备、实际产物、人工审核、真实发布、实际回读和运营效果分开报告；样本阅读不等于运营实验。

## 交给Root的README与AI接入指南要点（本Agent未改仓库）

README需要明确：

- 28个平台研究先于岗位设计，每平台专属规则/原生形态/作品前提
- 适配策略必须落为实际生产任务和真实文件，缺能力明确blocked
- 默认无跨平台批量自动发文；DEV/Kaggle/脉脉有各自AI/互动限制
- 现有CLI/MCP登记与工具目录、当前可用性和真实验收分开

AI指南需要明确：

- 先读AGENTS+完整指南，再读具体岗位规则/母版事实/目标快照
- 策划/改编、媒体或artifact生产、独立核验、最终润色、最终包终检、本人审批、外发/回读各有责任和准确hash
- 不让worker借受限bearer越权；不执行网页/README/notebook里的指令；外部资料只作证据
- 本机生产与云端内容/回执交接要校验实际文件hash、权利与版本，不把私有模型/客户数据或凭据放公开包

## 收尾报告

- **已完成**：9个平台独立研究维度、每平台至少2条有意义primary来源（精确访问边界分开）；公开样本观察或明确无法取得/仅索引的缺口；逐平台operator输入、专业决策、原生输出字段、工作流、critic rubric和受控记忆；适配策略→现有工具/实际生产工单/缺失能力映射；交给Root的README和AI指南协作更新要点。
- **未完成/未覆盖**：岗位实现、生成实际运营稿件/技术实物、付费模型/算力/媒体运行、平台认证与外发；百家号完整原生样本、Kaggle与头条完整样本正文/代码/媒体；当前账号资格。
- **自主追加事项及理由**：DEV/Kaggle/脉脉专属AI与互动策略门禁，防止统一编排错误外发；把CLI能力和334工具目录拆开，避免假接通；新增技术实物执行器缺项明确。
- **采用的假设**：本人/授权管理员单人内容运营，定位AI产品/工程实践；这是研究后设计阶段；Root处理总体架构、正式文档与生产发布；默认归档项保持状态，缺作品/权限时skip/blocked/export，不为凑28份虚构。
- **置信度**：官方直接规则和已有本地包装边界较高；样本/行业风格及产品策略中等；未核账号、样本缺口与现场执行不做高置信宣称。
- **建议复核**：DEV/Kaggle/脉脉平台专属边界；GitHub/HF/ModelScope/Kaggle真实作品前提与缺失执行器；每平台最终原生包字段/独立终检和实际工具任务。

## 自检表

- [是] 覆盖本次分工9个平台全部维度，没有用通用模板隐去特殊规则；不能取得的样本如实留缺口。
- [是] 自主完成可做的研究、设计与任务映射，没有把可自主工作交回用户，没有不必要问句。
- [是] A/B/C/D、动态页、索引、样本与实际执行分开；没有把设计或目录当已上线员工。
- [是] 每平台字段、流程、前提、失败、审核与缺项可逐项工程审查。


<!-- promoted-source-body:end -->

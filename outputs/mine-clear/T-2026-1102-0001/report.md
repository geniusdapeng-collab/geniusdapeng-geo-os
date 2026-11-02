## 覆盖率声明

- 范围内文件总数：366；精读：121；机检/脚本解析：237；抽样/局部读取：8；未读：0。
- 逐文件等级、角色、读取原因与 SHA-256 见 [coverage.json](coverage.json)、[scope-files.txt](scope-files.txt)。机器语法、引用、尺寸和散列检查不等于语义理解。
- 范围为通用/营销两条从意图到渲染提交的实际主链、直接宿主/权威合同/控制接缝、原生制作核心及回归/配置。完整上游字节快照另属 B 级，不冒充 3650 个源文件全部精读。
- 未全量精读后期剪辑、发布经营、其他 GEO/内容模块、全部传递依赖及外围创作技能、第三条口播解说执行链、UI 交互和生产部署。选择性深读把工作集中在用户点名的渲染前责任链；外围代码采用机检保留边界。
- 本轮声明范围内未读为 0；局部读取清单与原因如下：

- `engines/video-edit/apps/server/src/runtime/dispatch-routing.ts`：只读取意图入口、供应商映射或运行时身份相关片段；其余代码未作完整语义阅读。
- `engines/video-edit/apps/server/src/trpc/router.ts`：1240-1405; 仅threads.dispatch视频分支及相邻事务/错误路径
- `engines/video-edit/apps/server/src/video/gen/providers.ts`：只读取意图入口、供应商映射或运行时身份相关片段；其余代码未作完整语义阅读。
- `engines/video-edit/packages/video-studio/src/producer-gate.ts`：只检索结构化合同交接相关路径，未作整文件语义阅读。
- `engines/video-edit/packages/video-studio/src/requirement-contract-production-bridge.test.ts`：部分输出被工具截断；未声称精读
- `engines/video-edit/scripts/delivery/evidence.mjs`：仅读取断言执行器、工作树检查和测试观测器证据合同，未精读其余验收工具。
- `engines/video-edit/WORKLOOM_PRODUCT_CONTEXT.md`：为内嵌的历史 2026-09-30.1 上下文副本，仅作差异核对；未读部分不作为产品实现结论依据。
- `src/video-runtime/config.mjs`：只读取意图入口、供应商映射或运行时身份相关片段；其余代码未作完整语义阅读。

# 鹏经理：通用与营销 AI 视频渲染前深度审计

确定实现缺陷与架构方案分别交付：本轮修复既有行为，更大的约束编译、创作中间表示、局部执行器与视觉模式变化按用户要求先写方案，未实施。

## 当前结果与证据等级

A＝代码精读；B＝机器解析、元数据和实际执行记录；C＝局部/抽样；D＝推断或未验证。逐卡源码结论为 A，运行数字为 B；模型效率、艺术收益和未来设计效果为 D。
- 审计基线【B】：`83c76329cb3b82b7096364dbd8dab869f86ab22c`，根仓 GitHub main；任务 [#66](https://github.com/geniusdapeng-collab/geniusdapeng-geo-os/issues/66)，分支 `task/T-2026-1102-0001-video-audit`。
- 本轮 12 张修复卡为 MC-001 至 MC-010、MC-012、MC-013；正式台账当前状态：`{'verified': 12}`。实现/本机回归与正式独立闭环分开记录。
- 正式 MCD 独立闭环：12/12 verified；gate 以真实记录为准。
- MC-011 为明确发现未修的视觉模式设计边界，另有第三路线范围外接线观察，没有悄悄计入已修数量。
- 事实、权利、预算、围栏、资格和未知结果阻断继续保留。未运行付费模型或真实渲染，不能宣称真实产出成功率、等待、成本或艺术质量改善了多少。

## 实际责任链与根因

用户意图经 CLI/MCP、studio.start 或派活进入路由；通用进入叙事准备，营销先形成来源事实与 G1/G2/G3/G4 权威合同，随后进入制作、场景/摄影/音频、逐镜提示融合、字段校验、语义精炼与渲染前门禁，最后编译完整供应商请求，在资格、字节、预算和幂等检查后提交【A】。报告到提交边界结束；render-poller 仅因归档消费者联动修复而读取和回归。
新 DAG、产物、门决定和操作账本已有实现，但当前工作器在 coordinator 非 off 模式仍装配 shadow observer 并调用 studio.runPreproduction。目录、YAML 或 enforce 名称不证明完整新 DAG 已接管实际创作【A】。
逐镜串行融合、内部/快速/分类重试、缺字段补齐和后续语义重写同时存在；多个模型步骤反复携带完整权威资料【A】。这些结构可能放大等待和重做，是工程推断【D】；本轮没有真实调用对照证明收益幅度。

## 12 张修复卡

定位指审计基线；正式状态直接来自台账，不由文档生成器提升。

| 卡号 / 级别 | 触发与影响【A】 | 已实施修复【A】 | 基线定位 / 正式状态 |
|---|---|---|---|
| MC-001 / P1 | 命令首次成功但HTTP响应丢失，沿用原幂等键重试时缺revision、stages或run，恢复中断。 | 首次持久化完整返回快照；历史compact回执只读恢复当前作用域view，不重放动作或覆写历史。 | [原代码](https://github.com/geniusdapeng-collab/geniusdapeng-geo-os/blob/83c76329cb3b82b7096364dbd8dab869f86ab22c/engines/video-edit/apps/server/src/video/pipeline/pipeline-repository.ts#L295)；`verified` |
| MC-002 / P1 | narrative的withRequirementContractScope有scope但无marketing authority，render接缝TypeError导致G3中断。 | scope有authority时用其metadata，否则用当前scope.metadata，保留片型覆盖检查。 | [原代码](https://github.com/geniusdapeng-collab/geniusdapeng-geo-os/blob/83c76329cb3b82b7096364dbd8dab869f86ab22c/engines/video-edit/packages/video-studio/src/requirement-contract-bridge.ts#L76)；`verified` |
| MC-003 / P1 | 实物/有人/旁白及自定义参考、字幕、24fps等任务进入全局抽象静音模板，造成与用户意图和后续门禁冲突。 | 收窄既有归一适用条件，显式参考/声音/风格要求不进替换模板；技术与字幕参数遵循已解析profile。 | [原代码](https://github.com/geniusdapeng-collab/geniusdapeng-geo-os/blob/83c76329cb3b82b7096364dbd8dab869f86ab22c/engines/video-edit/packages/video-studio/src/marketing-prompt-contract.ts#L168)；`verified` |
| MC-004 / P1 | scene-2没有G1许可证时硬编码Apache-2.0，或从待审提示词自举上屏白名单，新增无证据事实。 | 删除无依据许可兜底，仅消费G1提供的source-bound文字，不从候选自身扩权。 | [原代码](https://github.com/geniusdapeng-collab/geniusdapeng-geo-os/blob/83c76329cb3b82b7096364dbd8dab869f86ab22c/engines/video-edit/packages/video-studio/src/marketing-prompt-contract.ts#L352)；`verified` |
| MC-005 / P1 | 节点已经ready但尚未claim，再刷新只记录本轮pending变ready的增量，返回wait_resource和空frontier。 | 从更新后的所有最新节点重建ready快照，保留blocker优先级。 | [原代码](https://github.com/geniusdapeng-collab/geniusdapeng-geo-os/blob/83c76329cb3b82b7096364dbd8dab869f86ab22c/engines/video-edit/apps/server/src/video/pipeline/pipeline-repository.ts#L1159)；`verified` |
| MC-006 / P1 | 结果已获供应商接受，但claim失败默认attempt1继续写盘；输入/输出/终结确认失败仍可能把manifest记done。 | 校验claim回执；任一归档失败保留唯一待对账原结果；未知终态不覆写done，调用方记录恢复路径且不重复外部动作。 | [原代码](https://github.com/geniusdapeng-collab/geniusdapeng-geo-os/blob/83c76329cb3b82b7096364dbd8dab869f86ab22c/engines/video-edit/packages/video-studio/src/archive/stage-log.ts#L43)；`verified` |
| MC-007 / P2 | 确定性回归缺缓存、空缓存或缓存到期后落到线上provider，可能产生意外网络和搜索费用。 | fixture-only未命中直接返回空集，不进入任何线上provider。 | [原代码](https://github.com/geniusdapeng-collab/geniusdapeng-geo-os/blob/83c76329cb3b82b7096364dbd8dab869f86ab22c/engines/video-edit/apps/server/src/video/data-mining-executor.ts#L360)；`verified` |
| MC-008 / P1 | 29→30秒把opening15推16，31→30秒把正式主体min5降4，导致已投影合同随后被原生schema拒绝。 | 绑定本次SceneArchitect实际effectiveSchema上下界，完整候选合法后再投影，无解结构化失败。 | [原代码](https://github.com/geniusdapeng-collab/geniusdapeng-geo-os/blob/83c76329cb3b82b7096364dbd8dab869f86ab22c/engines/video-edit/packages/video-studio/src/requirement-contract.ts#L460)；`verified` |
| MC-009 / P1 | 原生process首次失败后快速重试成功仍保留failed；宿主又漏查degradeReason及已有字段组装fallback，存在误拒/误放两个终态。 | 以本次scoped实际融合成功返回的私有hash证据核销已恢复失败；完整唯一镜号与无fallback都成立才通过；保留原生统计与恢复记录。 | [原代码](https://github.com/geniusdapeng-collab/geniusdapeng-geo-os/blob/83c76329cb3b82b7096364dbd8dab869f86ab22c/engines/video-edit/packages/video-studio/src/vendor-compat.ts#L2038)；`verified` |
| MC-010 / P1 | G3按final-cover分配内容，PRD提示/校验却以final为中心，Studio归一还会把内容再次拉回final；旧容差为5秒，错误窗口与重复计算在边界暴露。 | PRD提示/校验/Studio归一统一prdDurationContract.contentDurationSeconds；母版final与cover独立保留。 | [原代码](https://github.com/geniusdapeng-collab/geniusdapeng-geo-os/blob/83c76329cb3b82b7096364dbd8dab869f86ab22c/engines/video-edit/packages/video-studio/src/prd-authority.ts#L471)；`verified` |
| MC-012 / P1 | 不要营销片/别选营销片/营销片就不做了后明确通用管线，旧显式首命中及商品metadata兜底仍启动营销；非营销投影残留商品情报字段。 | 局部明确否定贯穿显式候选、分数、商品兜底和仲裁；冲突澄清；三线metadata和回执投影一致；保留已确认历史override。 | [原代码](https://github.com/geniusdapeng-collab/geniusdapeng-geo-os/blob/83c76329cb3b82b7096364dbd8dab869f86ab22c/engines/video-edit/packages/video-studio/src/pipeline-router.ts#L232)；`verified` |
| MC-013 / P1 | threads.dispatch对60秒/1分钟等原文仍注入需求口径30秒；rawIntent虽然保留但模型同时看到冲突时长。 studio.start new/existing callers also supplied the omitted field as an explicit 30-second duration.；studio.start 对省略 brief.duration 的默认注入也属于同卡两入口一致性核查。 | 显式profile时长与系统defaultDurationSec区分；只有原文没有时间要求时追加默认；已有/非法/冲突表达保留来源不替用户猜值。 studio.start keeps omitted brief.duration undefined and passes defaultDurationSec separately in both caller branches. | [原代码](https://github.com/geniusdapeng-collab/geniusdapeng-geo-os/blob/83c76329cb3b82b7096364dbd8dab869f86ab22c/engines/video-edit/packages/video-studio/src/pipeline-router.ts#L612)；`verified` |

## 发现未修及方案边界

1. **MC-011：无图抽象任务与视觉授权适用性冲突【A/B，发现未修】。** prepareMarketingFacts 的真实来源/模型替身/装订/落盘夹具可接收无商品图的抽象任务，但显式 product 使 extractProductVisualAuthority 要求 A1 图片。只把 required 改 false 会跳过后续外观保护，不能作为安全修复。需要贯穿 G3/G4/G6 的无外观/真实外观模式及禁止凭空生成外观的合同；按用户先对齐大方案的要求保留现状。
2. **第三条口播解说路线【C，范围外观察】。** 独立 studio 与 threads.dispatch 的执行器衔接不同，dispatch 仍可能按 narrative 启动。路由标签/metadata 连带一致性修复不等于第三线完整执行器已验收，本轮未扩大为第三线架构改造。
3. **模板化与自然语言边界【A/D】。** 明确人物/实物/旁白、参考/颜色、音乐/音效/转场/节奏等已测试方向得到保护；没有自定义方向的特定抽象任务仍可能使用既有模板。否定及时间解析覆盖有限表达，不宣称理解任意自然语言。
4. **证据容量与长期效率【A/D】。** 来源正文、整包提取和 G1 的容量边界不同，多篇长正文仍可能停止。后续应设计预算感知的证据选择/分块核查，不通过删原文冒充完整核实。长期吞吐、超时分布与真实营销效果未测试。

## 建议对齐的方案

详细文档：[约束编译与局部创作方案](../../../docs/audits/2026-11-02-video-pipeline-design.md)。含三个具体场景、候选 A/B/C、P0/P1/P2、数据/索引、接口/错误、并发/预算/未知结果、灰度和回滚。
建议选择 B：一次编译带来源和适用范围的权威约束，把全片必须覆盖的信息分配到具体镜头，在可行空间生成少量创意候选；机器合同、事实语义和艺术排序分层，局部错误只修字段或镜头及其受影响闭包。确定缺陷修复作为前置，便宜创意层可按预算探索少量候选，不直接重写 vendor 或更换供应商。
这样保留严格事实和授权，减少每镜同时承受所有 N 个限制、重复自然语言解释和单字段失败引起整阶段重做。收益仍须本系统离线基准及获授权真实对照证明【D】。方案未实施，等待用户对渐进方向、约束分层、无外观模式与灰度范围对齐。

## 验证矩阵

每卡的前置/触发、可执行步骤、预期在 ledger.assertions；正式运行实际结果、完整提交、角色、时间和 hash 在 runs/evidence。以下是代表场景，不把摘要冒充全部用例全文。

| 维度 | 前置及步骤 | 可判定预期 | 覆盖 |
|---|---|---|---|
| 正常 | 合法通用/营销合同、当前 G1 与 profile，跑实际 Studio/原生 process 接缝 | 保留语义和来源，合法恢复不被旧计数误拒 | 002/003/004/009/010 |
| 边界 | schema 上下界、25 秒内容+5 秒封面、画幅/fps/字幕与明确时长 | 不越 schema，不重复封面，不注入冲突默认 | 003/008/010/013 |
| 错误 | 注入 claim、输入/输出、finish 与融合重试失败 | 不覆盖旧 attempt、不虚标 done、不将 fallback 当成功 | 006/009 |
| 权限/事实 | 当前 authority、篡改/历史 hash、无许可证据 | 不自授权，不添加许可，不放宽资格与事实 | 002/004及提交边界 |
| 并发/恢复 | 隔离 PG，六方法新旧回执、重复 refresh、并行根节点 | 回执完整、无重复 outbox、不丢 ready，blocker 优先 | 001/005 |
| 路由 | 明确否定与商品锚点、两入口明确/省略时长，实际投影 | 被排除路线不被兜底选回，60 秒不被默认 30 秒覆盖 | 012/013 |
| 网络隔离 | fixtureOnly 与测试 key，缺/空/过期/无关/不足 limit 五类夹具 | 0 线上 fetch | 007 |
| 回归 | 固定源码/官方 UI 原包，原仓套件、构建、类型及秘密扫描 | 失败停止，skip/替身证据如实列出 | 验证摘要 |

## 实际测试统计【B】

从实际日志读取当前汇总；不同套件有重复测试，不相加为独立样本。空类型检查日志的通过来自协调者实际退出记录，文档生成器不补造 subprocess 退出码。冻结后有源码变动时，须更新受影响检查。

| 检查 | 实际记录 | 证据 |
|---|---|---|
| 根仓 Node 单元/集成 | 487/487 通过；跳过 0 | [日志](validation-logs/root-final-tests.log) |
| 渲染前原生合同/恢复最终工作流 | 1160/1160 通过 | [日志](validation-logs/native-final-workflow.log) |
| 完整资格/编译/提交边界 | 271/271 通过 | [日志](validation-logs/submit-boundary-tests.log) |
| 原生身份/岗位/技能宿主 | 145/145 通过 | [日志](validation-logs/native-host-regression.log) |
| GEO 与整合引擎 | 14/14 通过；跳过 0 | [日志](validation-logs/geo-tests.log) |
| 后期桥 Node 媒体 | 76/76 通过；跳过 0 | [日志](validation-logs/vendor-tests.log) |
| 后期/封面/并发修订 | 74/74 通过 | [日志](validation-logs/vendor-tests.log) |
| 原生工具与运行时 | 12/12 通过；跳过 0 | [日志](validation-logs/native-tools-tests.log) |
| 词级 ASR 兼容 | 9/9 通过；跳过 0 | [日志](validation-logs/native-asr-tests.log) |
| 官方 UI 原包安装边界 | 158/158 通过；跳过 0 | [日志](validation-logs/ui-bootstrap-tests.log) |
| 部署安全与恢复 | 37/39 通过；跳过 2 | [日志](validation-logs/deployment-tests.log) |
| industry-contract 构建 | 构建日志及协调者退出记录通过 | [日志](validation-logs/native-contract-build.log) |
| 原生工作台构建 | 构建日志及协调者退出记录通过 | [日志](validation-logs/native-web-build.log) |
| 原生 server 类型 | 协调者报告 exit 0；无诊断 | [日志](validation-logs/final-server-typecheck.log) |
| video-studio 类型 | 协调者报告 exit 0；无诊断 | [日志](validation-logs/final-studio-typecheck.log) |
| 根仓冒烟 | 健康/控制台/GEO/媒体入口均 200 | [日志](validation-logs/smoke.log) |
| 暂存范围秘密扫描 | 扫描 4046 文件；ok=True | [日志](validation-logs/final-staged-secret-scan.log) |
| 完整引擎字节清单 | 源 3650 + 宿主 66 文件字节校验 | [日志](validation-logs/snapshot-verify.log) |

完整统计、状态与日志 hash：[validation-summary.json](validation-summary.json)。官方 UI 安装测试不代表视频生产效果；构建的大块体积提示和 vendor-load 测试中的模拟/缺生产配置提示保留，没有据此宣称真实供应商被调用。
环境为 local-preview：独立 PostgreSQL、本机文件与实际原生代码，模型/网络由受控夹具提供。付费模型、生图、生视频和公网经营发布均未执行；人工搭桥：**未使用**。RDAS 276 项全仓及 P 域生产任务没有运行，不能称生产验收通过。

## 源码、验收与云端回执

| 项 | 当前值 |
|---|---|
| 审计基线 | `83c76329cb3b82b7096364dbd8dab869f86ab22c` |
| 修复源提交 | `0c5e5bb188d9562d32365578d7647b9ae0fdf9d6` |
| 正式验收提交 | `0c5e5bb188d9562d32365578d7647b9ae0fdf9d6` |
| 证据提交 | `pending` |
| GitHub PR | `https://github.com/geniusdapeng-collab/geniusdapeng-geo-os/pull/67` |
| main 合并 SHA | `pending` |
| 云端 CI | `pending` |
| main 回读 | `pending` |
| MCD gate | {"ledger": "/Users/mac/Documents/Codex/2026-11-02/edit-ai-n-n-ai-github-2/work/pengmanager/outputs/mine-clear/T-2026-1102-0001/ledger.json", "ok": true, "errors": []} |

正式 MCD 在固定、干净的修复源提交执行；之后证据目录提交须核对非证据树不变，云端 CI 绑定实际候选/主干。报告生成、推送或开 PR 不代表合并完成。代码合入也不证明运行进程已重启到该版本。
回滚用普通 revert PR，不改写历史，不删除已接受/未知供应商回执与费用记录，不因代码回滚重提付费任务。

## 收尾报告

- 已完成：两条渲染前主链核心精读和文件覆盖清单；12 张确定缺陷卡实现修复、失败反例及本机回归；独立反例审查；必要调用方、CI、overlay/字节清单联动；详细架构提案。正式闭环和云端结果只以上表真实状态为准。
- 未完成/未覆盖：当前 pending 的正式闭环/提交/PR/CI/main 回读仍属发布工作，不能据此交卷为已发布；MC-011 与更大架构按用户要求待对齐；第三线完整执行器、外围技能全量语义、真实模型质量/速度/成本与生产媒体未验证。
- 自主追加事项及理由：fixture 搜索隔离、两入口时长/路由、两个归档消费者、CI 真实 PG、source pin 与目标摘要维护，均为主链正确性及可复跑所必需。
- 采用的假设：保持既有事实、权利、预算、围栏和资格语义；本次云端发布按根仓 GitHub 普通 PR 合并并回读 main；不把源码合并当进程部署或付费生产验收。
- 置信度：已修确定行为高，依据源码、实际失败反例和回归；正式验收以台账为准。整体创作效率及艺术收益仍待验证，不作数字承诺。
- 建议复核：MC-009 真/假融合恢复；MC-003 意图与模板适用范围；方案第 4/5/7 节约束分层、信息分配和局部修复。

## 自检表

- [是] 覆盖声明包含本轮全部范围、精读/机检/局部及范围外边界，没有把机检冒充理解。
- [是] 必要修复、联动与发布由工程继续推进，不把可完成事项推给用户；大方案按明确要求待对齐。
- [是] 结论、统计和回执有可复跑来源，A/B/C/D、真实/夹具与已完成/pending 边界明确。
- [是] 核心修复有独立反例审查与回归，保留正式门禁、云端回执和回滚边界。

# 视频约束编译、逐镜创作与局部修复

本说明面向维护视频工位的工程人员和本机操作者。实现任务为 `T-2026-1103-0001`，沿用本仓固定的完整视频引擎；没有升级上游 vendor、引入新模型供应商或替换现有生成资格。

## 适用场景与主流程

这套实现处理三类常见任务：明确不展示产品外观的抽象营销片；具有当前实物和人物授权的营销片；具有明确时长、画幅、声音与字幕要求的通用叙事片。目的在于先定位不可行合同，再创作和局部返修，保留已完成的合法成果与真实费用记录。

`off` 使用既有流程。`shadow` 仅编译约束并观察既有执行，不额外启动一条付费创作链。`enforce` 在项目执行租约内绑定不可变合同、实际阶段产物和请求账本，接入原生 Phase1、Phase2、逐镜 Phase3、Phase3.5 及后续现有语义/生成资格。实际启用仍受 `PIPELINE_COORDINATOR` 和 `PIPELINE_SCOPE` 限制；代码合并不会自动修改运行环境。

1. 保存客户原文和 metadata 的完整字节来源，编译带作用域、来源引用、责任阶段及允许修复范围的约束。
2. 核对最终/内容/封面时长、原生镜头上下界和交付规格。冲突返回 `blocked`；缺当前营销事实返回 `needs_input`，不能提前开始镜头创作。
3. 当前 G1 完成后，由私有桥绑定真实原件与通过证明。全片覆盖要求分配到具体镜头；可用事实不会自动变成每镜必说的信息。
4. 每镜调用实际原生融合入口。原生隐藏补齐与整包精炼在这个受控视图内关闭，由统一的局部返修策略处理字段问题。
5. 确定性编译实际字段与技术规格，保留创作语义；后续现有事实、权利、围栏、预算和完整请求资格仍需通过。

营销候选在当前 G1 通过后可先行起草、独立评审和排序，再进入正式创作；公共候选接口可在同一执行租约内准备 G1。进入真正原生融合时使用的是同一合同下的已审核创作方案；候选本身不签发渲染资格。

P0 是合同、可行性、视觉模式、底层费用、局部 diff、请求冻结和未知结果保留；P1 是受控缓存、候选独立评审排序、恢复和可解释记录。P2 只提供评价与灰度分析工具；没有真实基线时不自动学习或调低门槛。

## 合同与视觉边界

`CreativeContract` 包含项目作用域、revision/hash、客户原文、原 metadata、当前事实、交付 profile、分层约束、可行性与覆盖矩阵。客户显式要求和来源事实属于硬边界，艺术六维目标属于软排序，实际媒体画质保留为渲染后待测。原生派生 profile 与客户显式值不一致时返回冲突。

`abstract_without_product_appearance` 需要原始意图中的明确禁止外观要求及对应结构化证据；G1/G3/G4/G6 和生成资格继续约束不得引入产品外观。`verified_product_appearance` 继续要求实际外观授权和参考。`no_named_product` 不能删除已声明产品的授权责任。抽象模式只改变实物外观检查的适用性，不代表没有旁白、人物、字幕、音乐或其他权利要求。

`CreativeShot` 保存稳定镜号、来源 hash、合同 hash、信息任务、已授权 claim、主体/动作/声音、实际原生字段及其顺序。覆盖 ID 表示责任分配，不能代替独立语义审查，也不能用字面包含测试拒绝合法改写。

## 执行、存储与恢复

继续使用 `video_pipeline_runs`、`production_stage_runs`、`video_artifacts`、门决定、修复计划和 `video_pipeline_operations`。迁移 `0062_video_creative_contracts.sql` 增加合同修订、run/contract 绑定、G1 证明、候选和幂等回执；这些新表只追加，使用作用域外键与 RLS。

创作 JSON 以内容 hash 写入项目档案的 `artifacts/creative/`，数据库保存真实字节数、hash 和标准 ArtifactEnvelope。读取校验普通文件、大小、路径与字节；缓存键覆盖作用域、完整合同、实际上游、schema、模型、提示/策略及配置。缓存命中重新核对当前合同和来源，不授予旧审批或旧费用状态。

局部自动修复每镜最多两次，只能修改 finding 允许的真实路径。宿主比对实际 diff，拒绝修改原文、事实、镜号、资产授权和未点名镜头；同一失败无进展时停止。受控 API 修复使用当前决策、stage revision、计划 hash 与依赖闭包做 CAS。新产物保留为待独立复核，不能凭“补丁已写入”取得生成资格。

项目执行使用既有跨进程租约；候选、修复与工作器不能并行占用同一项目。重复幂等键读回原结果；改参数复用键被拒。已派发而没有可信回执的请求在重启后继续保留，不能重跑付费步骤来补回执。

生成资格和提交分别核对已完成的创作 run、当前合同、最终阶段实际文件和同一份提示词包摘要。已存在的供应商任务仍按原回执补账。对抽象营销的方舟 Seedance 参考生视频，可选用 `production.shots` 列出的 `portrait:sha256:…` 角色凭据。服务要求当前主机认可的合成角色复用清单及来源档案，并重读版本与四角度复制件的实际字节，再编译为供应商参考图。普通 G5 通过、真人图片、自由外链和商品图均不能取得这种凭据。适配器发送冻结的请求体，不会按客户端再次组装。

## 四个认证接口

接口挂在当前 `video.studio` tRPC 路由，作用域从真实登录身份和工作区成员关系取得，客户端不能提交租户或 workspace 权限。

| 方法 | 必需输入 | 结果与主要失败 |
| --- | --- | --- |
| `compileIntent` | projectId、rawIntent、expectedRevision、idempotencyKey；可选 metadata | 不可变合同、可行性及冲突；活动运行或 revision 冲突时拒绝 |
| `creativeCandidates` | projectId、contractHash、count=1..3、idempotencyKey | 同合同下真实起草和独立评审、候选产物与硬合法排序；无启用范围/可信预算/当前 G1 时拒绝 |
| `repairPreview` | projectId、decisionId、targetId、expectedStageRevision、idempotencyKey | 当前可修字段、禁止字段、完整失效闭包及剩余次数；来源过期或无安全局部修复时拒绝 |
| `applyRepair` | projectId、repairPlanId、planHash、expectedStageRevision、完整 patch、idempotencyKey | 新 revision、真实 diff、失效节点、`nextAction=review`；越界、无进展、CAS 冲突明确返回 |

艺术排序只接纳同一硬合同通过、同一模型另一次独立请求审查、候选/提示 hash 均匹配的结果。六维为信息可读性、钩子兑现、情绪推进、画面差异、品牌契合与新颖性。艺术高分不能抵消事实或合同违规。

## 预算、评价与回滚

模型请求必须配置可信的 `VM_CREATIVE_MODEL_PRICES`，格式为 `{ "实际模型名": { "inputCnyPerMillion": 正数, "outputCnyPerMillion": 正数 } }`，并配置 `VM_CREATIVE_BUDGET_CNY`、`VM_CREATIVE_MAX_CALLS`、`VM_CREATIVE_MAX_TOKENS` 和 `VM_CREATIVE_MAX_WALL_MS`。这些是受控运行配置，不是客户 metadata。不能为跑通流程编造价格或缩小已有模型输出窗口。

每次底层文本请求在出网前预留完整输入和输出上界，正常回执按实际 usage 结算；缺失、越界、超时或写回失败保留未知费用并冻结后续请求。付费搜索和新图像请求也进入同一项目账本。`VM_CREATIVE_EXTERNAL_PRICES` 是按 `search` / `media` 分组的固定费表，组内用实际检索适配器标识或图像模型名作为键，值为每次已核定的正数人民币上界。缺少当前供应商配置时停止出站。预算不证明业务围栏和供应商授权，二者仍需分别满足。

只读评价入口位于 `engines/video-edit/scripts/tools/creative-evaluate.mts`，支持 `metrics`、`shadow` 和 `rollout`，输入为已获授权、脱敏且绑定真实回执的 JSON。指标覆盖首次硬合同通过、预算内完成、非客户改需求的人工介入、p50/p95、所有失败消耗、未知费用、阶段重做、硬门误放/误拒和盲评。空分母保持 null。真实艺术比较每路线至少 30 个授权盲评对；本机供应商协议替身不计真实艺术或费用收益。

灰度可先选 `PIPELINE_COORDINATOR=shadow`，再按 `PIPELINE_SCOPE=marketing|narrative|all` 的实际路线范围切换；默认 `off`，不自动推进。回滚把新任务切回 `off`。在途任务保留已固定合同/计划并明确停止或继续，不能半途混用执行器；已完成媒体、已派发/未知请求和历史费用不删除。数据库采用扩展式迁移，不执行破坏性回滚。

实现不承诺渲染前识别所有表演/画质问题、不取代素材授权、不保证转化、不自动扩大预算，也不把本机离线测试称为生产出片验收。运行配置、迁移、构建和实际部署仍按 [AI Agent 指南](AI-AGENT-GUIDE.md) 与 [视频运行时说明](VIDEO-RUNTIME.md) 执行。

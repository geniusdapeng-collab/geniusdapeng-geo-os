# Video Pipeline Control Plane Hardening · MCD Report

## 0. 本轮基本信息

| 项 | 值 |
|---|---|
| 任务号 | `T-2026-1030-0002` |
| 分支 | `task/T-2026-1030-0002-real-case` |
| 审计基线 | `3951b7d3e13eeba315e599ad50c17486d112a6bc` |
| 修复 / 验收基线 | `50e232cb41cedb9bb9c13c795b7695d890ebf47b` |
| 环境 | `local-preview`；真实本机 PostgreSQL 17，不提交渲染或供应商任务 |
| 目标 | 统一 13 条管线目录，拆分纯 gate 与副作用 action，补齐 artifact 闭包、operation ledger、feature flag 和并发/恢复断言 |

## 1. 覆盖率声明

- 范围内文件总数：39；精读：15；机检 / diff / 定点解析：24；抽样：0；未读：0。
- 精读：catalog、compiler、adapter、feature flag、operation repository、真实 PG 测试、
  stress harness 和 hardening 文档等核心实现文件。
- 机检 / diff：7 条迁移管线 YAML、`.env.example`、router/shadow/command service 接线、
  schema/types、兼容测试、自动审批文档、pin 与 snapshot 生成物。
- 未读 / 抽样清单及原因：无。
- 补充依赖：读取了 `artifact.ts`、state machine、0054–0060 迁移关系和 reconciler/query
  调用链，用于确认 operation、manifest 和恢复语义；这些不是提交改文件，未计入上述 39。

## 2. 问题与修复

| ID | 级别 | 状态 | 修复 |
|---|---|---|---|
| MC-001 | P0 | verified | 跨 bundle catalog 编译 13 条管线，统一 gate registry、policy 覆盖、wait/call cycle 和 child target 校验 |
| MC-002 | P0 | verified | 每节点 required output slot 全部入 manifest；artifact parents 必须精确覆盖递归 ancestor input closure |
| MC-003 | P0 | verified | 编译器拒绝 gate/action 混型；新增 durable `reserved → dispatched → accepted|failed|unknown` operation ledger、真实 PG 并发和恢复断言 |
| MC-004 | P1 | verified | `PIPELINE_COORDINATOR` 成为唯一 canonical flag；旧变量只有同值兼容，冲突/非法值 fail closed |
| MC-101 | fix | verified | 总收口卡覆盖上述四张问题卡；三套 TypeScript、完整 catalog、真实 PG 与 stress 均通过 |

终态 operation 的 receipt、cost、error、external id 和时间戳不可改写，operation 行不可删除；
`failed/unknown` 立即释放 run lease，`accepted` 保留 lease 至真实产物提交。

## 3. 验证矩阵

| 检查 | 实际结果 |
|---|---|
| `pipeline-control-stress.sh --mode all --plans 13 --cases 64` | 通过；13/13 管线、64/64 DAG、762 节点、50×8 worker 竞争、50 unknown reconcile、真实 PG 与三套 typecheck |
| 真实 PG 断言 | 5 个测试文件 18/18 通过；包含输出槽位、递归闭包、operation receipt、终态不可篡改与 lease 恢复 |
| video-pipeline + pipeline-control 包 | 9 文件 56/56 通过 |
| engine server 全量 | 73 文件 1374 通过、193 skipped；skipped 为无外部环境/平台依赖项 |
| 根仓 Node 测试 | 487/487 通过 |
| vendor 真实媒体回归 | 74/74 通过 |
| GEO / integrated engine | 14/14 通过 |
| smoke | health/dashboard/GEO/media 均 200，账号 16、内容 120 |
| security scan | 3999 文件，0 问题 |
| bundle governance | AI Video / GEO Growth 资产索引与包摘要刷新后通过 |
| CI 失败复现 | 原失败步骤修正后 Vitest 145/145、Node 工具 12/12、Python ASR 9/9 |
| snapshot / pin | 上游 `a544ab8b068790bfb14b7977efc81b33897fc9de`，3650 文件、336,706,560 字节，pin 与快照字节一致 |

## 4. 证据分级

- **A**：核心代码精读、真实 PostgreSQL 状态迁移、并发竞争、failure/unknown recovery、真实字节与 hash 断言。
- **B**：全量 Node/Vitest、vendor 媒体、smoke、security scan、snapshot/pin 校验、三套 TypeScript。
- **C**：未使用。
- **D**：生产部署、真实供应商渲染、RDAS 276 项与长期 SLA 未在 `local-preview` 执行。

## 5. 未闭环与边界

- P0/P1 问题：0。
- RDAS 276 项全仓真机验收：未执行；本轮只交付 MCD 的 `local-preview` 结构与本机实测证据。
- 真实模型、渲染供应商和公网发布：未调用；stress 明确不提交渲染任务或供应商回调。
- 生产环境仍须按 RDAS `client-runtime` / `deployed` 档位另行取得真实回执。

## 6. 收尾报告

- 已完成：源码修复、文档、迁移、真实 PG 压测、全量与根仓回归、smoke、秘密扫描、snapshot/pin、MCD repair 与独立 acceptance。
- 未完成/未覆盖：RDAS 276 项、生产部署和真实供应商任务。
- 自主追加事项及理由：补上 terminal receipt 不可篡改与 failed/unknown lease 释放，避免“状态为失败但 worker 仍占锁”及终态回执被覆盖。
- 采用的假设：本任务以控制面结构和真实本机 PG 为交付边界，不触发付费/外发副作用。
- 置信度：高。五个 MCD 卡均有独立 acceptance 运行记录并绑定完整提交。
- 建议复核：`0061_video_pipeline_operations.sql`、`commitArtifact` 的递归闭包、`pipeline-control-stress.sh` 的全量矩阵。

## 7. 自检表

- [是] 覆盖了任务全部范围，而非挑了容易的部分？
- [是] 没有把可自主完成的事项推给用户，没有以不必要的问句收尾？
- [是] 每个结论/每段代码有依据、可验证、证据等级标注准确？
- [是] 经得起资深工程师逐行审查？

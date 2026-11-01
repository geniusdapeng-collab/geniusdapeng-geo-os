# 视频管线控制面硬化契约

## 1. 计划目录

所有 shipped pipeline 必须能同时通过：

- gate ID 存在于 `VIDEO_GATES`；
- gate ID 被 `VIDEO_SYSTEM_AUTO_APPROVAL_POLICY` 覆盖；
- 无运行期 wait-cycle；
- 所有 `subgraph` call 都有可解析 child plan；
- call graph 无环。

`scripts/tools/pipeline-plan-stress.mts` 是目录属性断言器，
`packages/video-pipeline/src/test/catalog.test.ts` 是 CI 常驻回归。

## 2. Gate 与 Action

`gate` 是纯裁决节点，只能消费现有输入并传递同一角色/schema。任何会生成新产物
或调用 model/provider/public 的步骤必须拆成两个节点：

```text
pure gate → action stage
```

编译器以 `PIPELINE_PLAN_GATE_ACTION_AMBIGUOUS` 拒绝旧写法。调用方必须先取得
passed GateDecision，再 claim action stage。

## 3. Artifact 闭包

- 每个 stage 的全部 `required` outputs 必须各提交一个 role/schema 精确匹配的 artifact。
- artifact 的 parents 必须精确覆盖该节点全部祖先 stage 的当前输出闭包。
- input manifest 在 claim 时冻结；commit 时重新计算，任何漂移即
  `PIPELINE_INPUT_CLOSURE_MISMATCH` 或 `PIPELINE_INPUT_MANIFEST_MISMATCH`。
- gate decision 必须绑定目标 stage 的完整 input+output manifest，而不是单个主产物。

## 4. 外部 Operation

provider/public action stage 在提交产物前必须存在 accepted operation receipt。

```text
reserved → dispatched → accepted | failed | unknown
```

- `accepted` 仍要求随后提交真实产物；
- `failed` 进入 repair；
- `unknown` 进入 reconcile，禁止自动重派；
- operation key 在 stage 内唯一，idempotency key 在 workspace 内唯一；
- `accepted/failed/unknown` 的 receipt、cost、error、external id 与时间戳进入终态后不可改写，
  operation 行不可删除；纠正只能追加新的 operation 与 outbox 事件；
- `failed/unknown` 立即释放 run lease，`accepted` 保留 lease 直到真实产物提交；
- 所有状态变化写 `video_pipeline_operations` 和 outbox 事件。

## 5. Lease 与对账

- 每阶段 claim 使用 run revision + stage revision 双重 CAS；
- artifact commit 成功后原子释放 lease；
- 中断/未知必须进入 reconciler，执行者不能凭客户端推测完成；
- `PIPELINE_COORDINATOR` 是唯一 canonical flag；
- 旧 `PIPELINE_CONTROL_PLANE` 只有同值时可兼容，冲突或非法值 fail closed。

## 6. 压测门槛

```bash
zsh scripts/tools/pipeline-control-stress.sh --mode all --plans 13 --cases 64
```

通过条件包括：13/13 计划编译、0 gate 覆盖缺口、0 wait/call cycle、64 个合成
DAG 无死锁、50 个并发 run 的 8-worker 竞争每 run 只有 1 个 winner、50 个
unknown operation 全部进入 reconcile，以及三套 TypeScript 类型检查通过。

# 鹏经理本机视频制作入口

`pengmanager.video.intake` 帮助 Agent 找到本机流程并冻结题目、系统和时长。拥有私有视频运行时的本机 owner 才能用下列命令推进真实项目。沿用[本机视频工位安装、真实模式和现有模型配置](CODEX-VIDEO-QUICKSTART.md)。已有同项目的原片或供应商任务时，优先沿该项目读回和核验。

```sh
# PM_NODE 是已核验的 Node 24+，PM_MODEL_ENV 是既有私有进程配置。
# PM_BRIEF 是仓库外的私有 JSON，包含 system、intent 和 durationSeconds。
"$PM_NODE" scripts/pengmanager-video-make.mjs identify < "$PM_BRIEF"
"$PM_NODE" --env-file="$PM_MODEL_ENV" scripts/pengmanager-video-make.mjs start < "$PM_BRIEF"
"$PM_NODE" --env-file="$PM_MODEL_ENV" scripts/pengmanager-video-make.mjs status "$PM_MAKE_ID"
"$PM_NODE" --env-file="$PM_MODEL_ENV" scripts/pengmanager-video-make.mjs resume < "$PM_BRIEF"
"$PM_NODE" --env-file="$PM_MODEL_ENV" scripts/pengmanager-video-make.mjs deliver < "$PM_BRIEF"
```

`system` 取 `pengmanager`，`intent` 保存用户的完整原话，`durationSeconds` 为 5–180 的整数。`identify` 只返回请求摘要与可重算 ID。其余命令默认使用 `PENGMANAGER_VIDEO_DATA_DIR` 指定的私有运行时，或者用末尾的 `--data-dir <实际目录>` 选择本机实例。通过 stdin 传请求，避免在命令参数与普通日志中复制完整简报。恢复原项目时使用相同字节的 `intent` 和同一时长。

## 已授权的执行边界

当前私有运行时的 `video-make-authority.json` 保存 owner 已确认的请求范围和原生执行设置。该文件位于仓库外，并使用仅 owner 可读写权限。业务对话、HTTP Agent、intake 和生成模型都没有授予这个权限的入口。当前项目已审过的真实模式、素材授权、价格和预算可以复用，只有未具备或不匹配的项才需要准备。

文件 schema 为 `pengmanager.video-make-authority/v1`。在 `approvedRequests` 数组中，每条记录包含：

| 字段 | 使用的值 |
| --- | --- |
| `intentSha256` 和 `durationSeconds` | `identify` 的同一条记录 |
| `validUntil` | 授权失效时间，ISO 8601 |
| `metadata` | 本次实际批准的原生 Studio metadata，如平台、商品、已核实的事实源与制作要求。入口加入和请求一致的时长。 |
| `creative` | `maxCny`、`maxCalls`、`maxTokens`、`maxWallMs`。本机配置仍须开启原生执行协调器，并在这里的界限内提供实际模型价格和额度。 |
| `render` | 当前原生模型目录的 `modelId`、真实供应商版本 `providerModel`、本次视频估算总上限 `maxEstimatedCny` 和原生参数 `params`。渲染时仍按实际镜头重新报价。可在 `referenceSelection` 指定已授权的 `character:{characterId,angle}` 和 `productId`，入口从本次原生镜头档案精确解析对应参考图。 |
| `post` | 本次后期要求。含 `title`、`platform`、`aspect`、`resolution`、`fps`，以及适用的色彩、字幕、封面、音乐。画幅与渲染计划一致。 |
| `portraitManifest` | 可选。当前运行时下既有 owner 角色和商品参考资产清单的文件名。复用仍由原生服务验证授权、作用域和当前文件。 |

不同系统的定妆库、模型价格与权限不可互换。该入口不会试调模型、自动激活真实模式或代批原生围栏。存在多个匹配授权、已过期、请求字段不符、片型不明确或当前报价缺失时，返回具体阻断。口播解说片使用原生专用链路，避免把稿件和配音变成普通镜头任务。

## 回执与恢复

- 初次 `start` 根据现有原生规则免费判断片型，完成只读预检后把请求摘要和待发送记录写入 owner 私有目录，再调用 `video.studio.start`。同样的请求重新执行只读取已有项目。
- `status` 读已有本机回执和当前原生项目、运行、档案。审批、未知用量、未核实的完成回执分别保留。
- `resume` 只对同一请求绑定的失败或中断执行提交原生恢复。服务再次核验原合同、项目租约、审批与待对账费用。更改授权或费用配置后，旧回执需要先核对。
- `NATIVE_MUTATION_OUTCOME_UNKNOWN` 表明发出前的回执已落盘，原生服务响应未可靠确认。按原工作区核对已有项目和账本，保留原回执。重复调用不会再次提交。
- `render_ready` 记录真实 project/run、当前档案尝试和镜头 SHA。入口在同一授权下将它交给正式渲染与后期。`deliver` 仅接续已有回执对应的项目，先查该项目的原任务，未知供应商结果继续保留。只有正式后期回读得到真实可播放母版和检查记录才返回 `delivered`。

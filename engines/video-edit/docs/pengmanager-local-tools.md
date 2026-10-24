# 鹏经理独立本机工具

本目录包含完整原生引擎及目标系统的独立适配。运行时使用鹏经理自己的 PostgreSQL、工作目录、桥接端口、Python 环境和公开模型文件，不复用源工程的服务或私人声音档案。依赖安装、进程健康、业务调用和产出验收分别留证；目录存在或健康检查通过不能代替生成结果验证。

目标入口是 `scripts/pengmanager-tools.mjs`。它在进程内返回桥接环境，命令行输出会去掉该环境中的令牌。默认自有数据位于 `~/Library/Application Support/PengManager/video-runtime`；本地日志和安装回执属于运行数据，不随源码提交。停止只作用于此监督器拥有的子进程组，端口被其他进程占用时会报错。

## 固定模型与 ASR 路径

公开依赖在 `pengmanager-toolchain.lock.json` 中固定，安装器逐文件核对官方大小与 SHA256 / Git blob。当前本机 TTS 是 `mlx-community/OmniVoice-bf16`；CPU 普通话工位是另有精确 pin 的 Kokoro；ASR 采用同一 Whisper Large V3 Turbo 的官方 MLX Community 4 位量化版本。量化会改变数值精度，转写内容仍须按业务要求校对，不能把模型版本视为准确率保证。

ASR 模型 pin 是 `mlx-community/whisper-large-v3-turbo-4bit@0f058d38170d183f9fdee07908f5b515d91793a8`，官方 `model.safetensors` 为 463462982 字节、SHA256 `e2d6146b49644c13ed7467060d3c43c402bbdfca1f01f1c21f6fbeda23b6567e`。选择此版本的依据是这台 8GB Mac 上同一自有合成音频的原生与官方 HTTP 实测。没有放宽验收请求的 180 秒限制，也没有关闭词级对齐。完整精度模型曾超时，该失败记录保留在验收材料中。

`mlx-whisper==0.4.3` 的本地加载器要求 `weights.safetensors` 文件名。安装器在自有模型快照内创建同字节硬链接，核对两个名称均指向官方相同内容，并在安装回执中记录 `compatibilityAliases`。原始官方文件与来源保持原样。链接不是外部文件系统依赖，重新安装会检查已存在内容，错误文件或符号链接会被拒绝。

鹏经理设置 `TALKCRAFT_ASR_MODEL`、`WL_TALK_ASR_MODEL` 和 `WORKLOOM_VOICE_ASR_MODEL` 为当前固定模型，解释片的词表助手显式选择自己的 HTTP 服务。精剪 CLI 默认优先使用已配置的本机 HTTP 引擎；显式 `--engine local` 保留原生 mlx-whisper 路径。两种 HTTP 调用都会请求 `word_timestamps=true`，按照真实返回写入 `precision=word`；旧服务只返回句级时仍写 `precision=segment`，不把句内插值当作词级测量。无效时间戳或部分句子缺少词级数据会报错。

安装状态只在回执与当前 pin、快照路径、所需常规文件、大小和已记录的官方权重 SHA 一致时标为依赖就绪。状态检查不逐次重跑模型，也不声称生产结果已验收。真实转写验收还要检查文本、时间范围、精度和当前文件散列。

## 安装和许可边界

执行 `node scripts/pengmanager-tools.mjs setup` 安装完整本机工具；`setup --tool voice` 会按固定清单下载公开模型并检查依赖。`--skip-models` 只跳过模型下载，不能让缺失或旧版本回执变成当前模型已就绪。

Compositor、FFmpeg、调色、BGM、字幕、后期、配音、白板和口播引擎都保留各自许可。TalkCraft 的非商业评估可以安装和实测；商业生成要求明确的授权范围和实际非空常规 `LICENSE-GRANT.md`，软件不会生成授权证明。声音克隆也需要实际授权，公开 TTS 模型安装不代表获得任何人的声音同意。

官方来源：[MLX Whisper API 与词级时间戳](https://github.com/ml-explore/mlx-examples/tree/main/whisper)、[MLX Community 4 位模型卡](https://huggingface.co/mlx-community/whisper-large-v3-turbo-4bit)、[固定模型文件元数据](https://huggingface.co/api/models/mlx-community/whisper-large-v3-turbo-4bit/revision/0f058d38170d183f9fdee07908f5b515d91793a8?blobs=true)。模型卡声明 Apache-2.0，其他组件以本地锁和各自许可证为准。

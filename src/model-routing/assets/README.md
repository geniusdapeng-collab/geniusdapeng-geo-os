# DeepSeek tokenizer

The host and embedded video runtime share the pinned official V4.1 Flash 1017
tokenizer and prompt planner in
[packages/base/model-router](../../../engines/video-edit/packages/base/model-router/deepseek-window.mjs).
The shared planner verifies the asset's SHA-256 before counting. Its local
estimate and reservation bound are separate from the provider's actual usage.

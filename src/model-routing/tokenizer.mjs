// Keep host and native-video tokenization on the same pinned model asset.
export {
  countDeepSeekTokens as countTextTokens,
  getDeepSeekTokenizer as getTokenizer,
} from "../../engines/video-edit/packages/base/model-router/deepseek-window.mjs";

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { PromptFusionAgent } = require("../engines/video-edit/vendor/supermickey/hyperreality-system/engines/production-engine/agents/prompt-fusion-agent.js");

const requiredVisualFields = {
  director_instruction: "电影级写实体育广告，" + "真实光影与自然皮肤质感".repeat(10),
  constraint: "9:16竖屏，1080x1920，30fps，无画面文字",
  baseline: "照片级真实质感，电影级细节，职业体育广告摄影",
  scene: "封闭赛车场颁奖区，" + "真实金属与沥青材质细节".repeat(12),
  lighting: "正午硬光，人物面部柔光补光，" + "金属高光层次清晰".repeat(40),
  composition: "中景人物与整车同框，" + "主体位于画面安全区".repeat(10),
  color_palette: "黑红赛车服，暖金肤色，冷灰金属，" + "自然饱和度与高动态范围".repeat(8),
  depth_of_field: "人物脸部与奖杯清晰，整车保持可辨识，" + "背景自然虚化".repeat(30),
  camera_movement: "稳定低机位，缓慢后拉，" + "最后定格人物奖杯与整车".repeat(10),
  character: "李英子，成年原创虚构女性车手，黑色高马尾",
  costume: "黑红紧身连体赛车服，护具完整，前领适度下拉",
  makeup: "汗湿自然妆，保留皮肤纹理与毛孔",
  action: "李英子站在最高领奖台阶，单手持奖杯看向镜头，" + "另一手扶髋自然呼吸".repeat(40),
  props: "冠军奖杯，领奖台最高台阶，820RR-RC整车",
  portraits: "image://characters/young-rider-01/portraits/v2/young-rider-01-front.png",
  timeline: "T00:00 - 中景站定，人物呼吸与赛车服细节清晰;T00:02 - 持杯抬眼，正午硬光扫过面部;T00:03 - 人物呼吸，奖杯金属轮廓稳定;T00:04 - 相机缓慢后拉，人物奖杯与820RR-RC同框;T00:05 - 金属高光与车身反射赛道线条;T00:06 - 画面定格，主体与车辆保持清晰" + "；时间轴细节".repeat(40),
  mood: "冷酷精密、自信、释放",
  pacing: "前段上扬，结尾稳定定格",
  transition: "硬切",
  audio: "环境远噪、呼吸与金属回声，" + "保留原生声音".repeat(40),
  negative: "no text, no subtitle, no logo, no watermark, no extra limbs",
  bright_constraint: "正午自然光，脸部清晰",
  character_constraint: "只出现李英子一人，身份与服装连续",
  consistency: "跨镜保持同一脸型、发型、赛车服、车辆与光位",
};

test("dialogue-free prompt fusion stays complete without a degraded dialogue placeholder", async () => {
  const agent = new PromptFusionAgent({ enabled: false });
  let llmCalled = false;
  agent._callLLM = async () => {
    llmCalled = true;
    return { result: { fields: {} }, degraded: false };
  };

  const result = await agent._ensureFieldCompleteness(
    { shotId: "ending", duration: 6, dialogueFree: true, dialogue: "", sceneType: "action" },
    structuredClone(requiredVisualFields),
    "9:16",
    [],
  );

  assert.equal(llmCalled, false, "no-dialogue shots must not invoke a dialogue top-up");
  assert.equal(result.usedRuleFallback, false, "empty dialogue must not mark the shot as degraded");
  assert.equal(Object.hasOwn(result.fields, "dialogue"), false);
});

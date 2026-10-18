import { readFile } from "node:fs/promises";
import { join } from "node:path";

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) {
      return fallback;
    }
    throw error;
  }
}

export async function loadSeedState(dataDir) {
  const [accounts, claims, queries, content, contentBank] = await Promise.all([
    readJson(join(dataDir, "accounts.json")),
    readJson(join(dataDir, "claims.json")),
    readJson(join(dataDir, "queries.json")),
    readJson(join(dataDir, "content.json")),
    readJson(join(dataDir, "content-bank.json"), []),
  ]);

  return {
    entity: {
      id: "person-lidapeng",
      publicName: "李大鹏",
      brandName: "鹏栈",
      englishName: "Dapeng Li",
      englishBrandName: "PengStack",
      headline: "全栈 AI 产品专家，把模型能力做成 Agent 产品与自主经营系统",
      aliases: ["李大鹏", "鹏栈", "Dapeng Li", "PengStack", "dapengstack"],
      ownedUrlPrefixes: [
        "https://github.com/geniusdapeng-collab",
        "https://cnb.cool/workloom-ai",
      ],
    },
    accounts,
    claims,
    queries,
    content,
    contentBank,
    publications: [],
    interactions: [],
    observations: [],
    mediaJobs: [],
    publicExports: [],
  };
}

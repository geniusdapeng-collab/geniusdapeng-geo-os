import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CURRENT_ALIASES, LEGACY_ALIASES, MAIN_PROFILE, SYSTEM_IDENTITY } from "../domain/identity.mjs";

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
    system: { ...SYSTEM_IDENTITY },
    entity: {
      ...MAIN_PROFILE,
      aliases: [...CURRENT_ALIASES, ...LEGACY_ALIASES],
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

// Change profile metadata once without rewriting published content or ledger history.
export async function migratePengManagerIdentity(store, dataDir) {
  const current = store.snapshot();
  if (current.entity?.id !== MAIN_PROFILE.id || current.entity.profileVersion >= 2) {
    return false;
  }
  const [seed, legacy] = await Promise.all([
    loadSeedState(dataDir),
    readJson(join(dataDir, "..", "migrations", "identity-v1.json")),
  ]);
  await store.mutate(
    { type: "identity.updated", actor: "PengManager", payload: { profileVersion: 2, systemId: SYSTEM_IDENTITY.id } },
    (state) => {
      state.system = { ...SYSTEM_IDENTITY };
      state.entity = {
        ...state.entity,
        ...MAIN_PROFILE,
        aliases: [...new Set([...CURRENT_ALIASES, ...LEGACY_ALIASES, ...(state.entity.aliases ?? [])])],
      };
      const profileFields = ["language", "name", "nameZh", "nameEn", "displayName", "displayNameZh", "displayNameEn", "bio", "bioZh", "bioEn"];
      for (const account of state.accounts) {
        const defaults = seed.accounts.find((row) => row.id === account.id);
        if (!defaults) continue;
        for (const field of profileFields) {
          if (defaults[field] !== undefined) account[field] = defaults[field];
        }
      }
      for (const query of state.queries) {
        const previous = legacy.queries.find((row) => row.id === query.id);
        const next = seed.queries.find((row) => row.id === query.id);
        if (previous && next && query.text === previous.text) query.text = next.text;
      }
      for (const claim of state.claims) {
        const previous = legacy.claims.find((row) => row.id === claim.id);
        const next = seed.claims.find((row) => row.id === claim.id);
        if (previous && next && claim.state !== "approved" && claim.text === previous.text) {
          claim.text = next.text;
          if (claim.source?.label === previous.source?.label) claim.source.label = next.source.label;
        }
      }
      for (const item of state.contentBank ?? []) {
        const previous = legacy.contentBank.find((row) => row.id === item.id);
        const next = seed.contentBank.find((row) => row.id === item.id);
        if (!previous || !next) continue;
        for (const field of ["title", "hook", "thesis"]) {
          if (item[field] === previous[field]) item[field] = next[field];
        }
      }
      for (const content of state.content) {
        if (content.status === "draft" && content.owner === "PengStack") content.owner = "PengManager";
      }
      return { profileVersion: 2 };
    },
  );
  return true;
}

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { hashObject } from "../domain/hash.mjs";

function clone(value) {
  return structuredClone(value);
}

function createEvent(state, { type, actor, payload, at }) {
  const previousHash = state.events.at(-1)?.hash ?? "GENESIS";
  const base = {
    sequence: state.events.length + 1,
    type,
    actor: actor || "system",
    payload: payload ?? {},
    at,
    previousHash,
  };
  return {
    ...base,
    hash: hashObject(base),
  };
}

export function verifyEventChain(events) {
  let previousHash = "GENESIS";

  for (const [index, event] of events.entries()) {
    if (event.sequence !== index + 1) {
      return { valid: false, reason: `sequence mismatch at index ${index}` };
    }
    if (event.previousHash !== previousHash) {
      return { valid: false, reason: `previousHash mismatch at sequence ${event.sequence}` };
    }
    const { hash, ...base } = event;
    if (hashObject(base) !== hash) {
      return { valid: false, reason: `hash mismatch at sequence ${event.sequence}` };
    }
    previousHash = hash;
  }

  return { valid: true, head: previousHash, count: events.length };
}

export class JsonStore {
  #filePath;
  #clock;
  #state;
  #tail = Promise.resolve();

  constructor({ filePath, clock = () => new Date() }) {
    this.#filePath = filePath;
    this.#clock = clock;
    this.#state = null;
  }

  get filePath() {
    return this.#filePath;
  }

  async open(seedFactory) {
    if (this.#state) {
      return this.snapshot();
    }

    try {
      const raw = await readFile(this.#filePath, "utf8");
      this.#state = JSON.parse(raw);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }

      const seed = await seedFactory();
      const at = this.#clock().toISOString();
      this.#state = {
        ...seed,
        schemaVersion: 1,
        revision: 0,
        createdAt: seed.createdAt ?? at,
        updatedAt: at,
        events: [],
      };
      this.#state.events.push(
        createEvent(this.#state, {
          type: "state.initialized",
          actor: "system",
          payload: {
            accounts: this.#state.accounts?.length ?? 0,
            claims: this.#state.claims?.length ?? 0,
            queries: this.#state.queries?.length ?? 0,
            content: this.#state.content?.length ?? 0,
            contentBank: this.#state.contentBank?.length ?? 0,
          },
          at,
        }),
      );
      await this.#persist(this.#state);
    }

    const chain = verifyEventChain(this.#state.events);
    if (!chain.valid) {
      throw new Error(`Event chain is invalid: ${chain.reason}`);
    }

    return this.snapshot();
  }

  snapshot() {
    if (!this.#state) {
      throw new Error("Store has not been opened.");
    }
    return clone(this.#state);
  }

  async mutate({ type, actor, payload }, mutator) {
    const run = this.#tail.then(async () => {
      if (!this.#state) {
        throw new Error("Store has not been opened.");
      }

      const next = clone(this.#state);
      const result = await mutator(next);
      const at = this.#clock().toISOString();
      next.revision += 1;
      next.updatedAt = at;
      next.events.push(
        createEvent(next, {
          type,
          actor,
          payload,
          at,
        }),
      );
      await this.#persist(next);
      this.#state = next;
      return { result: clone(result), state: clone(next) };
    });

    this.#tail = run.catch(() => undefined);
    return run;
  }

  async #persist(state) {
    const directory = dirname(this.#filePath);
    const temporaryPath = `${this.#filePath}.${process.pid}.tmp`;
    await mkdir(directory, { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.#filePath);
  }
}

import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { hashObject } from "../domain/hash.mjs";
import { assertEditorialStateIntegrity } from "../domain/editorial.mjs";
import { assertContentOpsStateIntegrity } from "../domain/content-ops.mjs";

const NO_CHANGE = Symbol("JsonStore.noChange");
const SUPPORTED_SCHEMAS = new Set([1, 2, 3]);

function storeError(code, message) {
  return Object.assign(new Error(message), { code });
}

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
  #opening = null;
  #writerLock;
  #lock = null;
  #closing = false;
  #closed = false;

  constructor({ filePath, clock = () => new Date(), writerLock = false }) {
    this.#filePath = resolve(filePath);
    this.#clock = clock;
    this.#state = null;
    this.#writerLock = writerLock === true;
  }

  static noChange(result) {
    return { [NO_CHANGE]: true, result };
  }

  get filePath() {
    return this.#filePath;
  }

  async open(seedFactory) {
    if (this.#closed || this.#closing) throw storeError("STATE_STORE_CLOSED", "Store is closed.");
    if (this.#state) {
      return this.snapshot();
    }
    if (this.#opening) return this.#opening;
    this.#opening = this.#open(seedFactory).finally(() => { this.#opening = null; });
    return this.#opening;
  }

  async #open(seedFactory) {
    if (this.#writerLock) await this.#acquireWriterLock();
    try {
      return await this.#readOrInitialize(seedFactory);
    } catch (error) {
      this.#state = null;
      if (this.#lock) await this.#releaseWriterLock();
      throw error;
    }
  }

  async #readOrInitialize(seedFactory) {
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

    if (!SUPPORTED_SCHEMAS.has(this.#state?.schemaVersion)) {
      throw storeError("STATE_SCHEMA_UNSUPPORTED", "State schema is not supported by this application.");
    }
    if (!Array.isArray(this.#state.events) || !Number.isSafeInteger(this.#state.revision) || this.#state.revision < 0) {
      throw storeError("STATE_INVALID", "State metadata is invalid.");
    }
    const chain = verifyEventChain(this.#state.events);
    if (!chain.valid) {
      throw new Error(`Event chain is invalid: ${chain.reason}`);
    }
    assertEditorialStateIntegrity(this.#state);
    assertContentOpsStateIntegrity(this.#state);

    return this.snapshot();
  }

  snapshot() {
    if (!this.#state) {
      throw new Error("Store has not been opened.");
    }
    return clone(this.#state);
  }

  async mutate({ type, actor, payload }, mutator) {
    if (this.#closed || this.#closing) throw storeError("STATE_STORE_CLOSED", "Store is closed.");
    const run = this.#tail.then(async () => {
      if (!this.#state) {
        throw new Error("Store has not been opened.");
      }

      const next = clone(this.#state);
      const result = await mutator(next);
      if (result?.[NO_CHANGE] === true) {
        return { result: clone(result.result), state: this.snapshot() };
      }
      if (!SUPPORTED_SCHEMAS.has(next.schemaVersion)) {
        throw storeError("STATE_SCHEMA_UNSUPPORTED", "State schema is not supported by this application.");
      }
      assertContentOpsStateIntegrity(next);
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
    const temporaryPath = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true });
    let handle;
    let created = false;
    try {
      handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporaryPath, this.#filePath);
      created = false;
    } finally {
      if (handle) await handle.close();
      if (created) await unlink(temporaryPath);
    }
  }

  async #acquireWriterLock() {
    const directory = dirname(this.#filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stateInfo = await lstat(this.#filePath).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (stateInfo && (!stateInfo.isFile() || stateInfo.isSymbolicLink())) {
      throw storeError("STATE_UNSAFE_PATH", "State must be an ordinary file.");
    }
    const lockPath = join(await realpath(directory), `${basename(this.#filePath)}.writer.lock`);
    let handle;
    try {
      handle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const owner = { schema: 1, pid: process.pid, owner: randomUUID(), createdAt: this.#clock().toISOString() };
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await handle.sync();
      const info = await handle.stat();
      this.#lock = { path: lockPath, handle, ino: info.ino, dev: info.dev, owner: owner.owner };
    } catch (error) {
      if (handle) {
        await handle.close();
        await unlink(lockPath);
      }
      if (error.code !== "EEXIST") throw error;
      let existing;
      try {
        const reader = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const info = await reader.stat();
          if (!info.isFile() || info.size > 2048) throw storeError("STATE_WRITER_LOCKED", "Writer lock cannot be verified.");
          existing = JSON.parse(await reader.readFile("utf8"));
        } finally { await reader.close(); }
      } catch {
        throw storeError("STATE_WRITER_LOCKED", "Writer lock cannot be verified; do not remove an unknown lock.");
      }
      if (Number.isSafeInteger(existing.pid) && existing.pid > 0) {
        try { process.kill(existing.pid, 0); }
        catch (probe) {
          if (probe.code === "ESRCH") {
            throw storeError("STATE_WRITER_LOCK_STALE", "A stopped writer left a lock; stop writers and perform controlled lock recovery before opening state.");
          }
        }
      }
      throw storeError("STATE_WRITER_LOCKED", "Another writer owns this state file.");
    }
  }

  async #releaseWriterLock() {
    const lock = this.#lock;
    this.#lock = null;
    if (!lock) return;
    try {
      const info = await lstat(lock.path);
      if (!info.isFile() || info.isSymbolicLink() || info.ino !== lock.ino || info.dev !== lock.dev) {
        throw storeError("STATE_WRITER_LOCK_CHANGED", "Writer lock changed; refusing to remove another owner's file.");
      }
      const owner = JSON.parse(await readFile(lock.path, "utf8"));
      if (owner.owner !== lock.owner || owner.pid !== process.pid) {
        throw storeError("STATE_WRITER_LOCK_CHANGED", "Writer lock identity changed.");
      }
      await unlink(lock.path);
    } finally { await lock.handle.close(); }
  }

  async close() {
    if (this.#closed) return;
    this.#closing = true;
    try {
      if (this.#opening) await this.#opening;
      await this.#tail;
      await this.#releaseWriterLock();
    } finally {
      this.#closed = true;
      this.#closing = false;
    }
  }
}

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonStore, verifyEventChain } from "../src/storage/json-store.mjs";

test("JSON store persists mutations and keeps a valid append-only hash chain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pengstack-store-"));
  const filePath = join(directory, "state.json");

  try {
    const store = new JsonStore({ filePath });
    await store.open(async () => ({
      items: [],
    }));

    await store.mutate({ type: "item.created", actor: "test" }, (state) => {
      state.items.push({ id: "one" });
      return state.items[0];
    });
    await store.mutate({ type: "item.created", actor: "test" }, (state) => {
      state.items.push({ id: "two" });
      return state.items[1];
    });

    const snapshot = store.snapshot();
    assert.equal(snapshot.revision, 2);
    assert.equal(snapshot.items.length, 2);
    assert.deepEqual(verifyEventChain(snapshot.events), {
      valid: true,
      head: snapshot.events.at(-1).hash,
      count: 3,
    });

    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(persisted.items.length, 2);

    const reopened = new JsonStore({ filePath });
    await reopened.open(async () => {
      throw new Error("seed factory must not run");
    });
    assert.equal(reopened.snapshot().revision, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent mutations are serialized", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pengstack-store-"));
  const filePath = join(directory, "state.json");

  try {
    const store = new JsonStore({ filePath });
    await store.open(async () => ({ counter: 0 }));
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.mutate({ type: "counter.incremented", actor: "test" }, (state) => {
          state.counter += 1;
          return state.counter + index * 0;
        }),
      ),
    );
    assert.equal(store.snapshot().counter, 8);
    assert.equal(verifyEventChain(store.snapshot().events).valid, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/** Local portrait request receipts. The project cache lock serializes reads and append-only writes. */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SCHEMA = "workloom.portrait-submission/v1";
const DISPATCH = /^\.portrait-submit-([0-9a-f]{64})-([0-9a-f-]{36})\.dispatched\.json$/;
const HASH = /^[0-9a-f]{64}$/;
type Identity = { schemaVersion: typeof SCHEMA; projectId: string; requestHash: string; dispatchId: string };
type State = "dispatched" | "accepted" | "rejected";

function invalid(): never { throw new Error("PORTRAIT_SUBMISSION_RECEIPT_INVALID: 无法核实原定妆请求，暂停后续付费生成"); }
export function portraitDownloadUrl(raw: unknown): string {
  if (typeof raw !== "string" || !raw || Buffer.byteLength(raw) > 8192 || raw !== raw.trim()) return invalid();
  let url: URL;
  try { url = new URL(raw); } catch { return invalid(); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) return invalid();
  return raw;
}

export function portraitSubmissionJournal(root: string, projectId: string, apiKey: string) {
  const key = createHmac("sha256", apiKey).update("workloom.portrait-download-capability/v1").digest();
  const identity = (requestHash: string, dispatchId: string): Identity => ({ schemaVersion: SCHEMA, projectId, requestHash, dispatchId });
  const pathFor = (id: Identity, state: State): string => join(root, `.portrait-submit-${id.requestHash}-${id.dispatchId}.${state}.json`);
  const append = (id: Identity, state: State, fields: Record<string, unknown> = {}): void => {
    const fd = openSync(pathFor(id, state), "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify({ ...id, state, at: new Date().toISOString(), ...fields })); fsyncSync(fd); }
    finally { closeSync(fd); }
    const directory = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  };
  const read = (id: Identity, state: State): Record<string, unknown> | undefined => {
    let fd: number;
    try { fd = openSync(pathFor(id, state), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size < 1 || stat.size > 24_000) return invalid();
      const bytes = Buffer.allocUnsafe(stat.size);
      if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length || fstatSync(fd).size !== stat.size) return invalid();
      const value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      if (!value || !Object.entries(id).every(([name, field]) => value[name] === field)
        || value.state !== state || typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at))) return invalid();
      return value;
    } catch (error) {
      if (error instanceof SyntaxError) return invalid();
      throw error;
    } finally { closeSync(fd); }
  };
  const aad = (id: Identity): Buffer => Buffer.from(JSON.stringify(id));

  function find(requestHash: string): { acceptedUrl?: string; unresolved: boolean } {
    let acceptedUrl: string | undefined;
    let unresolved = false;
    for (const name of readdirSync(root)) {
      const match = DISPATCH.exec(name);
      if (!match) continue;
      const id = identity(match[1]!, match[2]!);
      const dispatched = read(id, "dispatched");
      if (typeof dispatched?.wireRequestHash !== "string" || !HASH.test(dispatched.wireRequestHash)) return invalid();
      const accepted = read(id, "accepted"), rejected = read(id, "rejected");
      if (accepted && rejected) return invalid();
      if (!accepted && !rejected) { unresolved = true; continue; }
      if (!accepted) continue;
      const { urlSha256, nonce, tag, ciphertext } = accepted;
      if (typeof urlSha256 !== "string" || !HASH.test(urlSha256) || typeof nonce !== "string" || !/^[0-9a-f]{24}$/.test(nonce)
        || typeof tag !== "string" || !/^[0-9a-f]{32}$/.test(tag) || typeof ciphertext !== "string" || !/^(?:[0-9a-f]{2}){1,8192}$/.test(ciphertext)) return invalid();
      if (requestHash !== id.requestHash) continue;
      if (acceptedUrl) return invalid();
      let raw: string;
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "hex"));
        decipher.setAAD(aad(id)); decipher.setAuthTag(Buffer.from(tag, "hex"));
        raw = Buffer.concat([decipher.update(Buffer.from(ciphertext, "hex")), decipher.final()]).toString("utf8");
      } catch { return invalid(); }
      if (createHash("sha256").update(raw).digest("hex") !== urlSha256) return invalid();
      acceptedUrl = portraitDownloadUrl(raw);
    }
    return { acceptedUrl, unresolved };
  }

  return {
    find,
    dispatch(requestHash: string, wireRequestHash: string): Identity {
      if (!HASH.test(requestHash) || !HASH.test(wireRequestHash)) return invalid();
      const id = identity(requestHash, randomUUID());
      append(id, "dispatched", { wireRequestHash });
      return id;
    },
    accept(id: Identity, url: string): void {
      const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(aad(id));
      const ciphertext = Buffer.concat([cipher.update(url, "utf8"), cipher.final()]);
      append(id, "accepted", { urlSha256: createHash("sha256").update(url).digest("hex"),
        nonce: nonce.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ciphertext: ciphertext.toString("hex") });
    },
    reject(id: Identity, status: number, code: string): void { append(id, "rejected", { status, code }); },
  };
}

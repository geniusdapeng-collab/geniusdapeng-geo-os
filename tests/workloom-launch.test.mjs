import test from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createGeoOsServer } from "../src/http/server.mjs";
import { createAdminAuth, hashAdminPassword, hashAgentToken } from "../src/security/admin-auth.mjs";
import { createWorkloomLaunch } from "../src/security/workloom-launch.mjs";

const password = randomBytes(24).toString("base64url");
const passwordHash = await hashAdminPassword(password);
const agentToken = randomBytes(32).toString("base64url");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });

function launch(overrides = {}, { production = true, time = Date.parse("2026-10-29T00:00:00.000Z") } = {}) {
  return createWorkloomLaunch({
    env: {
      NODE_ENV: production ? "production" : "development",
      WORKLOOM_PM_ORIGIN: production ? "https://pm.example.com" : "http://127.0.0.1:5373",
      WORKLOOM_LAUNCH_PRIVATE_KEY: privatePem,
      WORKLOOM_LAUNCH_TENANT_ID: "tenant-1",
      WORKLOOM_LAUNCH_WORKSPACE_ID: "ws-aipm-demo",
      WORKLOOM_LAUNCH_MEMBER_NO: "MEM-001",
      ...overrides,
    },
    clock: () => time,
  });
}

function decodeLaunch(url) {
  const parsed = new URL(url);
  const code = new URLSearchParams(parsed.hash.slice(1)).get("__launch");
  assert.ok(code);
  const [encoded, signature] = code.split(".");
  assert.equal(verify(null, Buffer.from(encoded, "utf8"), publicKey, Buffer.from(signature, "base64url")), true);
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
}

test("WorkLoom launch emits a verifiable 60-second Ed25519 assertion", () => {
  const service = launch();
  assert.equal(service.enabled, true);
  const issued = service.issue();
  assert.match(issued.launchUrl, /^https:\/\/pm\.example\.com\/assistant#__launch=/);
  assert.equal(decodeLaunch(issued.launchUrl).exp - decodeLaunch(issued.launchUrl).iat, 60);
  assert.deepEqual(decodeLaunch(issued.launchUrl), {
    iss: "pengmanager",
    aud: "workloom-pm",
    sub: "pengmanager-owner",
    jti: decodeLaunch(issued.launchUrl).jti,
    iat: 1_793_232_000,
    nbf: 1_793_231_999,
    exp: 1_793_232_060,
    tenantId: "tenant-1",
    workspaceId: "ws-aipm-demo",
    memberNo: "MEM-001",
  });
});

test("WorkLoom launch rejects missing keys, wrong algorithms, non-HTTPS production origins and unsafe TTLs", () => {
  for (const overrides of [
    { WORKLOOM_LAUNCH_PRIVATE_KEY: "" },
    { WORKLOOM_PM_ORIGIN: "http://pm.example.com" },
    { WORKLOOM_PM_ORIGIN: "https://pm.example.com/path" },
    { WORKLOOM_LAUNCH_TTL_SECONDS: "600" },
    { WORKLOOM_LAUNCH_TENANT_ID: "" },
  ]) {
    const service = launch(overrides);
    assert.equal(service.enabled, false);
    assert.throws(() => service.issue(), { status: 503, code: "WORKLOOM_LAUNCH_NOT_CONFIGURED" });
  }
  const { privateKey: rsa } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.equal(launch({ WORKLOOM_LAUNCH_PRIVATE_KEY: rsa.export({ type: "pkcs8", format: "pem" }) }).enabled, false);
});

function setupHttp() {
  const env = {
    NODE_ENV: "production", PUBLIC_ORIGIN: "https://manager.example.com", ALLOWED_HOSTS: "manager.example.com",
    ADMIN_PASSWORD_HASH: passwordHash, ADMIN_AGENT_TOKEN_HASH: hashAgentToken(agentToken),
  };
  const auth = createAdminAuth({ env, host: "0.0.0.0", allowedHosts: ["manager.example.com"] });
  const workloomLaunch = launch();
  const server = createGeoOsServer({
    service: {},
    publicDir: new URL("../public", import.meta.url).pathname,
    allowedHosts: ["manager.example.com"],
    auth,
    workloomLaunch,
  });
  return { server, auth, workloomLaunch };
}

function send(server, path, { method = "GET", headers = {}, body } = {}) {
  const address = server.address();
  return new Promise((accept, reject) => {
    const request = httpRequest(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: {
        host: "manager.example.com",
        ...(body ? { "content-type": "application/json" } : {}),
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => accept({
        status: response.statusCode,
        headers: response.headers,
        payload: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

test("authenticated admin receives launch URL; anonymous and agent callers are denied", async (t) => {
  const { server } = setupHttp();
  await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
  t.after(() => new Promise((accept) => server.close(accept)));
  const login = await send(server, "/api/auth/login", {
    method: "POST",
    headers: { origin: "https://manager.example.com" },
    body: JSON.stringify({ password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers["set-cookie"][0].split(";")[0];
  const issued = await send(server, "/api/workloom/launch", {
    method: "POST",
    headers: { cookie, origin: "https://manager.example.com" },
    body: "{}",
  });
  assert.equal(issued.status, 200);
  assert.match(issued.payload.launchUrl, /^https:\/\/pm\.example\.com\/assistant#__launch=/);
  assert.equal(
    decodeLaunch(issued.payload.launchUrl).workspaceId,
    "ws-aipm-demo",
  );
  const anonymous = await send(server, "/api/workloom/launch", { method: "POST", body: "{}" });
  assert.equal(anonymous.status, 401);
  const agent = await send(server, "/api/workloom/launch", {
    method: "POST",
    headers: { authorization: `Bearer ${agentToken}` },
    body: "{}",
  });
  assert.equal(agent.status, 403);
  assert.equal(agent.payload.error.code, "AGENT_SCOPE_DENIED");
});

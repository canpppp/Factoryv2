"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createChannelRegistry } = require("../src/channels");
const { createChannelApi } = require("../src/channel-api");
const journal = require("../src/journal");
const H = require("./helpers");

async function main() {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".channel-api-test-"));
  process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = H.makeChannelDefinitions();
  const registry = createChannelRegistry({ root, definitionsPath: fixture.definitionsPath });
  registry.ensureDefaults();
  const initialEventCount = journal.load(root).events.length;
  registry.ensureDefaults();
  assert.strictEqual(journal.load(root).events.length, initialEventCount, "unchanged definitions emitted journal events");

  registry.pause("kaylas-store");
  registry.ensureDefaults();
  assert.strictEqual(registry.status("kaylas-store").state, "paused", "definition refresh reset a paused channel");
  registry.resume("kaylas-store");

  assert.throws(() => registry.send("kaylas-store", "write", { readWriteBoundary: "workspace-write" }), errorCode("AUTHORITY_EXCEEDED"));
  assert.throws(() => registry.send("kaylas-store", "tool", { requestedTools: ["Edit"] }), errorCode("TOOL_POLICY_DENIED"));

  const jobId = "stable-job-id";
  const first = registry.send("invoice-audit", "compare", { jobId, deterministic: { kind: "invoice-compare", records: [] } });
  await registry.runNext();
  const duplicate = registry.send("invoice-audit", "must not execute", { jobId });
  assert.strictEqual(duplicate.id, first.id);
  assert.strictEqual(registry.status("invoice-audit").queue.length, 0);
  assert.strictEqual(journal.load(root).events.filter((event) => event.type === "channel.job.queued" && event.job.id === jobId).length, 1);

  const badPath = path.join(fixture.dir, "bad-channels.json");
  fs.writeFileSync(badPath, JSON.stringify([{ id: "missing", name: "Missing", cwd: path.join(fixture.dir, "absent"), engine: "claude", writeAuthority: "none" }]));
  const missing = createChannelRegistry({ root: H.tmp("factoryv2-channel-missing-"), definitionsPath: badPath });
  missing.ensureDefaults();
  assert.strictEqual(missing.status("missing").state, "unavailable");
  assert.throws(() => missing.send("missing", "work"), errorCode("CHANNEL_CWD_MISSING"));

  const wrongPath = path.join(fixture.dir, "wrong-channels.json");
  fs.writeFileSync(wrongPath, JSON.stringify([{ id: "wrong", name: "Wrong", cwd: fixture.dir, engine: "claude", writeAuthority: "none", projectIdentity: { marker: "not-here" } }]));
  const wrong = createChannelRegistry({ root: H.tmp("factoryv2-channel-wrong-"), definitionsPath: wrongPath });
  wrong.ensureDefaults();
  assert.throws(() => wrong.send("wrong", "work"), errorCode("CHANNEL_PROJECT_MISMATCH"));

  const contentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "factoryv2-content-identity-"));
  fs.writeFileSync(path.join(contentRoot, "CLAUDE.md"), "# Dedicated Kaylas workspace\n");
  const contentPath = path.join(fixture.dir, "content-channels.json");
  fs.writeFileSync(contentPath, JSON.stringify([{ id: "content", name: "Content", cwd: contentRoot, engine: "claude", writeAuthority: "none", projectIdentity: { marker: "CLAUDE.md", markerContains: "Dedicated Kaylas workspace" } }]));
  const content = createChannelRegistry({ root: H.tmp("factoryv2-channel-content-"), definitionsPath: contentPath });
  content.ensureDefaults();
  assert.strictEqual(content.status("content").state, "idle");
  fs.writeFileSync(path.join(contentRoot, "CLAUDE.md"), "# Another project\n");
  assert.throws(() => content.send("content", "work"), errorCode("CHANNEL_PROJECT_MISMATCH"));

  const unreadablePath = path.join(fixture.dir, "unreadable-channels.json");
  const markerDirectory = path.join(contentRoot, "MARKER");
  fs.mkdirSync(markerDirectory);
  fs.writeFileSync(unreadablePath, JSON.stringify([{ id: "unreadable", name: "Unreadable", cwd: contentRoot, engine: "claude", writeAuthority: "none", projectIdentity: { marker: "MARKER", markerContains: "identity" } }]));
  const unreadable = createChannelRegistry({ root: H.tmp("factoryv2-channel-unreadable-"), definitionsPath: unreadablePath });
  unreadable.ensureDefaults();
  assert.strictEqual(unreadable.status("unreadable").state, "unavailable");
  assert.match(unreadable.status("unreadable").unavailableReason, /marker file/);

  const apiSocket = path.join(os.tmpdir(), `factoryv2-channel-api-${process.pid}.sock`);
  const api = createChannelApi({ root, registry, socketPath: apiSocket });
  await api.start();
  try {
    assert.strictEqual(fs.statSync(api.socketPath).mode & 0o777, 0o600);
    const list = await rpc(api.socketPath, "channel.list", {});
    assert.strictEqual(list.ok, true);
    assert.strictEqual(list.result.length, 6);
    const denied = await rpc(api.socketPath, "shell.run", {});
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.error.code, "METHOD_DENIED");
    const sent = await rpc(api.socketPath, "channel.send", { channelId: "kaylas-store", objective: "Inspect status", jobId: "api-job" });
    assert.strictEqual(sent.ok, true);
    assert.strictEqual(sent.result.envelope.objective, "Inspect status");
  } finally {
    await api.close();
  }
  assert.strictEqual(fs.existsSync(api.socketPath), false);

  await proveActiveInterruption(fixture.definitionsPath);

  console.log("Channel identity, authority, idempotency and API proof passed");
}

async function proveActiveInterruption(definitionsPath) {
  for (const action of ["pause", "cancel"]) {
    const root = H.tmp(`factoryv2-active-${action}-`);
    let rejectRun;
    const adapter = {
      startThread: () => ({ run: (_prompt, hooks) => new Promise((_resolve, reject) => { hooks.onThreadId("active-session"); rejectRun = reject; }) }),
      resumeThread: () => { throw new Error("unexpected resume"); },
      cancelThread: () => { const error = new Error("cancelled"); error.code = "CANCELLED"; rejectRun(error); return true; }
    };
    const registry = createChannelRegistry({ root, definitionsPath, adapterFactory: () => adapter });
    registry.ensureDefaults();
    registry.send("kaylas-store", `${action} active`, { jobId: `${action}-job` });
    const running = registry.runNext();
    await new Promise((resolve) => setImmediate(resolve));
    registry[action]("kaylas-store");
    await running;
    const status = registry.status("kaylas-store");
    const terminals = journal.load(root).events.filter((event) => ["channel.job.finished", "channel.job.failed", "channel.job.cancelled"].includes(event.type));
    if (action === "pause") {
      assert.strictEqual(status.state, "paused");
      assert.strictEqual(status.currentJob.id, "pause-job");
      assert.strictEqual(terminals.length, 0);
    } else {
      assert.strictEqual(status.currentJob, null);
      assert.strictEqual(terminals.length, 1);
      assert.strictEqual(terminals[0].type, "channel.job.cancelled");
    }
  }
}

function errorCode(code) {
  return (error) => error?.code === code;
}

function rpc(socketPath, method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ id: "test", method, params });
    const request = http.request({ socketPath, path: "/rpc", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
    });
    request.on("error", reject);
    request.end(body);
  });
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

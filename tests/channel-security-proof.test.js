"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createChannelRegistry } = require("../src/channels");
const { createChannelApi, handle } = require("../src/channel-api");
const { createChannelTools } = require("../src/jarvis-tools");
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
  const duplicate = registry.send("invoice-audit", "compare", { jobId, deterministic: { kind: "invoice-compare", records: [] } });
  assert.strictEqual(duplicate.id, first.id);
  assert.throws(() => registry.send("invoice-audit", "must not execute", { jobId }), errorCode("IDEMPOTENCY_PAYLOAD_MISMATCH"));
  assert.strictEqual(registry.status("invoice-audit").queue.length, 0);
  assert.strictEqual(journal.load(root).events.filter((event) => event.type === "channel.job.queued" && event.job.id === jobId).length, 1);
  assert.strictEqual(registry.result("invoice-audit", jobId).jobId, jobId);
  const keyed = registry.send("invoice-audit", "keyed compare", { idempotencyKey: "admission-key-1", deterministic: { kind: "invoice-compare", records: [] } });
  const keyedRetry = registry.send("invoice-audit", "keyed compare", { idempotencyKey: "admission-key-1", deterministic: { kind: "invoice-compare", records: [] } });
  assert.strictEqual(keyedRetry.id, keyed.id);
  assert.throws(() => registry.send("invoice-audit", "keyed compare changed", { idempotencyKey: "admission-key-1" }), errorCode("IDEMPOTENCY_PAYLOAD_MISMATCH"));

  await contextFailure(fixture.definitionsPath, "private:session", "CONTEXT_PRIVACY_DENIED");
  await contextFailure(fixture.definitionsPath, "project:wrong-store", "CONTEXT_FOREIGN_SCOPE");
  await contextFailure(fixture.definitionsPath, "project-memory:esmebelle", "CONTEXT_FOREIGN_SCOPE");
  await contextFailure(fixture.definitionsPath, "stale:rules", "CONTEXT_STALE");
  await contextFailure(fixture.definitionsPath, "skill:missing-sop", "CONTEXT_MISSING");
  await contextFailure(fixture.definitionsPath, "made-up:required", "CONTEXT_UNKNOWN_REF");
  await contextFailure(fixture.definitionsPath, "file:missing.md", "CONTEXT_MISSING");
  await requiredRefFailure(fixture.definitionsPath);
  await realJarvisPackRefsResolve(fixture.definitionsPath, fixture.dir);
  fs.writeFileSync(path.join(fixture.dir, "large.md"), "é".repeat(9000));
  await contextFailure(fixture.definitionsPath, "file:large.md", "CONTEXT_TOO_LARGE");
  fs.writeFileSync(path.join(fixture.dir, "outside.md"), "outside\n");
  const link = path.join(fixture.dir, "escaped.md");
  try { fs.symlinkSync(path.join(fixture.dir, "outside.md"), link); } catch {}
  if (fs.existsSync(link)) await contextFailure(fixture.definitionsPath, "file:escaped.md", "CONTEXT_PATH_ESCAPE");

  await sessionPathCannotEscape(fixture.definitionsPath);

  await workerFailure(fixture.definitionsPath, () => "not json", "MALFORMED_RESPONSE");
  await workerFailure(fixture.definitionsPath, (ids) => JSON.stringify({ done: false, channelId: ids.channelId, jobId: ids.jobId, summary: "not done", evidence: ["proof"], contextManifestSha256: ids.manifestSha }), "OBJECTIVE_UNVERIFIED");
  await workerFailure(fixture.definitionsPath, (ids) => JSON.stringify({ done: true, jobId: ids.jobId, summary: "missing channel", evidence: ["proof"], contextManifestSha256: ids.manifestSha }), "CHANNEL_ID_MISSING");
  await workerFailure(fixture.definitionsPath, (ids) => JSON.stringify({ done: true, channelId: ids.channelId, summary: "missing job", evidence: ["proof"], contextManifestSha256: ids.manifestSha }), "JOB_ID_MISSING");
  await workerFailure(fixture.definitionsPath, (ids) => JSON.stringify({ done: true, channelId: ids.channelId, jobId: "other-job", summary: "wrong", evidence: ["proof"], contextManifestSha256: ids.manifestSha }), "WRONG_JOB");
  await workerFailure(fixture.definitionsPath, (ids) => JSON.stringify({ done: true, channelId: ids.channelId, jobId: ids.jobId, summary: "completed analysis", evidence: [], contextManifestSha256: ids.manifestSha }), "EVIDENCE_MISSING");
  await workerFailure(fixture.definitionsPath, (ids) => JSON.stringify({ done: true, channelId: ids.channelId, jobId: ids.jobId, summary: "created report", evidence: ["file:missing-report.txt"], contextManifestSha256: ids.manifestSha }), "EVIDENCE_UNSUPPORTED", { evidenceRequired: ["file:missing-report.txt"] });
  await workerFailure(fixture.definitionsPath, (ids) => JSON.stringify({ done: true, channelId: ids.channelId, jobId: ids.jobId, summary: "completed analysis", evidence: ["file:report.txt"], contextManifestSha256: ids.manifestSha }), "ACCEPTANCE_UNSUPPORTED", { evidenceRequired: ["file:report.txt"], contextRefs: ["file:report.txt"], acceptanceProfile: [] });
  await workerFailure(fixture.definitionsPath, (ids) => JSON.stringify({ done: true, channelId: ids.channelId, jobId: ids.jobId, summary: "I cannot access the source or create the required report.", evidence: ["proof"], contextManifestSha256: ids.manifestSha }), "OBJECTIVE_UNVERIFIED");
  await workerFailure(fixture.definitionsPath, (ids) => JSON.stringify({ done: true, channelId: ids.channelId, jobId: ids.jobId, summary: "refused", evidence: ["proof"], refusal: true, contextManifestSha256: ids.manifestSha }), "WORKER_UNAVAILABLE");
  await measuredTotalPredicateFails(fixture.definitionsPath, fixture.dir);
  await rpcAcceptanceProfileIsEnforced(fixture.definitionsPath, fixture.dir);

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

  const apiSocket = path.join("/private/tmp", `factoryv2-channel-api-${process.pid}.sock`);
  const api = createChannelApi({ root, registry, socketPath: apiSocket });
  let socketStarted = false;
  try {
    await api.start();
    socketStarted = true;
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
  } catch (error) {
    if (error.code !== "EPERM") throw error;
    const list = await localRpc(registry, "channel.list", {});
    assert.strictEqual(list.ok, true);
    assert.strictEqual(list.result.length, 6);
    const denied = await localRpc(registry, "shell.run", {});
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.error.code, "METHOD_DENIED");
    const sent = await localRpc(registry, "channel.send", { channelId: "kaylas-store", objective: "Inspect status", jobId: "api-job" });
    assert.strictEqual(sent.ok, true);
    assert.strictEqual(sent.result.envelope.objective, "Inspect status");
  } finally {
    if (socketStarted) await api.close();
  }
  if (socketStarted) assert.strictEqual(fs.existsSync(api.socketPath), false);

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

async function contextFailure(definitionsPath, ref, code) {
  const registry = createChannelRegistry({ root: H.tmp(`factoryv2-context-${code}-`), definitionsPath });
  registry.ensureDefaults();
  registry.send("kaylas-store", `context failure ${code}`, { jobId: `job-${code}`, contextRefs: [ref] });
  const run = await registry.runNext();
  assert.strictEqual(run.result.code, code);
  assert.strictEqual(registry.result("kaylas-store", `job-${code}`).code, code);
}

async function workerFailure(definitionsPath, responseFor, code, options = {}) {
  const root = H.tmp(`factoryv2-worker-${code}-`);
  const adapter = {
    startThread: () => ({
      run: async (prompt, hooks) => {
        hooks.onThreadId("worker-failure-session");
        const channelId = prompt.match(/^CHANNEL ([^\n]+)/m)?.[1];
        const jobId = prompt.match(/^JOB ([^\n]+)/m)?.[1];
        const hashes = [...prompt.matchAll(/"sha256":"([0-9a-f]{64})"/g)].map((match) => match[1]);
        const manifestSha = hashes.at(-1);
        return {
          engine: "claude",
          sessionId: "worker-failure-session",
          finalResponse: responseFor({ channelId, jobId, manifestSha }),
          metadata: {}
        };
      }
    }),
    resumeThread: () => { throw new Error("unexpected resume"); },
    cancelThread: () => false
  };
  const registry = createChannelRegistry({ root, definitionsPath, adapterFactory: () => adapter });
  registry.ensureDefaults();
  if (options.contextRefs?.includes("file:report.txt")) fs.writeFileSync(path.join(path.dirname(definitionsPath), "report.txt"), "measured_total=12\n");
  registry.send("kaylas-store", `worker failure ${code}`, { jobId: `worker-${code}`, evidenceRequired: options.evidenceRequired || ["proof"], contextRefs: options.contextRefs || [], acceptanceProfile: options.acceptanceProfile });
  const run = await registry.runNext();
  assert.strictEqual(run.result.code, code);
  assert.strictEqual(registry.result("kaylas-store", `worker-${code}`).code, code);
}

async function rpcAcceptanceProfileIsEnforced(definitionsPath, dir) {
  const root = H.tmp("factoryv2-rpc-profile-");
  const adapter = {
    startThread: () => ({
      run: async (prompt, hooks) => {
        hooks.onThreadId("rpc-profile-session");
        const hashes = [...prompt.matchAll(/"sha256":"([0-9a-f]{64})"/g)].map((match) => match[1]);
        const jobId = prompt.match(/^JOB ([^\n]+)/m)?.[1];
        return {
          engine: "claude",
          sessionId: "rpc-profile-session",
          finalResponse: JSON.stringify({
            done: true,
            channelId: "kaylas-store",
            jobId,
            summary: "The report meets the required total of 73.",
            evidence: ["file:report.txt"],
            contextManifestSha256: hashes.at(-1)
          }),
          metadata: {}
        };
      }
    }),
    resumeThread: () => adapter.startThread(),
    cancelThread: () => false
  };
  const registry = createChannelRegistry({ root, definitionsPath, adapterFactory: () => adapter });
  registry.ensureDefaults();
  const tools = createChannelTools(registry);
  const profile = [{ type: "fieldEquals", ref: "file:report.txt", field: "measured_total", equals: "73" }];
  fs.writeFileSync(path.join(dir, "report.txt"), "measured_total=12\n");
  const rejected = await tools["channel.send"]({ channelId: "kaylas-store", jobId: "rpc-profile-reject", objective: "Check report", contextRefs: ["file:report.txt"], evidenceRequired: ["file:report.txt"], acceptanceProfile: profile });
  assert.deepStrictEqual(rejected.envelope.acceptanceProfile, profile);
  assert.strictEqual((await registry.runNext()).result.code, "OBJECTIVE_UNVERIFIED");
  fs.writeFileSync(path.join(dir, "report.txt"), "measured_total=73\n");
  await tools["channel.send"]({ channelId: "kaylas-store", jobId: "rpc-profile-pass", objective: "Check report", contextRefs: ["file:report.txt"], evidenceRequired: ["file:report.txt"], acceptanceProfile: profile });
  assert.strictEqual((await registry.runNext()).result.verified, true);
}

async function measuredTotalPredicateFails(definitionsPath, dir) {
  fs.writeFileSync(path.join(dir, "report.txt"), "measured_total=12\n");
  const root = H.tmp("factoryv2-measured-total-");
  const adapter = {
    startThread: () => ({
      run: async (prompt, hooks) => {
        hooks.onThreadId("measured-session");
        const hashes = [...prompt.matchAll(/"sha256":"([0-9a-f]{64})"/g)].map((match) => match[1]);
        return {
          engine: "claude",
          sessionId: "measured-session",
          finalResponse: JSON.stringify({
            done: true,
            channelId: "kaylas-store",
            jobId: "measured-job",
            summary: "The report meets the required total of 73.",
            evidence: ["file:report.txt"],
            contextManifestSha256: hashes.at(-1)
          }),
          metadata: {}
        };
      }
    }),
    resumeThread: () => { throw new Error("unexpected resume"); },
    cancelThread: () => false
  };
  const registry = createChannelRegistry({ root, definitionsPath, adapterFactory: () => adapter });
  registry.ensureDefaults();
  registry.send("kaylas-store", "check measured total", {
    jobId: "measured-job",
    contextRefs: ["file:report.txt"],
    evidenceRequired: ["file:report.txt"],
    doneCondition: "Read report.txt and verify measured_total equals 73; a value of 12 fails."
  });
  const run = await registry.runNext();
  assert.strictEqual(run.result.code, "OBJECTIVE_UNVERIFIED");
  assert.strictEqual(run.result.verification.actual, "12");
}

async function requiredRefFailure(definitionsPath) {
  const registry = createChannelRegistry({ root: H.tmp("factoryv2-required-ref-"), definitionsPath });
  registry.ensureDefaults();
  registry.send("kaylas-store", "required ref must resolve", { jobId: "required-ref-job", primingRefs: ["capsule"], requiredRefs: ["file:missing.txt"] });
  const run = await registry.runNext();
  assert.strictEqual(run.result.code, "CONTEXT_MISSING");
}

async function realJarvisPackRefsResolve(definitionsPath, dir) {
  for (const [kind, body] of [
    ["store", "store fact: kaylas conversion source\n"],
    ["project", "project fact: kaylas scoped workspace\n"],
    ["active-priorities", "priority: improve conversion clarity\n"],
    ["project-memory", "memory: Kaylas uses Shopify source truth\n"],
    ["daily-log", "log: no live business write performed\n"],
    ["skill", "commerce analytics skill source\n"],
  ]) {
    const folder = path.join(dir, ".factoryv2", "context", kind);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, kind === "skill" ? "commerce-analytics.md" : "kaylas.md"), body);
  }
  const root = H.tmp("factoryv2-real-pack-refs-");
  const registry = createChannelRegistry({ root, definitionsPath });
  registry.ensureDefaults();
  const refs = ["project:kaylas", "store:kaylas", "active-priorities:kaylas", "project-memory:kaylas", "daily-log:kaylas", "skill:commerce-analytics"];
  registry.send("kaylas-store", "resolve real Kaylas pack refs", {
    jobId: "real-pack-refs",
    primingRefs: refs,
    deterministic: { kind: "invoice-compare", records: [] }
  });
  await registry.runNext();
  const context = journal.load(root).events.find((event) => event.type === "channel.context.resolved" && event.jobId === "real-pack-refs");
  assert.deepStrictEqual(context.manifest.refs.map((ref) => ref.ref), refs);
  assert.ok(context.manifest.refs.every((ref) => ref.sha256 && ref.bytes > 0));
}

async function sessionPathCannotEscape(definitionsPath) {
  const root = H.tmp("factoryv2-session-path-");
  const registry = createChannelRegistry({ root, definitionsPath });
  registry.ensureDefaults();
  registry.send("invoice-audit", "path safety", { jobId: "../../snapshot", deterministic: { kind: "invoice-compare", records: [] } });
  await registry.runNext();
  assert.strictEqual(fs.existsSync(path.join(root, "snapshot.json")), false);
  assert.strictEqual(fs.existsSync(path.join(root, "sessions", "invoice-audit", "..", "..", "snapshot.json")), false);
  const sessionFiles = fs.readdirSync(path.join(root, "sessions", "invoice-audit"));
  assert.strictEqual(sessionFiles.length, 1);
  assert.match(sessionFiles[0], /^[0-9a-f]{64}\.json$/);
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

function localRpc(registry, method, params) {
  const body = Buffer.from(JSON.stringify({ id: "test", method, params }));
  const request = new MockRequest(body);
  const response = new MockResponse();
  return handle(request, response, createChannelTools(registry)).then(() => JSON.parse(response.body));
}

class MockRequest {
  constructor(body) {
    this.method = "POST";
    this.url = "/rpc";
    this.handlers = {};
    process.nextTick(() => {
      this.handlers.data?.(body);
      this.handlers.end?.();
    });
  }
  on(event, handler) {
    this.handlers[event] = handler;
    return this;
  }
  destroy() {}
}

class MockResponse {
  constructor() {
    this.body = "";
  }
  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
  }
  end(body) {
    this.body = body;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

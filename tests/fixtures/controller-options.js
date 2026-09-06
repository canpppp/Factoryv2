"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createController: productionController } = require("../../src/controller");
const { compileWorkerPolicy } = require("../../src/adapters/worker-policy");

// Explicit test-only profiles for the pre-existing fake state-machine journeys.
function createController({ root, adapter, ...rest }) {
  const executable = fs.realpathSync(process.execPath);
  const sha = createHash("sha256").update(fs.readFileSync(executable)).digest("hex");
  const business = path.join(root, "worktrees"); fs.mkdirSync(business, { recursive: true });
  const stateRoot = path.join(root, "fake-role-state"); fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const rolePolicies = Object.fromEntries(["worker", "reviewer"].map((role) => [role, {
    engine: "claude", command: executable, model: "fixture", maxTurns: role === "worker" ? 12 : 6,
    allowedTools: role === "worker" ? ["Read", "Write"] : ["Read"],
    workerPolicy: { executableSha256: sha, protocolFixtureSha256: sha, auth: { mode: "none" }, stateRoot,
      readRoots: [business], writeRoots: role === "worker" ? [business] : [], tools: ["Read", "Write"] }
  }]));
  const adapterFactory = (config) => {
    const wrap = (method, id, options) => {
      const profile = compileWorkerPolicy(config.engine, config, options);
      const inner = method === "startThread" ? adapter.startThread(options) : adapter.resumeThread(id, options);
      const metadata = (cause) => ({ profileDigest: profile.digest, terminationCause: cause, ownedRunSettled: true, externalEffects: "NONE_DECLARED", synthetic: true });
      return { ...inner, profile, run: async (prompt, hooks) => {
        try { return { ...await inner.run(prompt, hooks), origin: "synthetic", metadata: metadata("EXIT") }; }
        catch (error) {
          // These scripts execute synchronously in this test process, not a worker OS process.
          error.details = { receipt: { metadata: metadata(error.code === "TIMEOUT" ? "TIMEOUT" : "EXIT") } };
          throw error;
        }
      } };
    };
    return { startThread: (options) => wrap("startThread", null, options), resumeThread: (id, options) => wrap("resumeThread", id, options) };
  };
  return productionController({ root, rolePolicies, adapterFactory, ...rest });
}

module.exports = { createController };

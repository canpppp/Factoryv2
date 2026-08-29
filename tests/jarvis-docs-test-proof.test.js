"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { createController } = require("../src/controller");
const { fakeAdapter } = require("../src/fake-agent");
const journal = require("../src/journal");
const H = require("./helpers");

async function main() {
  const source = "/Users/can/Documents/Codex/jarvis-rc-main-2571e9a-trusted";
  if (!fs.existsSync(path.join(source, "agent"))) {
    console.log("JARVIS docs/test-only proof skipped: trusted checkout not present");
    return;
  }

  const root = H.tmp("factoryv2-jarvis-root-");
  const repo = H.makeJarvisDocsTestRepo(source);
  const approve = JSON.stringify({ verdict: "approve", findings: [], summary: "docs/test-only proof is bounded" });
  const adapter = fakeAdapter({
    scripts: {
      "MISSION mission-": [
        { type: "write", path: "docs/FACTORYV2_PROOF.md", content: "# Factory V2 Proof\n\nDocs/test-only mission executed in a disposable clone.\n" },
        { type: "write", path: "agent/tests/factoryv2-proof-test.js", content: "const fs = require('node:fs'); const assert = require('node:assert'); assert.ok(fs.existsSync('docs/FACTORYV2_PROOF.md'));\n" },
        { type: "say", text: "added docs/test proof only" }
      ],
      "REVIEW mission-": [{ type: "say", text: approve }]
    }
  });

  const c = createController({ root, adapter });
  c.enqueueGoal({
    goal: "Prove Factory V2 can run a JARVIS docs/test-only mission without product deployment",
    repo,
    missionOverrides: {
      ownedFiles: ["docs/**", "agent/tests/**"],
      verifyCommands: ["node agent/tests/factoryv2-proof-test.js"],
      title: "JARVIS docs/test-only Factory V2 proof"
    }
  });
  await c.run({ maxSteps: 20 });

  const state = journal.load(root);
  const mission = [...state.missions.values()][0];
  assert.strictEqual(mission.state, "ready_for_human_check");
  assert.deepStrictEqual(mission.ownedFiles, ["docs/**", "agent/tests/**"]);
  assert.ok(state.events.some((e) => e.type === "verification.finished" && e.results.every((r) => r.passed)));
  assert.ok(state.events.every((e) => e.type !== "deploy.performed" && e.type !== "merge.performed"));
  assert.ok(!fs.existsSync(path.join(source, "docs/FACTORYV2_PROOF.md")), "trusted JARVIS checkout was modified");
  assert.match(H.git(repo, ["show", "main:AGENTS.md"]), /Codex|JARVIS|jarvis/i);
  console.log("JARVIS docs/test-only proof passed");
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});

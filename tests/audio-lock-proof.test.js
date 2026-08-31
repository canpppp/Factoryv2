"use strict";

const assert = require("node:assert/strict");
const policy = require("../src/policy");

const env = { FACTORY_AUDIO_LOCKED: "1" };
const check = (command, trustDomain = "jarvis") => policy.commandAllowed(command, { trustDomain, env });

for (const command of [
  "say hello",
  "/tmp/native/jarvis-play --rate 24000",
  "afplay fixture.wav",
  "node scripts/persistent-candidate-spoken-acceptance.js",
  "node agent/tests/tts-stream-test.js",
  "osascript -e 'set volume output volume 50'",
  "SwitchAudioSource -s Speakers",
  "spotify play",
  "open /Applications/Claude.app",
  "/usr/bin/open /tmp/JARVIS-Candidate.app",
  "node scripts/persistent-candidate-typed-acceptance.js --existing-app /tmp/JARVIS.app",
  "npm test",
  "./scripts/verify.sh"
]) {
  const result = check(command);
  assert.equal(result.ok, false, `expected audio lock to refuse: ${command}`);
  assert.equal(result.reason, "audio-locked");
}

assert.equal(check("node scripts/persistent-candidate-typed-acceptance.js --existing-app /tmp/JARVIS.app --audio-locked").ok, true);
assert.equal(check("VERIFY_SUITES_OVERRIDE='audio-lock-test shutdown-test' ./scripts/verify.sh").ok, true);
assert.equal(check("npm test", "factoryv2").ok, true);
assert.equal(policy.commandAllowed("say hello", { trustDomain: "jarvis", env: {} }).ok, true);

console.log("audio-lock-proof: pass");

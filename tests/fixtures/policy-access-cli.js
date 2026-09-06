"use strict";

const fs = require("node:fs");
const argv = process.argv.slice(2);
const option = (name) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : null;
const capture = (fn) => { try { fn(); return { ok: true }; } catch (error) { return { ok: false, code: error.code }; } };
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  const tools = (option("--tools") || "").split(",");
  const denied = (option("--disallowedTools") || "").split(",");
  const observed = {
    argv,
    reads: (request.reads || []).map((file) => ({ file, ...capture(() => fs.readFileSync(file)) })),
    writes: (request.writes || []).map((file) => ({ file, ...capture(() => fs.writeFileSync(file, "fixture-write")) })),
    toolRead: tools.includes("Read") && !denied.includes("Read")
      ? capture(() => fs.readFileSync(request.reads[0])) : { ok: false, code: "TOOL_UNAVAILABLE" }
  };
  process.stdout.write(`${JSON.stringify({ type: "result", session_id: option("--resume") || option("--session-id"), is_error: false, result: JSON.stringify(observed) })}\n`);
});

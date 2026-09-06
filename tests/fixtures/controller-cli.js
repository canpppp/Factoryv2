"use strict";

const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : null;
const access = (fn) => { try { fn(); return { ok: true }; } catch (error) { return { ok: false, code: error.code }; } };
let prompt = "";
process.stdin.on("data", (data) => { prompt += data; });
process.stdin.on("end", () => {
  const role = prompt.startsWith("REVIEW ") ? "reviewer" : "worker";
  const request = JSON.parse(fs.readFileSync("proof-request.json", "utf8"));
  const sessionId = option("--resume") || option("--session-id");
  const observed = { role, sessionId, args, home: process.env.HOME,
    read: access(() => fs.readFileSync("README.md")),
    outside: access(() => fs.readFileSync(request.outside)),
    peerState: access(() => fs.readFileSync(request.peerState)),
    write: access(() => fs.appendFileSync("src/proof.txt", `${role}\n`)) };
  fs.appendFileSync(path.join(process.env.HOME, "trace.jsonl"), `${JSON.stringify(observed)}\n`);
  const result = role === "reviewer"
    ? JSON.stringify({ verdict: "reject", findings: ["fixture stops before integration"], summary: "read-only review observed" })
    : JSON.stringify(observed);
  process.stdout.write(`${JSON.stringify({ type: "result", session_id: sessionId, is_error: false, result })}\n`);
});

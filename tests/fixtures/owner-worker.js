"use strict";
const fs = require("node:fs");
const args = process.argv.slice(2);
let input = "";
const deadline = Date.now() + 6000;
setTimeout(() => process.exit(93), 6500);
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  fs.appendFileSync("worker-entered", "invocation\n");
  const poll = setInterval(() => {
    if (Date.now() > deadline) process.exit(94);
    if (!fs.existsSync("worker-release")) return;
    clearInterval(poll);
    const session = args[args.indexOf("--session-id") + 1];
    process.stdout.write(JSON.stringify({ type: "result", session_id: session, is_error: false, result: "synthetic bounded owner fixture complete" }) + "\n", () => process.exit(0));
  }, 10);
});

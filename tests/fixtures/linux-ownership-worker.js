"use strict";

const fs = require("node:fs");
const { spawn } = require("node:child_process");
const [dir, token, expiryText, role = "leader", mode = "tree"] = process.argv.slice(2);
const expiry = Number(expiryText);
if (!dir || !token || !Number.isSafeInteger(expiry) || expiry > Date.now() + 30000) process.exit(64);
setTimeout(() => process.exit(90), Math.max(1, expiry - Date.now()));
process.on("SIGTERM", () => {
  if (role === "leader") process.stdout.write(`${JSON.stringify({ type: "late-success", token })}\n`);
});
if (role !== "grandchild") {
  const child = spawn(process.execPath, [__filename, dir, token, expiryText, role === "leader" ? "child" : "grandchild", mode], { detached: true, stdio: "ignore", env: process.env });
  child.unref();
}
fs.writeFileSync(`${dir}/${role}.json`, JSON.stringify({ pid: process.pid, token }));
if (role === "leader") {
  const poll = setInterval(() => {
    if (!fs.existsSync(`${dir}/go`)) return;
    clearInterval(poll);
    if (mode === "overflow") process.stdout.write("x".repeat(8192));
    else if (mode === "exit") {
      process.stdout.write(`${JSON.stringify({ type: "complete", token })}\n`);
      process.exit(0);
    } else process.stdout.write(`${JSON.stringify({ type: "ready", token })}\n`);
  }, 10);
}

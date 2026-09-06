"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");

const mode = process.argv[2];

function write(line) {
  process.stdout.write(`${line}\n`);
}

function json(value) {
  write(JSON.stringify(value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recordPid(name, pid = process.pid) {
  const dir = process.env.PROCESS_LIFECYCLE_PID_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/${name}.pid`, `${pid}`);
}

async function main() {
  if (mode === "allowed") {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    await new Promise((resolve) => process.stdin.on("end", resolve));
    json({ type: "env", value: process.env.PROCESS_LIFECYCLE_SENTINEL || null });
    json({ type: "ambient", value: process.env.PROCESS_LIFECYCLE_AMBIENT || null });
    json({ type: "input", value: Buffer.concat(chunks).toString("utf8") });
    process.stderr.write("fixture-stderr");
    return;
  }

  if (mode === "oversized-no-newline") {
    process.stdout.write("x".repeat(Number(process.argv[3] || 1024)));
    await sleep(60000);
    return;
  }

  if (mode === "total-flood") {
    const count = Number(process.argv[3] || 100);
    for (let i = 0; i < count; i += 1) json({ type: "flood", i, data: "x".repeat(128) });
    return;
  }

  if (mode === "events-flood") {
    const count = Number(process.argv[3] || 100);
    for (let i = 0; i < count; i += 1) json({ type: "event", i });
    return;
  }

  if (mode === "invalid-lines") {
    const count = Number(process.argv[3] || 20);
    for (let i = 0; i < count; i += 1) write(`not-json-${i}`);
    return;
  }

  if (mode === "stderr-flood") {
    process.stderr.write("e".repeat(Number(process.argv[3] || 4096)));
    return;
  }

  if (mode === "slow") {
    json({ type: "ready" });
    await sleep(Number(process.argv[3] || 60000));
    return;
  }

  if (mode === "term-tree") {
    process.on("SIGTERM", () => {});
    recordPid("parent");
    const child = spawn(process.execPath, [__filename, "term-child"], {
      detached: false,
      stdio: "ignore",
      env: process.env
    });
    recordPid("child", child.pid);
    json({ type: "tree-ready", parent: process.pid, child: child.pid });
    await sleep(60000);
    return;
  }

  if (mode === "term-child") {
    process.on("SIGTERM", () => {});
    recordPid("grandchild-parent");
    const grandchild = spawn(process.execPath, [__filename, "term-grandchild"], {
      detached: false,
      stdio: "ignore",
      env: process.env
    });
    recordPid("grandchild", grandchild.pid);
    await sleep(60000);
    return;
  }

  if (mode === "term-grandchild") {
    process.on("SIGTERM", () => {});
    await sleep(60000);
    return;
  }

  process.stderr.write(`unknown mode: ${mode}`);
  process.exitCode = 64;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});

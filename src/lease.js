"use strict";

const fs = require("node:fs");
const path = require("node:path");
const journal = require("./journal");

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquire(root, name = "controller") {
  const p = journal.ensure(root);
  const file = path.join(p.locks, `${name}.json`);
  try {
    const fd = fs.openSync(file, "wx");
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, takenAt: new Date().toISOString() }));
    fs.closeSync(fd);
    journal.append(root, { type: "lease.acquired", lease: name, pid: process.pid });
    return { ok: true, file };
  } catch {
    try {
      const held = JSON.parse(fs.readFileSync(file, "utf8"));
      if (held.pid && !alive(held.pid)) {
        fs.unlinkSync(file);
        journal.append(root, { type: "lease.reclaimed", lease: name, stalePid: held.pid });
        return acquire(root, name);
      }
      return { ok: false, reason: "lease-held", holder: held };
    } catch (e) {
      return { ok: false, reason: "lease-unreadable", error: e.message };
    }
  }
}

function release(root, lease) {
  if (!lease || !lease.file) return;
  try { fs.unlinkSync(lease.file); } catch {}
  journal.append(root, { type: "lease.released", lease: "controller", pid: process.pid });
}

async function withLease(root, fn) {
  const l = acquire(root);
  if (!l.ok) return { ok: false, summary: `blocked: ${l.reason}` };
  try { return await fn(); } finally { release(root, l); }
}

module.exports = { acquire, release, withLease, alive };

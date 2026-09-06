"use strict";

const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { randomUUID } = require("node:crypto");
const journal = require("./journal");

function fail(code) { throw Object.assign(new Error(code), { code }); }
function stat(file) {
  try { return fs.lstatSync(file); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
}
function identity(pid) {
  if (process.platform !== "linux") return { pid, start: null, boot: null };
  const fields = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(/\) /).pop().split(" ");
  return { pid, start: fields[19], boot: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() };
}
function dead(saved) {
  if (!Number.isSafeInteger(saved?.pid) || saved.pid < 1) return false;
  try {
    process.kill(saved.pid, 0);
    if (process.platform !== "linux" || !saved.start || !saved.boot) return false;
    const current = identity(saved.pid);
    return current.start !== saved.start || current.boot !== saved.boot;
  } catch (e) { return e.code === "ESRCH"; }
}
function rootIdentity(root) {
  const canonical = fs.realpathSync(root);
  for (const dir of [root, path.join(root, "daemon")]) {
    const s = stat(dir);
    if (!s?.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o022)) fail("OWNER_ROOT_UNSAFE");
  }
  if (canonical !== path.resolve(root)) fail("OWNER_ROOT_UNSAFE");
  const s = stat(root);
  return { path: canonical, dev: s.dev, ino: s.ino };
}
function same(a, b) { return Boolean(a && b && a.dev === b.dev && a.ino === b.ino); }
function read(root) {
  const file = path.join(root, "daemon", "owner.json");
  const s = stat(file);
  if (!s) return null;
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o077)) fail("OWNER_UNKNOWN");
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { fail("OWNER_UNKNOWN"); }
}
function syncDirectory(dir) {
  const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function write(root, record) {
  const file = path.join(root, "daemon", "owner.json");
  const tmp = file + "." + randomUUID();
  const fd = fs.openSync(tmp, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file); syncDirectory(path.dirname(file));
}
async function refused(endpoint) {
  return new Promise((resolve) => {
    const socket = net.connect(endpoint);
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(false));
    socket.once("error", (e) => finish(e.code === "ECONNREFUSED"));
  });
}
async function acquire(root, endpoint) {
  journal.ensure(root);
  const boundRoot = rootIdentity(root);
  if (endpoint !== path.join(boundRoot.path, "daemon", "channel-api.sock")) fail("OWNER_ENDPOINT_UNSAFE");
  const guard = path.join(root, "daemon", "owner-acquire");
  try { fs.mkdirSync(guard, { mode: 0o700 }); } catch (e) { if (e.code === "EEXIST") fail("OWNER_UNKNOWN"); throw e; }
  try {
    const old = read(root);
    const socket = stat(endpoint);
    if (old) {
      if (old.root?.path !== boundRoot.path || !same(old.root, boundRoot) || old.endpoint !== endpoint || !old.generation) fail("OWNER_UNKNOWN");
      if (!dead(old.process)) fail("OWNER_UNAVAILABLE");
    }
    if (socket) {
      if (!old || !socket.isSocket() || !same(old.socket, socket) || !await refused(endpoint)) fail("OWNER_UNKNOWN");
      if (!same(socket, stat(endpoint))) fail("OWNER_UNKNOWN");
      fs.unlinkSync(endpoint);
    }
    const record = { version: 1, root: boundRoot, generation: randomUUID(), endpoint, process: identity(process.pid), ready: false, socket: null };
    write(root, record);
    function assertOwned() {
      if (read(root)?.generation !== record.generation || !same(rootIdentity(root), record.root)) fail("OWNER_CHANGED");
      if (record.socket && !same(record.socket, stat(endpoint))) fail("OWNER_CHANGED");
    }
    return {
      record,
      assertOwned,
      bound() {
        assertOwned();
        const s = stat(endpoint);
        if (!s?.isSocket() || s.uid !== process.getuid()) fail("OWNER_UNKNOWN");
        record.socket = { dev: s.dev, ino: s.ino };
        write(root, record);
      },
      ready() { assertOwned(); if (!record.socket) fail("OWNER_NOT_READY"); record.ready = true; write(root, record); },
      release() {
        if (read(root)?.generation !== record.generation) fail("OWNER_CHANGED");
        if (stat(endpoint)) fail("OWNER_CLEANUP_UNKNOWN");
        fs.unlinkSync(path.join(root, "daemon", "owner.json"));
        syncDirectory(path.join(root, "daemon"));
      }
    };
  } finally { fs.rmdirSync(guard); }
}

module.exports = { acquire, read, rootIdentity, same, fail };

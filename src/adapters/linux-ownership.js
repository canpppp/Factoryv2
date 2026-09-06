"use strict";

const fs = require("node:fs");
const INFO_BYTES = 4096;

function stat(pid) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return { pid, startTime: fields[19], state: fields[0], ppid: Number(fields[1]) };
  } catch (error) { if (["ENOENT", "ESRCH"].includes(error.code)) return null; throw error; }
}

// FD3 belongs to bwrap, not the worker. FD4 prevents worker execution until
// the host has pinned the backend's exact PID-namespace init identity.
function createLinuxOwnership(backendPid) {
  let bytes = Buffer.alloc(0), info = null, ended = false, invalid = false;
  let init = null, namespaceFd = null, state = "PENDING";
  function data(chunk) {
    if (ended || invalid) { invalid = true; return; }
    if (bytes.length + chunk.length > INFO_BYTES) { invalid = true; bytes = Buffer.alloc(0); return; }
    bytes = Buffer.concat([bytes, chunk]);
  }
  function end() {
    ended = true;
    try {
      info = JSON.parse(bytes.toString("utf8"));
      if (!Number.isSafeInteger(info["child-pid"]) || info["child-pid"] <= 1
        || !Number.isSafeInteger(info["pid-namespace"]) || info["pid-namespace"] <= 0) invalid = true;
    } catch { invalid = true; }
    bytes = Buffer.alloc(0);
  }
  function observe() {
    if (invalid) return state = "UNKNOWN";
    if (!ended) return state = "PENDING";
    let opening = null;
    try {
      const current = stat(info["child-pid"]);
      if (init) {
        if (!current || current.startTime !== init.startTime || current.state === "Z" || current.state === "X") return state = "TERMINATED";
        return state = "ACTIVE";
      }
      if (!current || current.state === "Z" || current.ppid !== backendPid) return state = "UNKNOWN";
      const namespace = `pid:[${info["pid-namespace"]}]`;
      const local = fs.readFileSync(`/proc/${current.pid}/status`, "utf8").match(/^NSpid:\s+(.+)$/m)?.[1].trim().split(/\s+/).map(Number);
      if (local?.at(-1) !== 1 || fs.readlinkSync(`/proc/${current.pid}/ns/pid`) !== namespace
        || fs.readlinkSync("/proc/self/ns/pid") === namespace) return state = "UNKNOWN";
      const fd = opening = fs.openSync(`/proc/${current.pid}/ns/pid`, "r");
      const again = stat(current.pid);
      if (fs.readlinkSync(`/proc/self/fd/${fd}`) !== namespace || again?.startTime !== current.startTime || again.ppid !== backendPid) {
        return state = "UNKNOWN";
      }
      namespaceFd = fd;
      init = { pid: current.pid, startTime: current.startTime, namespace };
      return state = "ACTIVE";
    } catch {
      // Setup can temporarily make /proc metadata unreadable. Keep the worker
      // blocked and retry within the existing run/cleanup deadlines.
      return state = "UNKNOWN";
    } finally { if (opening !== null && opening !== namespaceFd) fs.closeSync(opening); }
  }
  function receipt() { return { boundary: "linux-pid-namespace-v1", state, init, infoBytesLimit: INFO_BYTES }; }
  function close() { if (namespaceFd !== null) { fs.closeSync(namespaceFd); namespaceFd = null; } }
  return { data, end, observe, receipt, close, invalid: () => invalid };
}

module.exports = { createLinuxOwnership, INFO_BYTES };

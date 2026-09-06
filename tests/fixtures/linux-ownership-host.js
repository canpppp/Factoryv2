"use strict";

const fs = require("node:fs");

function identity(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    let namespace = null;
    try { namespace = fs.readlinkSync(`/proc/${pid}/ns/pid`); }
    catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) throw error; }
    return { pid: Number(pid), start: fields[19], state: fields[0], ppid: Number(fields[1]), group: Number(fields[2]), session: Number(fields[3]), namespace };
  } catch (error) { if (["ENOENT", "ESRCH"].includes(error.code)) return null; throw error; }
}

function same(saved) {
  const current = identity(saved.pid);
  return current?.start === saved.start ? current : null;
}

function inventory(token, namespaces = []) {
  const result = [];
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      if (fs.statSync(`/proc/${name}`).uid !== process.getuid()) continue;
      const current = identity(name);
      if (!current) continue;
      const argv = fs.readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0");
      if (argv.includes(token) || namespaces.includes(current.namespace)) result.push(current);
    } catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) throw error; }
  }
  return result;
}

// Only a just-revalidated test identity may receive a signal, never a name/group.
function signal(saved, signalName) {
  const current = same(saved);
  if (!current || current.state === "Z") return false;
  process.kill(current.pid, signalName);
  return true;
}

module.exports = { identity, same, inventory, signal };

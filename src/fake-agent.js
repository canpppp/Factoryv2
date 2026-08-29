"use strict";

const fs = require("node:fs");
const path = require("node:path");

let seq = 0;
const nextId = (prefix) => `${prefix}-${String(++seq).padStart(4, "0")}`;

function fakeAdapter({ scripts = {}, defaultScript = [] } = {}) {
  const threads = new Map();

  function scriptFor(input, round) {
    const text = typeof input === "string" ? input : JSON.stringify(input);
    const key = Object.keys(scripts).filter((k) => text.includes(k)).sort((a, b) => b.length - a.length)[0];
    const script = key ? scripts[key] : defaultScript;
    return typeof script === "function" ? script({ round, input }) : script;
  }

  function thread(id, opts) {
    const rec = threads.get(id) || { id, opts, turns: [] };
    rec.opts = opts;
    threads.set(id, rec);
    return {
      id,
      run: async (input, hooks = {}) => {
        hooks.onThreadId && hooks.onThreadId(id);
        const round = rec.turns.length + 1;
        let finalResponse = "";
        for (const step of scriptFor(input, round)) {
          if (step.type === "write") {
            if (opts.readOnly) throw new Error(`read-only thread tried to write ${step.path}`);
            const target = path.resolve(opts.cwd, step.path);
            if (!target.startsWith(path.resolve(opts.cwd) + path.sep)) throw new Error("write escaped worktree");
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, step.content);
          }
          if (step.type === "say") finalResponse = step.text;
          if (step.type === "crash") {
            rec.turns.push({ input, interrupted: true });
            const e = new Error(step.message || "agent interrupted");
            e.code = "INTERRUPTED";
            throw e;
          }
          if (step.type === "timeout") {
            rec.turns.push({ input, timeout: true });
            const e = new Error(step.message || "agent timeout");
            e.code = "TIMEOUT";
            throw e;
          }
        }
        rec.turns.push({ input, finalResponse });
        return { threadId: id, finalResponse };
      }
    };
  }

  return {
    startThread(opts) { return thread(nextId("thread"), opts); },
    resumeThread(id, opts) {
      if (!threads.has(id)) {
        const e = new Error(`thread not found: ${id}`);
        e.code = "THREAD_NOT_FOUND";
        throw e;
      }
      return thread(id, opts);
    },
    turnsOf(id) { return threads.get(id) ? threads.get(id).turns.length : 0; },
    _threads: threads
  };
}

module.exports = { fakeAdapter };

"use strict";

const { spawn } = require("node:child_process");
const readline = require("node:readline");

function runJsonlProcess({ command, args, cwd, input, timeoutMs = 300000, env = {}, onEvent, onSpawn }) {
  let child = null;
  let timedOut = false;
  let cancelled = false;
  let timer = null;

  const promise = new Promise((resolve, reject) => {
    const events = [];
    const invalidLines = [];
    let stderr = "";
    child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    if (onSpawn) onSpawn(child);

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        events.push(event);
        if (onEvent) onEvent(event);
      } catch {
        invalidLines.push(line.slice(0, 2000));
      }
    });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-12000); });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, events, invalidLines, stderr, timedOut, cancelled });
    });

    child.stdin.end(String(input || ""));
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child && child.kill("SIGKILL"), 2000);
      killTimer.unref();
    }, timeoutMs);
    timer.unref();
  });

  return {
    promise,
    cancel() {
      if (!child || child.exitCode !== null) return false;
      cancelled = true;
      child.kill("SIGTERM");
      return true;
    }
  };
}

function classifiedError(message, details = {}) {
  const text = `${message || ""}\n${details.stderr || ""}`;
  const error = new Error(message || "agent process failed");
  if (details.timedOut) error.code = "TIMEOUT";
  else if (details.cancelled) error.code = "CANCELLED";
  else if (/rate.?limit|quota|capacity|overloaded|too many requests|529|429/i.test(text)) error.code = "PROVIDER_QUOTA";
  else if (/session|thread/.test(text.toLowerCase()) && /not found|unknown|invalid/.test(text.toLowerCase())) error.code = "THREAD_NOT_FOUND";
  else if (/auth|login|credential|unauthorized|forbidden/i.test(text)) error.code = "AUTH_REQUIRED";
  else error.code = "AGENT_FAILED";
  error.details = details;
  return error;
}

module.exports = { runJsonlProcess, classifiedError };

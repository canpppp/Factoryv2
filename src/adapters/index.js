"use strict";

const { createClaudeAdapter } = require("./claude");
const { createCodexAdapter } = require("./codex");

function createAdapter({ engine = process.env.FACTORYV2_ENGINE || "claude", ...config } = {}) {
  if (engine === "claude") return createClaudeAdapter(config);
  if (engine === "codex") return createCodexAdapter(config);
  throw new Error(`unsupported agent engine: ${engine}`);
}

module.exports = { createAdapter, createClaudeAdapter, createCodexAdapter };

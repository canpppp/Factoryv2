"use strict";

const fs = require("node:fs");
const http = require("node:http");
const journal = require("./journal");
const { createChannelTools } = require("./jarvis-tools");

const MAX_BODY_BYTES = 64 * 1024;

function createChannelApi({ root, registry, socketPath: configuredSocketPath } = {}) {
  if (!root || !registry) throw new Error("channel API needs root and registry");
  const tools = createChannelTools(registry);
  const socketPath = configuredSocketPath || journal.paths(root).daemon + "/channel-api.sock";
  let server;

  async function start() {
    journal.ensure(root);
    removeManagedSocket(socketPath);
    server = http.createServer((request, response) => handle(request, response, tools));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    fs.chmodSync(socketPath, 0o600);
    journal.append(root, { type: "channel.api.started", socketPath, pid: process.pid });
    return socketPath;
  }

  async function close() {
    if (!server) return;
    await new Promise((resolve) => server.close(resolve));
    server = null;
    removeManagedSocket(socketPath);
    journal.append(root, { type: "channel.api.stopped", socketPath, pid: process.pid });
  }

  return { start, close, socketPath };
}

async function handle(request, response, tools) {
  if (request.method === "GET" && request.url === "/health") return send(response, 200, { ok: true });
  if (request.method !== "POST" || request.url !== "/rpc") return send(response, 404, failure("NOT_FOUND", "unknown endpoint"));
  try {
    const payload = JSON.parse(await readBody(request));
    if (!payload || typeof payload.method !== "string" || !tools[payload.method]) return send(response, 400, failure("METHOD_DENIED", "unknown channel method"));
    const result = await tools[payload.method](payload.params || {});
    return send(response, 200, { ok: true, id: payload.id || null, result });
  } catch (error) {
    const status = error.code === "BODY_TOO_LARGE" ? 413 : 400;
    return send(response, status, failure(error.code || "CHANNEL_API_ERROR", error.message));
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const error = new Error("request body exceeds limit");
        error.code = "BODY_TOO_LARGE";
        reject(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function send(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function failure(code, message) {
  return { ok: false, error: { code, message } };
}

function removeManagedSocket(socketPath) {
  try {
    const stat = fs.lstatSync(socketPath);
    if (!stat.isSocket()) throw new Error(`refusing to replace non-socket path: ${socketPath}`);
    fs.unlinkSync(socketPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

module.exports = { createChannelApi, handle, MAX_BODY_BYTES };

"use strict";

const fs = require("node:fs");
const http = require("node:http");
const journal = require("./journal");
const { createChannelTools } = require("./jarvis-tools");
const ownership = require("./execution-owner");

const MAX_BODY_BYTES = 64 * 1024;

function createChannelApi({ root, registry, socketPath: configuredSocketPath, extraTools = {}, beforeReady = () => {} } = {}) {
  if (!root || !registry) throw new Error("channel API needs root and registry");
  const tools = { ...createChannelTools(registry), ...extraTools };
  const socketPath = configuredSocketPath || journal.paths(root).daemon + "/channel-api.sock";
  let server;
  let owner;

  async function start() {
    journal.ensure(root);
    owner = await ownership.acquire(root, socketPath);
    server = http.createServer((request, response) => handle(request, response, tools, () => {
      owner.assertOwned();
      if (!owner.record.ready) ownership.fail("OWNER_NOT_READY");
      return owner.record;
    }));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    fs.chmodSync(socketPath, 0o600);
    owner.bound();
    await beforeReady(owner);
    owner.ready();
    journal.append(root, { type: "channel.api.started", socketPath, pid: process.pid });
    return socketPath;
  }

  async function close() {
    if (!server) return;
    owner.assertOwned();
    owner.record.ready = false;
    await new Promise((resolve) => server.close(resolve));
    server = null;
    owner.release();
    journal.append(root, { type: "channel.api.stopped", socketPath, pid: process.pid });
  }

  return { start, close, socketPath, assertOwned: () => owner.assertOwned(), get owner() { return owner?.record; } };
}

async function handle(request, response, tools, context) {
  try {
    const owner = context?.();
    if (request.method === "GET" && request.url === "/health") return send(response, 200, { ok: true, ...(owner ? { owner } : {}) });
    if (request.method !== "POST" || request.url !== "/rpc") return send(response, 404, failure("NOT_FOUND", "unknown endpoint"));
    const payload = JSON.parse(await readBody(request));
    if (!payload || typeof payload.method !== "string" || !Object.hasOwn(tools, payload.method)) return send(response, 400, failure("METHOD_DENIED", "unknown channel method"));
    if (payload.method.startsWith("mission.") && (!owner || payload.owner?.generation !== owner.generation || payload.owner?.root !== owner.root.path)) ownership.fail("OWNER_CHANGED");
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

module.exports = { createChannelApi, handle, MAX_BODY_BYTES };

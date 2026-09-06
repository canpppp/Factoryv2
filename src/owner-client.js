"use strict";

const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const ownership = require("./execution-owner");

function exchange(endpoint, method, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: endpoint, path: method === "GET" ? "/health" : "/rpc", method }, (response) => {
      const chunks = []; let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) request.destroy(Object.assign(new Error("OWNER_RESPONSE_LIMIT"), { code: "OWNER_RESPONSE_LIMIT" }));
        else chunks.push(chunk);
      });
      response.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(Object.assign(new Error("OWNER_RESPONSE_INVALID"), { code: "OWNER_RESPONSE_INVALID" })); } });
      response.on("error", reject);
    });
    request.setTimeout(2000, () => request.destroy(Object.assign(new Error("OWNER_UNAVAILABLE"), { code: "OWNER_UNAVAILABLE" })));
    request.on("error", (e) => reject(Object.assign(new Error(e.code || "OWNER_UNAVAILABLE"), { code: ["ENOENT", "ECONNREFUSED"].includes(e.code) ? "OWNER_UNAVAILABLE" : e.code })));
    request.end(body ? JSON.stringify(body) : undefined);
  });
}
async function call(root, method, params) {
  let expected;
  try { expected = ownership.read(root); } catch (e) { throw e; }
  if (!expected) ownership.fail("OWNER_UNAVAILABLE");
  const boundRoot = ownership.rootIdentity(root);
  const endpoint = path.join(boundRoot.path, "daemon", "channel-api.sock");
  if (expected.root?.path !== boundRoot.path || !ownership.same(expected.root, boundRoot) || expected.endpoint !== endpoint) ownership.fail("OWNER_WRONG_ROOT");
  if (!expected.ready) ownership.fail("OWNER_NOT_READY");
  const health = await exchange(endpoint, "GET");
  if (!health.ok) ownership.fail(health.error?.code || "OWNER_UNAVAILABLE");
  if (health.owner?.generation !== expected.generation || health.owner?.root?.path !== boundRoot.path || !ownership.same(health.owner?.root, boundRoot)) ownership.fail("OWNER_CHANGED");
  const response = await exchange(endpoint, "POST", { method, params, owner: { generation: expected.generation, root: boundRoot.path } });
  if (!response.ok) ownership.fail(response.error?.code || "OWNER_REQUEST_FAILED");
  return response.result;
}
function assertLocalTest(root) {
  if (ownership.read(root)) ownership.fail("LOCAL_TEST_OWNER_CONFLICT");
  for (const name of ["owner-acquire", "channel-api.sock"]) {
    try { fs.lstatSync(path.join(root, "daemon", name)); ownership.fail("LOCAL_TEST_OWNER_CONFLICT"); }
    catch (e) { if (e.code !== "ENOENT") throw e; }
  }
}
module.exports = { call, exchange, assertLocalTest };

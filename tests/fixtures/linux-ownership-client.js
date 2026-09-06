"use strict";

const http = require("node:http");
const fs = require("node:fs");
const [configPath, token, socketPath] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
setTimeout(() => process.exit(92), Math.max(1, config.expiry - Date.now()));
const payload = { id: token, method: "channel.send", params: { channelId: "proof", objective: JSON.stringify({ dir: config.dir, token, expiry: config.expiry, mode: config.mode }), timeoutMs: 8000, requestedTools: ["Read", "Write"], readWriteBoundary: "workspace-write" } };
const request = http.request({ socketPath, path: "/rpc", method: "POST" }, (response) => {
  let text = "";
  response.on("data", (chunk) => { text += chunk; });
  response.on("end", () => { process.send({ type: "queued", response: JSON.parse(text) }); });
});
request.on("error", (error) => { console.error(error); process.exit(1); });
request.end(JSON.stringify(payload));
process.on("message", (message) => { if (message === "finish") process.exit(0); });

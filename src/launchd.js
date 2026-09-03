"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const LABEL = "com.can.factoryv2";

function plist({ root, node = process.execPath, daemonPath = path.join(__dirname, "../bin/factoryd.js"), engine = "claude", pollMs = 5000, channelRoots = {} }) {
  const args = [node, daemonPath, "--root", path.resolve(root), "--engine", engine, "--poll-ms", String(pollMs)];
  const toolPath = [path.join(os.homedir(), ".local/bin"), "/Applications/ChatGPT.app/Contents/Resources", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  const rootEnv = Object.entries(channelRoots)
    .filter(([key, value]) => /^FACTORYV2_[A-Z0-9_]+_CWD$/.test(key) && typeof value === "string" && value.trim())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `<key>${xml(key)}</key><string>${xml(path.resolve(value))}</string>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(toolPath)}</string><key>FACTORYV2_HOME</key><string>${xml(path.resolve(root))}</string>${rootEnv}</dict>
<key>StandardOutPath</key><string>${xml(path.join(path.resolve(root), "daemon/factoryd.stdout.log"))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(path.resolve(root), "daemon/factoryd.stderr.log"))}</string>
<key>ProcessType</key><string>Background</string>
</dict></plist>\n`;
}

function install(options) {
  const file = path.join(os.homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
  const runtimeRoot = options.runtimeRoot || path.join(os.homedir(), "Library/Application Support/Factoryv2/runtime");
  const daemonPath = stageRuntime(runtimeRoot);
  fs.mkdirSync(path.join(path.resolve(options.root), "daemon"), { recursive: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, plist({ ...options, daemonPath }));
  spawnSync("launchctl", ["bootout", `gui/${process.getuid()}`, file], { encoding: "utf8" });
  const result = spawnSync("launchctl", ["bootstrap", `gui/${process.getuid()}`, file], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "launchctl bootstrap failed");
  return file;
}

function stageRuntime(runtimeRoot) {
  const sourceRoot = path.join(__dirname, "..");
  fs.mkdirSync(runtimeRoot, { recursive: true });
  for (const relative of ["bin", "src", "config", "skills", "package.json"]) {
    fs.cpSync(path.join(sourceRoot, relative), path.join(runtimeRoot, relative), { recursive: true, force: true });
  }
  return path.join(runtimeRoot, "bin/factoryd.js");
}

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

module.exports = { LABEL, plist, install, stageRuntime };

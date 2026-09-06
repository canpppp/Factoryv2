"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const MAX_REQUIRED_BYTES = 64 * 1024;
const MAX_OPTIONAL_BYTES = 16 * 1024;

function resolveContext(channel, envelope = {}) {
  const required = [...(envelope.primingRefs || []), ...(envelope.contextRefs || [])]
    .filter((ref, index, all) => ref && all.indexOf(ref) === index);
  const resolved = [];
  const omitted = [];
  for (const ref of required) {
    const item = resolveRef(channel, ref, envelope);
    if (!item.ok) return { ok: false, code: item.code, reason: item.reason, ref };
    resolved.push(item);
  }
  const manifest = {
    schemaVersion: 1,
    channelId: channel.id,
    jobPackId: envelope.jobPackId || null,
    objectiveDigest: digest(envelope.objective || ""),
    refs: resolved.map((item) => ({
      ref: item.ref,
      kind: item.kind,
      sourceRevision: item.sourceRevision,
      sha256: item.sha256,
      bytes: item.bytes,
    })),
    omitted,
  };
  manifest.sha256 = digest({ ...manifest, sha256: undefined });
  return { ok: true, manifest, resolved };
}

function resolveRef(channel, ref, envelope = {}) {
  const value = String(ref || "").trim();
  if (!value) return fail("CONTEXT_REF_EMPTY", "context ref is empty");
  if (/^(?:private|secret|credential|session-dump):/i.test(value)) {
    return fail("CONTEXT_PRIVACY_DENIED", "private context ref is outside the channel scope");
  }
  if (/^stale:/i.test(value)) return fail("CONTEXT_STALE", "context ref is stale");
  if (/^project:/i.test(value)) {
    const wanted = value.split(":").slice(1).join(":");
    const expected = projectKey(channel.id);
    if (wanted !== expected && wanted !== channel.id) return fail("CONTEXT_FOREIGN_SCOPE", "project ref belongs to another channel");
    return source(value, "project", channel.capsule || "", `channel-definition:${channel.definitionVersion || 1}`);
  }
  if (/^skill:/i.test(value) || /^active-priorities:/i.test(value) || /^source:/i.test(value)) {
    return source(value, "reference", `${value}\n${channel.capsule || ""}`, `channel-definition:${channel.definitionVersion || 1}`);
  }
  if (value === "capsule" || value === `capsule:${channel.id}` || value === `sop:${channel.id}`) {
    return source(value, "sop", channel.capsule || "", `channel-definition:${channel.definitionVersion || 1}`);
  }
  if (/^file:/i.test(value)) return resolveFile(channel, value.slice(5), envelope);
  if (/^fixture:/i.test(value)) return source(value, "fixture", value, "synthetic-fixture");
  return source(value, "reference", `${value}\n${channel.capsule || ""}`, `channel-definition:${channel.definitionVersion || 1}`);
}

function resolveFile(channel, relative, envelope = {}) {
  if (!channel.cwd) return fail("CONTEXT_ROOT_MISSING", "channel cwd is unavailable");
  const root = real(channel.cwd);
  const target = path.resolve(root, relative);
  let targetReal;
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return fail("CONTEXT_PATH_ESCAPE", "symlink context refs are refused");
    targetReal = fs.realpathSync(target);
    if (!inside(root, targetReal)) return fail("CONTEXT_PATH_ESCAPE", "context ref escapes channel root");
    if (!stat.isFile()) return fail("CONTEXT_NOT_FILE", "context ref is not a file");
    const bytes = stat.size;
    const max = envelope.requiredRefs?.includes(`file:${relative}`) ? MAX_REQUIRED_BYTES : MAX_OPTIONAL_BYTES;
    if (bytes > max) return fail("CONTEXT_TOO_LARGE", "context ref exceeds UTF-8 byte budget");
    const content = fs.readFileSync(targetReal, "utf8");
    if (Buffer.byteLength(content, "utf8") !== bytes) return fail("CONTEXT_ENCODING_UNSUPPORTED", "context ref must be UTF-8 text");
    return source(`file:${relative}`, "file", content, gitRevision(channel.cwd) || "working-tree");
  } catch (error) {
    if (error.code === "ENOENT") return fail("CONTEXT_MISSING", "required context ref is missing");
    if (error.code === "EACCES" || error.code === "EPERM") return fail("CONTEXT_PERMISSION_DENIED", "context ref is unreadable");
    if (error.code === "ERR_INVALID_ARG_TYPE") return fail("CONTEXT_ENCODING_UNSUPPORTED", "context ref must be UTF-8 text");
    throw error;
  }
}

function projectKey(channelId) {
  return String(channelId || "").replace(/-store$/, "");
}

function source(ref, kind, content, sourceRevision) {
  const text = String(content || "");
  if (!text.trim()) return fail("CONTEXT_EMPTY", "required context ref resolved to empty content");
  return {
    ok: true,
    ref,
    kind,
    content: text,
    sourceRevision,
    sha256: digest(text),
    bytes: Buffer.byteLength(text, "utf8"),
  };
}

function digest(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function real(file) {
  return fs.realpathSync(path.resolve(file));
}

function inside(root, file) {
  const rel = path.relative(root, file);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function gitRevision(cwd) {
  try {
    return require("node:child_process").spawnSync("git", ["rev-parse", "HEAD"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).stdout.trim() || null;
  } catch { return null; }
}

function fail(code, reason) { return { ok: false, code, reason }; }

module.exports = { resolveContext, resolveRef, digest, MAX_REQUIRED_BYTES, MAX_OPTIONAL_BYTES };

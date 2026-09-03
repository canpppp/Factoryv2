"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const journal = require("./journal");

function remember(root, { scope, text, source = "operator", tags = [] }) {
  if (!String(text || "").trim()) throw new Error("memory text is required");
  return journal.append(root, { type: "memory.curated", memoryId: `${Date.now()}-${Math.random().toString(16).slice(2)}`, scope, text: String(text).trim(), source, tags });
}

function rebuildIndex(root) {
  const p = journal.ensure(root);
  const db = path.join(p.memory, "sessions.sqlite3");
  sql(db, "CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(id UNINDEXED, scope UNINDEXED, content, source UNINDEXED); DELETE FROM session_fts;");
  const documents = [];
  for (const event of journal.load(root).events) {
    if (event.type === "memory.curated") documents.push({ id: event.memoryId, scope: event.scope || "global", content: event.text, source: event.source || "journal" });
  }
  for (const file of sessionFiles(p.sessions)) {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    documents.push({ id: data.job?.id || path.basename(file), scope: data.channelId || "session", content: `${data.job?.prompt || ""}\n${data.result?.response || data.result?.error || ""}`, source: file });
  }
  if (documents.length) {
    const statements = documents.map((doc) => `INSERT INTO session_fts(id,scope,content,source) VALUES('${escapeSql(doc.id)}','${escapeSql(doc.scope)}','${escapeSql(doc.content)}','${escapeSql(doc.source)}');`).join("");
    sql(db, statements);
  }
  return { db, documents: documents.length };
}

function search(root, query, { limit = 5, scope } = {}) {
  const { db } = rebuildIndex(root);
  const terms = String(query || "").toLowerCase().match(/[a-z0-9_/-]+/g) || [];
  if (!terms.length) return [];
  const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
  const whereScope = scope ? ` AND scope='${escapeSql(scope)}'` : "";
  const statement = `SELECT id,scope,snippet(session_fts,2,'[',']','...',18) AS excerpt,source FROM session_fts WHERE session_fts MATCH '${escapeSql(match)}'${whereScope} LIMIT ${Math.max(1, Math.min(20, Number(limit) || 5))};`;
  const result = spawnSync("/usr/bin/sqlite3", ["-json", db, statement], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "sqlite search failed");
  return result.stdout.trim() ? JSON.parse(result.stdout) : [];
}

function sessionFiles(root) {
  if (!fs.existsSync(root)) return [];
  const output = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...sessionFiles(target));
    else if (entry.isFile() && entry.name.endsWith(".json")) output.push(target);
  }
  return output;
}

function sql(db, statement) {
  const result = spawnSync("/usr/bin/sqlite3", [db, statement], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "sqlite index failed");
}

function escapeSql(value) {
  return String(value ?? "").replaceAll("'", "''");
}

module.exports = { remember, rebuildIndex, search, sessionFiles, escapeSql };

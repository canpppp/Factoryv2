---
name: source-retriever
version: 1
description: Retrieve focused authoritative source excerpts when a task depends on prior sessions, documents, logs, or research.
---
# Source Retriever
Inputs: query, scope, evidence type, result limit.
Outputs: ranked excerpts with source paths and IDs.
Search the rebuildable SQLite FTS index and open only the selected sources.
Never replay full chats by default, load whole archives, or treat summaries as stronger than primary evidence.
Behavior: irrelevant queries return no evidence rather than nearby noise.

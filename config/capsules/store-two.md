# Store Two Capsule

Purpose: Persistent read-only operator for the second storefront. Inspect project evidence, summarize operational state, find documented risks or opportunities, and prepare bounded recommendations. Keep Store Two evidence separate from Kaylas and every other channel.

Current status: The dedicated project directory is not configured. `FACTORYV2_STORE_TWO_CWD` must resolve to the exact Store Two root, which must contain `.factory-channel.json`. A broad parent directory is never an acceptable substitute.

Data sources: Only files under the validated root. Expected categories may include product exports, order summaries, campaign plans, status notes, scripts, and issue records. Inventory actual sources and their dates before drawing conclusions.

Safe commands: Repository/file status, focused searches, deterministic read-only scripts, and non-mutating tests. Publishing, remote service changes, messages, payments, campaign changes, or business-record writes remain outside authority.

Invariants: Preserve store separation. Cite source paths and timestamps. State incomplete evidence. Keep credentials, customer data, and provider tokens out of prompts/results. Never claim completion until Factory records a durable result.

Open loops: Configure and validate the project root. Establish authoritative snapshots. Perform an initial project/status inspection. Propose deterministic parsing only after observing the real workflow.

Recent decisions: Fail closed and read-only. Session IDs bind to engine and project identity; changing either clears the session. JARVIS dispatches and retrieves work only through the canonical Factory API.

Latest relevant result: None is embedded. `channel.result` and journal receipts remain authoritative.

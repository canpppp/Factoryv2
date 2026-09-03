# JARVIS Development Capsule

Purpose: Inspect JARVIS and report roadmap, architecture, test, and Factory integration status. Support bounded read-only engineering analysis. Never merge, deploy, replace the installed app, mutate production, or bypass protected authorities.

Current status: Canonical root is `${HOME}/Projects/jarvisproject`. Factory validates `AGENTS.md` and origin containing `canpppp/jarvis`; mismatch makes the channel unavailable and identity changes clear old sessions. JARVIS PR #27 stays frozen during this sprint.

Data sources: Code/tests, `AGENTS.md`, working agreement, status, roadmap, Roadline ledger, deterministic verification, candidate manifests, and Factory journal receipts. Inspect current git truth before conclusions.

Safe commands: Read-only git/file inspection, focused search, prescribed non-mutating tests, and status reports. Bridge implementation belongs on an isolated feature branch, not in this channel's authority.

Invariants: Preserve capability policy, turn authority, canonical executor, confirmation gate, Guest privacy, model-egress/DLP, Speech authority, durable state, credentials, external writes, and destructive-migration gates. The bridge exposes only list/send/status/result/cancel/resume. No provider CLI or arbitrary shell. Production release needs the human gate.

Open loops: Integrate the Unix-socket client through Trusted Kernel policy/executor. Add typed acceptance and provenance-preserving memory promotion. Verify the isolated bridge branch. Keep PR #27 unchanged.

Recent decisions: Journal truth is authoritative. Sessions bind to engine/project identity. Job IDs anchor follow-ups. Full JARVIS conversations are never forwarded; bounded envelopes carry compact references.

Latest relevant result: Use the exact channel result and repository state.

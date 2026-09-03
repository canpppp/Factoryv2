# Quality Check Capsule

Purpose: Independent evidence-based review of work from other channels or repositories. Prioritize correctness, regressions, privacy, authority violations, unsupported claims, and missing deterministic tests. Report findings in severity order and remain independent from builder sessions.

Current status: The dedicated review root is not configured. `FACTORYV2_QUALITY_CWD` must identify the exact directory and it must contain `.factory-channel.json`. Factory refuses dispatch while identity is missing.

Data sources: Bounded referenced files, diffs, manifests, deterministic gate outputs, journal events, and test receipts inside the root. Summaries and PR prose are secondary; deterministic output and the append-only journal win conflicts.

Safe commands: Read-only repository inspection, targeted tests, diff checks, schema/manifest validation, and focused log parsing. This channel cannot edit code, approve its own findings, merge, deploy, or mutate external systems.

Invariants: Reviewer identity must be distinct from builders when independence is required. Cite exact files or receipts. Missing evidence is residual risk. Redact sensitive values. Stay inside the task and authority boundary.

Open loops: Configure the root. Define compact evidence bundles. Add deterministic checks before model review. Track whether findings are repaired or blocked.

Recent decisions: Zero write authority. Repairs use a separate builder context. JARVIS can request status/results but reviewer prose cannot authorize production release.

Latest relevant result: Consult the exact job and journal event.

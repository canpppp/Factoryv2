# M0.1 / M1 Admission Slice Checkpoint

Date: 2026-09-06

Factory baseline: `21d3cf5c012f9cbf140b586adf817a92929e1560`

JARVIS baseline: `f8e7f99cbdd575e6a42af5e645cd4db156a60868`

## Implemented

- Admission envelopes now preserve request, channel, job-pack, revision, constraints, priming refs, context refs, evidence requirements, budgets, read/write boundary, effect boundary, and requested tools.
- Each admission records a canonical payload digest. Reusing the same job ID or idempotency key with a changed canonical payload is rejected.
- Context priming resolves required refs before worker execution, records source revisions, SHA-256 hashes, and UTF-8 byte counts, and passes resolved content to the worker prompt.
- Privacy, foreign-scope, stale, missing, path-escape, symlink, and oversized context refs fail typed before provider execution.
- Channel result retrieval can be exact by `channelId + jobId`; retrieval is journaled as its own authoritative observation.
- Provider completion is no longer treated as objective completion. Worker results must be structured, scoped to the right channel/job/engine, non-refusal, evidence-backed, and tied to the resolved context manifest.
- Unverified provider responses become terminal `channel.job.unverified` failures, not successful completions.
- Production audit promotion now uses claim-specific scoped validators. Unrelated events and fixture-origin observations do not promote live proof.

## Verification

- Factory full deterministic suite: PASS
  - Command: `npm test`
- JARVIS deterministic verifier: PASS when local IPC is permitted
  - Command: `./scripts/verify-cloud.sh > artifacts/verify-cloud-m0m1-factory-packet-escalated.log 2>&1`
  - Summary: `artifacts/verify-cloud-summary.json`

The first sandboxed JARVIS verifier attempt failed only on Unix socket `EPERM` for local IPC tests. The same verifier passed outside the sandbox without launching JARVIS, using microphone, or touching audio.

## Preserved Boundaries

- No JARVIS candidate was launched.
- No microphone, TTS, boot media, volume, media playback, deployment, merge, production daemon/config mutation, live business write, messaging, spending, or credential change was performed.
- JARVIS source remained unchanged at `f8e7f99cbdd575e6a42af5e645cd4db156a60868`.

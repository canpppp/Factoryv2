# Factory V2

Factory V2 is an append-only, restartable controller for bounded agent missions and persistent specialist channels. Normal CLI and daemon execution use real Claude Code or Codex subprocess adapters; `fakeAdapter` is retained only for deterministic tests.

Current release:

- `F0`: durable controller primitives: append-only journal, materialized state, one-writer lease, resumable thread IDs, restart/resume.
- `F1`: autonomous architect/builder/verifier/reviewer/repair loop with bounded repairs.
- `F2`: Goal Envelopes: one human approval for a goal, with protected authority classes still stopping the run.
- `F3`: canonical candidate system: exact UI/runtime pairing, dependency closure, candidate manifest, LaunchServices verification, exact-PID cleanup.
- `F4`: automated app acceptance and `READY_FOR_HUMAN_CHECK`.
- `F5`: human `Ship it` release train: exact main rebuild, deploy, smoke, rollback. JARVIS auto-deploy is intentionally absent during Factory development.

## Control Plane

```sh
factoryv2 init --root ~/.factoryv2
factoryv2 goal "Fix the bounded issue" --repo /path/to/repo --root ~/.factoryv2
factoryv2 run --engine claude --root ~/.factoryv2
factoryv2 channel list --root ~/.factoryv2
factoryv2 channel send kaylas-store "Investigate yesterday's refund spike" --root ~/.factoryv2
factoryv2 daemon install --engine claude --root ~/.factoryv2
```

`factoryd` is a headless launchd worker. Its only operator notification classes are `READY_FOR_HUMAN_CHECK`, `HUMAN_DECISION_REQUIRED`, `BLOCKED_EXTERNAL`, and `SHIPPED`.

## Local proof

```sh
npm test
```

The suite separates process-protocol proofs from live-provider acceptance. It uses real subprocess fixtures for adapter/session/restart behavior, temporary git repositories for deterministic controller gates, and fake agents only where a controlled rejection or interruption is the subject under test.

## Production-hardening proofs

The current suite also proves:

- one Goal Envelope can produce multiple dependent missions;
- worker loss, malformed worker output, and worker timeout trigger controller-owned replacement;
- reports derive from the journal and cannot be forced to summarize failed gates as passing;
- protected authority goals surface as `HUMAN_DECISION_REQUIRED`;
- compact operator commands exist for status, inspection, pause/resume, decisions, human acceptance/rejection, candidate lookup, and ship-it recording.
- `factoryv2 audit` reports dynamic A-I control-plane status from implementation and journal evidence. It does not label fixture-only behavior as live proof.

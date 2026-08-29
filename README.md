# Factory V2

Factory V2 is the controller that turns a high-level JARVIS goal into bounded internal missions, runs architect -> builder -> verifier -> independent reviewer -> repair loops, and stops only for real product/protected decisions or the final app check.

Current release:

- `F0`: durable controller primitives: append-only journal, materialized state, one-writer lease, resumable thread IDs, restart/resume.
- `F1`: autonomous architect/builder/verifier/reviewer/repair loop with bounded repairs.
- `F2`: Goal Envelopes: one human approval for a goal, with protected authority classes still stopping the run.
- `F3`: canonical candidate system: exact UI/runtime pairing, dependency closure, candidate manifest, LaunchServices verification, exact-PID cleanup.
- `F4`: automated app acceptance and `READY_FOR_HUMAN_CHECK`.
- `F5`: human `Ship it` release train: exact main rebuild, deploy, smoke, rollback. JARVIS auto-deploy is intentionally absent during Factory development.

## Local proof

```sh
npm test
```

The proof uses real temporary git repositories and deterministic fake agents. It demonstrates a controlled bug, verifier failure handling, independent reviewer rejection, same-worker repair, Factory restart/resume, and no merge to main.

## Production-hardening proofs

The current suite also proves:

- one Goal Envelope can produce multiple dependent missions;
- worker loss, malformed worker output, and worker timeout trigger controller-owned replacement;
- reports derive from the journal and cannot be forced to summarize failed gates as passing;
- protected authority goals surface as `HUMAN_DECISION_REQUIRED`;
- compact operator commands exist for status, inspection, pause/resume, decisions, human acceptance/rejection, candidate lookup, and ship-it recording.

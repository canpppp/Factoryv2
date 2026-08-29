# FactoryV2 Production Backlog

Generated from the self-hosting production acceptance contract.

## P0

- Multi-mission Goal Envelope decomposition with dependency ordering.
- Persistent restart/resume through every controller phase. Initial architecture, verification, review, and repair phase-boundary restart proof is implemented.
- Worker recovery for interruption, lost thread, malformed response, and timeout.
- Journal-derived reports that cannot contradict deterministic gates.
- Protected boundary classifier returns `HUMAN_DECISION_REQUIRED`.

## P1

- Stronger candidate isolation: source SHA, UI runtime hash, agent runtime hash, dependency preflight, handshake identity, listener ownership, exact PID cleanup. Initial dependency and pairing preflight is implemented and proved.
- Synthetic JARVIS acceptance harness covering startup, turns, structured views, clock/capability truth, empty responses, Guest Mode, interruptions, speech normalization, crash health, and runtime identity.
- Human rejection loop: capture feedback, create bounded repair mission, rebuild candidate, return a new human-check card. Initial feedback-to-repair proof is implemented.

## P2

- Ship-it release train with final main rebuild, candidate/main equivalence, rollback preservation, deploy smoke, and deterministic rollback on failure.
- Compact operator CLI for `goal`, `status`, `inspect`, `pause`, `resume`, `decisions`, `candidate open`, `accept`, `reject`, and `ship`.

## Current Bootstrap Proofs

- F0/F1 fake repo proof.
- JARVIS docs/test-only proof.
- F2 envelope proof.
- F3/F4/F5 candidate/release simulation proof.
- Long autonomous endurance proof with multi-mission ordering, interruption/restart, reviewer rejection, repair, candidate construction, acceptance, and human-check receipts.

## Next Production Mission

Move the highest-value missing behavior into the controller: multi-mission decomposition, dependency scheduling, worker replacement, and journal-derived report integrity.

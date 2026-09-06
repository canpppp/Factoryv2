# M0.1 / M1 Review Repair Receipt

Date: 2026-09-06

Initial packet commit: `f8c3720491f2fb0ec9025492d6d26b90c5ac60d5`

Factory repair commit: `83c3b18ff996db3a4c4e7d4b9a810658089115ed`

JARVIS bridge repair commit: `ccc409be936ddcb99e3295a18a01e864223bd38f`

Second-round Factory repair commit: `7e2b01e19fd18a8b64a1e4c59fd9e99779d8cd4b`

Second-round JARVIS bridge repair commit: `672be1daaee156a14752a9322f4a413d0150328b`

Final R1/R3 Factory repair commit: `25e5f1757e402848203bd67d4c88fed98788c14e`

Contract-tightening Factory repair commit: `c90e3ce159685e14b5605c1a43386b2c4c87a158`

## Architect Findings Closed

- R1: audit promotion now rejects fixture-origin evidence for live proof, requires trusted linked queue/finish/retrieval/context/token/quota observations, and the quota continuation branch no longer references an undefined variable.
- R2: context priming now resolves the union of `primingRefs`, `contextRefs`, and `requiredRefs`; missing skill refs, unknown refs, stale refs, foreign project refs, and unavailable project-memory refs fail typed instead of substituting the channel capsule.
- R3: worker result verification now requires explicit channel/job identity and refuses unsupported file evidence or summaries that report unavailable/incomplete work.
- R4: JARVIS `channel_result` now sends the exact job ID when supplied or when using the active session job, and rejects mismatched Factory results without replacing session job identity.
- Second-round R1: omitted or unknown provenance no longer promotes live proof; current controller events carry explicit producer provenance.
- Second-round R2: the actual Kaylas pack vocabulary resolves from scoped source bindings for `project:*`, `store:*`, `active-priorities:*`, `project-memory:*`, `daily-log:*`, and `skill:*`, and remains typed-blocked when a source binding is absent.
- Second-round R3: bounded `fieldEquals` acceptance predicates are independently checked against resolved file evidence; affirmative worker prose and manifest echo are insufficient.
- Second-round R4: missing or empty returned result job identity is `UNKNOWN`, never `SUCCESS`; JARVIS preserves per-channel job identity for exact old-channel follow-ups.
- Final R1: controller producer provenance is separated from proof origin. Direct deterministic registry jobs no longer live-prove JARVIS bridge dispatch/retrieval or worker-context consumption.
- Final R3: `acceptanceProfile` is forwarded through the production JARVIS tool wrapper; required empty/unsupported file-evidence acceptance remains unverified.
- Contract-tightening R1: worker-input proof is now recorded only after a provider receipt exists; failed provider invocations cannot live-prove compact goal/context use.
- Contract-tightening R1: daemon survival proof now requires the same scenario, same job, trusted producer origin, and a verified finish after the controller stopped.
- Contract-tightening R1: Claude resume proof now requires a reused Claude token event with a matching Claude receipt and identical session ID.
- Contract-tightening R3: custom done conditions with any required evidence now fail closed when no deterministic acceptance predicate is available, including non-file references such as `source:ledger`.

## Contract-To-Test Table

| Contract | Regression Guard |
| --- | --- |
| Failed provider adapter cannot produce worker-input proof. | `tests/channel-security-proof.test.js` `failedProviderDoesNotLiveProveWorkerInput` |
| B requires same job and finish after controller loss. | `tests/audit-proof.test.js` `wrongRestart` / `restart` cases |
| C requires Claude engine and exact resumed session. | `tests/audit-proof.test.js` `wrongResume` / `resume` cases |
| F requires worker input with provider evidence, session, engine, and matching context manifest. | `tests/audit-proof.test.js` scoped proof and failed-provider proof |
| Unsupported custom acceptance fails closed for non-file evidence. | `tests/channel-security-proof.test.js` `source:ledger` `ACCEPTANCE_UNSUPPORTED` case |
| RPC acceptance profiles survive the JARVIS tool boundary. | `tests/channel-security-proof.test.js` `rpcAcceptanceProfileIsEnforced` |

## Verification

- Factory affected proofs:
  - `node tests/audit-proof.test.js`: PASS
  - `node tests/channel-security-proof.test.js`: PASS
  - `node tests/channels-daemon-proof.test.js`: PASS
- Factory full suite:
  - `npm test`: PASS
- JARVIS affected proofs:
  - `node agent/tests/factory-channel-bridge-test.js`: PASS
  - `node agent/tests/overnight-endurance-test.js`: PASS
- JARVIS full verifier:
  - `./scripts/verify-cloud.sh > artifacts/verify-cloud-m0m1-r4-bridge-repair.log 2>&1`: PASS
  - `./scripts/verify-cloud.sh > artifacts/verify-cloud-m0m1-r1-r4-final.log 2>&1`: PASS
  - `./scripts/verify-cloud.sh > artifacts/verify-cloud-m0m1-r1-r3-final.log 2>&1`: PASS
- Difficult-review route:
  - completed before the second-round closure pass and returned explicit R1-R4 invariants.

## Boundaries

No JARVIS candidate was launched or rebuilt. No microphone, TTS, boot media, system audio, deployment, merge, production daemon mutation, live business write, messaging, spending, or credential change was performed. The contract-tightening pass was fully movie-safe.

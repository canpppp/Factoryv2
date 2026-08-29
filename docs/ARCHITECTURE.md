# Factory V2 Architecture

The append-only event journal is authoritative. Snapshots, summaries, PR bodies, receipts, and progress reports are derived from journal events and may not contradict gate results.

## Human Role

The human provides high-level goals, answers protected/product decisions that the Factory cannot infer, performs the final app check, and explicitly says `Ship it` for release. Routine scope hash metadata, worker restarts, repair rounds, test selection, reviewer feedback routing, and candidate rebuilds are controller work.

## Protected Boundaries

Factory V2 must preserve these boundaries:

- capability policy
- turn authority
- canonical executor / `tools.run`
- confirmation gate
- Guest privacy
- model-egress / DLP
- Speech authority
- durable-state authority
- credential handling
- external write permissions
- destructive migrations

Internal administrative events, including approval metadata updates, must not require human relay when the bound contract hash is unchanged.

## Release Gates

`F0` and `F1` are executable now. `F2` through `F5` are named policy lanes and must become executable only after the fake repo proof and then a JARVIS docs/test-only proof pass.

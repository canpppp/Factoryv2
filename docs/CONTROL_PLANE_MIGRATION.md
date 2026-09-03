# Control Plane Migration

## Containment

JARVIS PR #27 remains a frozen experimental integration line. Existing commits, candidate artifacts, and evidence are preserved. No further Spatial Workbench, Meeting Mode, memory polish, voice polish, or unrelated candidate work belongs on that branch.

## Successor

The Factoryv2 control-plane implementation lives on `factoryv2/real-control-plane`. It contains real Claude Code and Codex adapters, `factoryd`, durable channels, JARVIS channel tools, selective skills, token routing, and rebuildable session search.

## Migration

1. Keep PR #27 open as historical experimental evidence; do not merge or extend it during control-plane work.
2. Land Factoryv2 control-plane commits independently after deterministic and live adapter proofs.
3. Integrate only the small `channel.*` JARVIS tool surface in a later bounded JARVIS mission.
4. Squash that JARVIS integration to the tool contract, transport, and focused tests. Do not carry candidate or product-feature commits from PR #27.
5. Require the normal JARVIS human release gate before any production merge, deployment, or installed-app replacement.

The append-only Factory journal remains operational truth. SQLite FTS is a rebuildable search index, not a second state store.

---
name: test-selector
version: 1
description: Select deterministic verification and acceptance commands after scope is known or a prior gate failed.
---
# Test Selector
Inputs: changed paths, risk classes, prior failures, repository test inventory.
Outputs: focused tests, broader regression tests, acceptance gate and timeout budget.
Prefer deterministic verification over model agreement and broaden with blast radius.
Never skip a known failing gate, use destructive production data, or claim an unrun test passed.
Behavior: each selected command has a reason and its real exit result enters the journal.

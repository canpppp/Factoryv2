---
name: token-governor
description: Select a model tier, minimize loaded context, and record usage when starting or resuming agent work.
---
# Token Governor
Inputs: task kind, failed repairs, engine, capsule size, provider availability.
Outputs: model/effort, selected skills/excerpts, token estimate, cache reuse and escalation reason.
Use Luna for inventory/logs/compression, Terra High for ordinary work, Sol High for architecture/difficult repair, and Sol Max only after two failed bounded repairs. Fall back to Terra High if Sol is unavailable.
Never escalate for prestige, load every skill, hide cost metadata, or discard task state on quota.
Behavior: every LLM receipt records model, context estimate, output size, cache/reuse, and escalation reason.

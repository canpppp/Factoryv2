---
name: task-compiler
description: Compile a high-level operator goal into bounded missions when scope, dependencies, tests, and protected authority must be made explicit.
---
# Task Compiler
Inputs: goal, repo capsule, Goal Envelope.
Outputs: ordered missions, owned paths, deterministic gates, risk and authority classes.
Prefer the smallest dependency graph that reaches an app-checkable result.
Never encode credentials, approve protected actions, expand the envelope, or substitute prose for executable gates.
Behavior: routine goals produce compact missions; protected classes stop once with a precise decision request.

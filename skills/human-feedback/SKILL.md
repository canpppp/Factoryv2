---
name: human-feedback
version: 1
description: Convert a failed human app check into a bounded repair mission with exact artifact, reproduction, expected behavior, and preserved restrictions.
---
# Human Feedback
Inputs: artifact identity, observed behavior, launch path, expected behavior, restrictions.
Outputs: authoritative failure event, reproduction, acceptance correction, repair findings.
Human evidence outranks prior automated readiness for the same artifact.
Never reinterpret product feedback as permission to merge, deploy, or replace production.
Behavior: a repaired candidate must rerun the gate that previously returned a false green.

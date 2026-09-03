---
name: repo-capsule
description: Create or refresh compact repository context before implementation, especially when a persistent channel must avoid replaying prior chats.
---
# Repo Capsule
Inputs: cwd, goal, changed paths.
Outputs: branch/status, architecture entrypoints, commands, constraints, recent relevant commits.
Use deterministic inventory first and cite paths.
Never paste full repositories, secrets, generated dependencies, or unrelated history.
Behavior: the capsule remains small enough for one prompt and invalidates facts that changed on disk.

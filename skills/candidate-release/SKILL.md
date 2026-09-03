---
name: candidate-release
description: Build, identify, verify, clean up, and release exact candidate artifacts when a mission reaches integration or the human says Ship it.
---
# Candidate Release
Inputs: approved commit, runtime closure, candidate policy, human release event.
Outputs: exact manifest, launch identity, acceptance results, cleanup and release receipt.
The artifact handed to the human must be the artifact tested.
Never merge or deploy JARVIS without the configured human release gate, substitute another bundle, or clean by process name.
Behavior: failed identity, acceptance, or exact-PID cleanup blocks readiness.

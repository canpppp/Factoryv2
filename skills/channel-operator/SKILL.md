---
name: channel-operator
description: Dispatch, inspect, pause, cancel, or resume a durable specialist channel when a request names an agent, project lane, or channel operation.
---
# Channel Operator
Inputs: channel intent, concise job, authority constraints.
Outputs: channel ID, durable job ID, status or concise result.
Use `channel.list`, `channel.send`, `channel.status`, `channel.result`, `channel.cancel`, and `channel.resume`.
Never invent completion, expose full session history, bypass a paused channel, or grant new tools.
Behavior: a dispatch returns a job ID before work; a later result comes from the journal; a pause never deletes queued work.

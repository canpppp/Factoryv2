# Channel API

The Factory daemon exposes a local HTTP/JSON RPC endpoint over its Unix socket:

`<FACTORYV2_HOME>/daemon/channel-api.sock`

The socket is created with mode `0600`. Factory refuses to replace a non-socket filesystem entry at that path. Requests use `POST /rpc`, are limited to 64 KiB, and have this shape:

```json
{"id":"caller-id","method":"channel.status","params":{"channelId":"kaylas-store"}}
```

The only accepted methods are:

- `channel.list`
- `channel.send`
- `channel.status`
- `channel.result`
- `channel.cancel`
- `channel.resume`

`channel.send` accepts a bounded task envelope: channel ID, objective, context references, required evidence, read/write boundary, done condition, token budget, timeout, priority, requested tools, kind, and caller-supplied idempotency job ID. Factory validates project identity, channel authority, and tool policy before queueing. Repeating a job ID returns the original queued envelope and never queues a second execution.

The API does not expose provider CLIs, arbitrary shell, raw session transcripts, model selection, credentials, or journal mutation. JARVIS must reach it through capability policy and the canonical tool executor.

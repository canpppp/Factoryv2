# Overnight Control-Plane Baseline

Captured before the 2026-09-04 control-plane integration edits. The append-only live journal remains authoritative for execution state.

## Factoryv2

- Working branch: `factoryv2/real-control-plane`
- Starting commit: `d1d6b33aad66887949f45ddc4064f14434caf7db`
- `origin/main`: `d5b876462799528070d4c2c0e4f885901c76bce6`
- PR #2 head: `d1d6b33aad66887949f45ddc4064f14434caf7db` (draft/open at capture)
- Launchd service: `com.can.factoryv2`
- Starting daemon PID: `61640`
- Runs: `2`; last exit: `0`
- State root: `/Users/can/Library/Application Support/Factoryv2/state`
- Queues at capture: all six empty
- Provider backoffs at capture: none

## Channels

| Channel | Engine | Session | Latest job |
| --- | --- | --- | --- |
| `kaylas-store` | Claude | `68da4b31-3e1d-4631-b6ce-70092a4957a7` | `7813423a-e499-4eb6-b6a0-79413126f0f2` |
| `store-two` | Claude | none | `115943cc-086f-4c68-b3fb-f26f9be8b8e5` |
| `quality-check` | Codex | none | `b6305b0a-cb97-473d-abd1-88c9cac1e943` |
| `facebook-product-launches` | Claude | none | `c858d37e-7abd-4a99-9d7f-ce41f8bb0ca1` |
| `invoice-audit` | Codex | none | `7dbb79e0-fec0-4ae3-8e52-d697ae094b6f` |
| `jarvis-development` | Codex | none | none |

The legacy registry pointed five channels at a generic projects directory. No dedicated business roots were found. The hardened registry therefore requires explicit environment-configured roots plus identity markers and reports those channels unavailable until configured. Existing receipts remain preserved.

## Token Truth

Two real Claude receipts existed at capture:

- Initial Kaylas job: Haiku, 18 provider input tokens, 453 output tokens, 36,821 cache-read tokens, USD 0.0359141.
- Resumed Kaylas job: Haiku, 10 provider input tokens, 329 output tokens, 28,585 cache-read tokens, USD 0.0067615, `reusedSession: true`.

Routing classes are Luna/Haiku for mechanical inventory, Terra/Sonnet for normal implementation or audit, Sol/Opus for architecture or difficult repair, and Sol Max/Opus Max only after two bounded repair failures. Provider-specific names are capability mappings.

## JARVIS Boundary

- PR #27 head: `4297e07bd03808edf201f1ae96c23dced17006ae` (draft/open at capture)
- PR #27 remains frozen.
- Installed bundle: `/Users/can/Applications/JARVIS.app`
- Bundle identity: `com.can.jarvis`, version `0.1.0`
- Executable: `jarvis-ui`
- Codesign CDHash: `a04a923003d0c3f30d42b7761eb6d6f23b91a067`
- No JARVIS merge, deploy, installed-app replacement, or business-system write is authorized by this sprint.

## Audio Boundary

No playback or microphone acceptance was initiated. A read-only check at 2026-09-04 00:28 Asia/Makassar found system output unexpectedly unmuted at volume 69. Factory work had issued no audio command. Mute was restored immediately without changing volume and verified as `outputMuted: true`. Exact prior external cause is not available from Factory's journal.

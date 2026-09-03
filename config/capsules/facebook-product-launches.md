# Facebook Product Launches Capsule

Purpose: Prepare and inspect product-launch plans using existing evidence. Organize checklists, identify missing assets or metadata, and report readiness. Never publish campaigns, spend money, change audiences, upload creatives, or write to Meta services without a separately protected action.

Current status: No dedicated directory is configured. `FACTORYV2_FACEBOOK_CWD` must point to the exact planning root containing `.factory-channel.json`. The channel does not fall back to a general projects folder.

Data sources: Approved product data, creative inventories, briefs, calendars, compliance notes, and feed-validation outputs in the validated root. Sources need a date/version. Live platform state is unknown without a fresh authorized receipt.

Safe commands: Listing, focused search, checklist generation, comparison of existing exports, and read-only validation. The tool profile excludes shell and external mutation.

Invariants: No launch, budget, audience, targeting, messaging, or credential actions. Distinguish planned, ready, blocked, and live. Record missing inputs. Do not claim performance without metrics.

Open loops: Configure the project. Identify the canonical feed. Implement deterministic checklist generation once formats are known. Establish review criteria before any future publish action.

Recent decisions: Planning/read-only only. Deterministic checklist work may continue during provider outages. JARVIS cannot invoke provider CLIs, shell, or Meta through this channel.

Latest relevant result: Consult `channel.result` and the journal.

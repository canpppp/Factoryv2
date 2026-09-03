# Deterministic Work Extraction

This inventory is intentionally conservative because five business project roots are not yet configured. Token savings are directional estimates to be replaced with measured receipts after real formats are available.

| Workflow | Current model process | Deterministic replacement | Estimated savings | Cost | Risk / status |
| --- | --- | --- | --- | --- | --- |
| Invoice record comparison | Model groups invoices and spots inconsistent amounts | Normalize structured records, group by invoice ID/currency, emit exact mismatches | 80-95% per comparison | Low | Basic `invoice-compare` implemented; currency/schema validation remains |
| Campaign readiness | Model rereads a launch brief and lists missing items | Validate a versioned required-field checklist against structured product/asset data | 60-90% | Low | Basic `campaign-checklist` implemented; no external launch action |
| Shopify status snapshot | Model summarizes repeatedly supplied structured state | Store timestamped deterministic snapshots and diff only changed keys | 50-85% | Low | In-memory `shopify-snapshot` receipt implemented; live collection awaits authorized source |
| File routing | Model decides where files belong | Rules table plus dry-run manifest, hash, collision check, then separately authorized apply | 70-95% | Medium | Planned-only `file-route` implemented; no file moves |
| Scheduled status | Model composes routine unchanged updates | Deterministic state query and notify only on meaningful transition | 80-99% | Low | `scheduled-notification` implemented; audible notifications prohibited overnight |
| Product/feed validation | Model scans exports for missing fields and duplicates | Schema, uniqueness, URL, image, price, and inventory validators | 60-95% | Medium | Deferred until canonical feed format is configured |
| Invoice parsing | Model extracts each invoice ad hoc | Format-specific parser/OCR pipeline with confidence and reconciliation fixtures | 40-90% | Medium | Deferred until representative approved files exist |

Principle: deterministic receipts continue during provider backoff. They remain append-only job results, use idempotent job IDs, and cannot acquire external-write authority. No large n8n migration is justified until actual repeated workflows and input contracts are observed.

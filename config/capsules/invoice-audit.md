# Invoice Audit Capsule

Purpose: Inspect invoice evidence, compare records, identify duplicates or mismatches, and produce concise audits. Never approve, pay, modify, email, upload, or delete invoices or alter accounting systems.

Current status: The dedicated invoice root is not configured. `FACTORYV2_INVOICE_CWD` must point to the exact directory containing `.factory-channel.json`. Factory refuses work until identity passes.

Data sources: Approved invoice exports, normalized tables, reconciliation rules, prior receipts, and deterministic parser outputs in the validated project. Prefer structured data and parsers over free-form model extraction. Minimize personal/payment data in model context.

Safe commands: Read-only inventory, focused search, schema inspection, and deterministic comparison. `invoice-compare` groups structured values by invoice ID and reports mismatched amounts without a provider.

Invariants: Never initiate payment or alter records. Cite file, row/key, currency, amount, and date where available. Do not equate currencies. Mark OCR/parsing uncertainty. Redact secrets and unnecessary personal data.

Open loops: Configure the isolated root and retention policy. Identify formats/currencies. Build deterministic normalization for stable formats. Define mismatch escalation without granting payment authority.

Recent decisions: Fail closed and read-only. Mechanical comparisons continue during provider outages. Useful results may enter memory only with channel/session/job/source/timestamp provenance.

Latest relevant result: Query `channel.result`.

# Channel Root Activation

Factory channels fail closed unless a project root has positive identity evidence. A root is not accepted because its name looks plausible or because a prior provider session visited a broad parent directory.

| Channel | Bound root | Positive evidence | State |
| --- | --- | --- | --- |
| Kaylas Store | `/Users/can/Downloads/Ecom/Obsidian Folder/Shopify-Master-Brain/03 Projects/Kaylas Collectives` | `CLAUDE.md` says it is the dedicated Kayla's Collectives workspace | Configured, read-only |
| Quality Check | `/Users/can/Downloads/Ecom/Supplier-QC` | `CLAUDE.md` identifies the Supplier QC mis-advertising watchdog | Configured, read-only |
| JARVIS Development | `${HOME}/Projects/jarvisproject` | `AGENTS.md` plus `canpppp/jarvis` git remote | Configured, read-only |
| Store Two | None | Several store-specific roots exist, but no evidence identifies which one means Store Two | `PROJECT_ROOT_DECISION_REQUIRED` |
| Invoice Audit | None | Historical `/Users/can/Downloads/invoice-audit` root no longer exists; invoice documents are not project identity | `PROJECT_ROOT_DECISION_REQUIRED` |
| Facebook Product Launches | None | Media exists, but no dedicated project marker establishes a canonical root | `PROJECT_ROOT_DECISION_REQUIRED` |

The launchd plist persists only configured `FACTORYV2_*_CWD` values referenced by channel definitions. Root identity is part of the channel identity key, so changing the root or marker binding clears the old provider session before more work is dispatched.

Historical sessions whose working directory was a shared parent remain evidence only. They are not resumed into a newly bound dedicated root.

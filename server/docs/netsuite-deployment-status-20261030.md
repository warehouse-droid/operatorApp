# NetSuite deployment status — 30 October 2026

Checked at 2026-10-30T05:05:16.670Z. Read-only health requests and the complete script/deployment inventory were used: 406 script records and 507 deployment records. No NetSuite script or transaction was changed.

## Updates and missing installations

| Local script/package | Observed status | Manual action |
| --- | --- | --- |
| `netsuite-smart-scm-picking-ticket-restlet.js` | **Known version difference:** active RESTlet is **3.3.0**. Local version is **3.4.0**; live capabilities do not include `estimatePdf`. | Update the existing Picking Ticket RESTlet file and retain its deployment. See [PDF upload instructions](netsuite-quotation-pdf-upload.md). |
| `netsuite-transaction-pdf-suitelet.js` | No matching file or Script record found. | Upload and create the browser PDF Suitelet deployment using the [PDF instructions](netsuite-quotation-pdf-upload.md). |
| `netsuite-field-sales-restlet.js` | No matching file or Script record found; the application's Field Sales RESTlet URL is also unconfigured. | Install/configure when enabling the Field Sales integration. |
| `netsuite-ifir-reconciliation-webhook-user-event.js` | No matching file or Script record found. | Upload and deploy the reconciliation User Event when enabling this webhook. |
| Pallet Payment v3 automatic refresh | `ppa_watch_ue.js` and `ppa_dispatch_ss.js` have no matching file or Script record; `ppa_refresh_queue.js` is missing. | Follow [UPGRADE-v3.txt](../netsuite/pallet-payment/UPGRADE-v3.txt), including its queue setup, updated libraries, watcher, and dispatcher. |

The inventory identifies matching filenames (including the installed dated suffixes) and script/deployment records. It does not compare remote file contents byte for byte: the file-content read returned HTTP 400, “That operation is not supported for this record type: file.” A script uploaded under an unrelated filename cannot be identified conclusively by this check.

## Confirmed deployed

| Integration | Installed script / activation |
| --- | --- |
| Direct order webhook | `netsuite-order-webhook-user-event-direct_0916.js`, script 485, Released and Deployed on SO, PO, and TO. |
| Customer webhook | `netsuite-customer-webhook-user-event.js`, script 495, Released and Deployed. |
| Pallet-balance lookup | `netsuite-pallet-balance-search-restlet.js`, script 505, Released and Deployed; read returned version 1 and saved search `customsearch503`. |
| IF/IR posting | `netsuite-ifir-posting-restlet.js`, script 507, Released and Deployed; health returned contract 1, writes enabled, production allowed, and PO→IR / SO→IF / TO→IF / TO→IR support. |
| Pallet allocation rebuild | `ppa_rebuild_mr.js`, script 508 / `customscript_ppa_rebuild`, Deployed with status `NOTSCHEDULED`, as intended for on-demand submission. This alone does not install automatic refresh. |

Existing pallet libraries `ppa_config.js`, `ppa_core.js`, `ppa_netsuite.js`, and `ppa_service.js` are present. Their exact source revisions were not compared.

## Alternative order-webhook implementation

The queued `netsuite-order-webhook-user-event.js` file is uploaded but has no matching Script record. `netsuite-order-webhook-scheduled.js` was not found. These are alternatives to the currently active direct webhook; their absence does not mean the active SO/PO/TO webhook is disabled.

Machine-readable evidence: [activation inventory](../test/whole-worktree-deployment-20261030-netsuite.json). Reproduce with `sudo python3 server/tools/worktree-netsuite-activation-20261030.py` from the repository root.

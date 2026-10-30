# PO/TO transit reconciliation — 2026-10-21

Scope: resolve current and saved in-transit PO/TO statuses from live NetSuite evidence. The old native posting flow remains active.

Acceptance criteria:
- Read current source quantities, destination progress and linked IF/IRs before changing local statuses.
- Use the deployed reconciliation service and its durable proposal/apply audit.
- Review conflicts before applying; never infer destination receipt from pickup alone.
- Preserve special-order/split quantities and physical Driver/Operator history.
- Create no NetSuite transactions and leave the RESTlet routing gate off.
- Confirm the displayed schedule and saved reconciliation state after applying.

This is operational reconciliation, with no runtime application code or dependencies changed. Production reads and the existing reconciliation service provide the execution evidence; no synthetic test data or disposable test containers are required. Spec approval: not obtained (autonomous run under the user's requested reconciliation).

Operational evidence is retained in `server/artifacts/netsuite-transit-resolution-20261021/` (private directory). `inventory.mjs` and `read.mjs` use SELECTs/NetSuite reads; `run.py propose` and `run.py apply` invoke the deployed proposal/apply service. Results will be recorded below after verification.

## Results

Verified at **2026-10-21T06:15:23.166Z**:
- Displayed PO/TO In Transit rows: **2 → 0**.
- All **43 source families** now have reconciliation status Completed: **42 TOs and POB04016**.
- **TOB01227** is locally received, linked to existing **IR15159 (1070038)**: 398.15 SQFT item 3631 and 5 EACH pallets at destination 28.
- **LOINC-039408**, the active POB04016 split, is locally received and Completed, linked to existing **IR15167 (1071884)**: 947.73 SQFT item 2055 and 7 EACH pallets at destination 28. Parent residual LOINC-039761 is also Completed from its already-existing receipt evidence.
- Existing **11 Operator load records, 4 receiving records and 43 Driver records** exactly match the saved baseline. Split line identities, quantities, units and packing quantities are unchanged.
- Native posting attention, Delivery SO fulfillment and transfer posting queues remain **0 / 0 / 0**.
- RESTlet routing gate remains **false**; the old native posting flow remains active.
- **No new NetSuite IR/IF transactions**; this operation used NetSuite reads and local reconciliation only.

The initial TO proposal **5709** and apply **5711** each completed all 42 targets with zero failures/reviews. The PO proposal **5710** exposed a real local allocation gap: the split's saved Queued status prevented inferred receipt allocation, and no exact receipt quantity had been linked locally. Its historical review proposal is retained as evidence; it was not force-accepted. `finish.py` linked the exact existing IR to its split source lines, updated the local completion status, and ran the normal reconciliation repository within one audited transaction. Both source keys and the complete receipt line set, items, quantities, units and destination were checked, including the special-order line and pallets.

The first rollback rehearsal rejected an unsupported audit-source string (`scm_reconciliation_order_state_source`); the transaction rolled back. After using the supported `manual` source and adding fresh parent snapshots, **`finish.py rehearse -v2` passed and rolled back**, followed by **`finish.py apply` passing and committing**. No runtime application code was changed.

Final evidence: `verify-final.json`, `queues-final.json`, `apply.jsonl`, `finish-rehearse-v2.jsonl` and `finish-apply.jsonl`. The read-only verifier is `check.py verify` (supply a new suffix to retain prior audits). Dated mutation scripts intentionally refuse to overwrite existing evidence and should not be rerun against new work.

No test containers were created. Final `docker ps` and `docker ps -a` showed only the four production containers; app, database and Ollama health checks passed, and the webhook worker remained running. No disposable test volumes or networks were created or retained; production and rollback storage were preserved.

# NetSuite attention and Delivery SO queue reconciliation — 2026-10-21

User authorization: resolve NetSuite verification attention and Delivery SO
fulfillment queues; update local status where NetSuite is already complete.
The user subsequently requested the original posting flow and explicitly skipped
the two conflicting deliveries, followed by the eight remaining incomplete ones.

Initial inventory: **9 native verification-attention commands, 23 transfer jobs,
111 Delivery SO candidates**. Final result: **133 reconciled/completed using
existing NetSuite records, 10 explicitly skipped, zero remaining queue entries**.
**Zero NetSuite POSTs or new IF/IR transactions** were made by this reconciliation.

| Queue | Verified existing completion | Explicitly skipped |
|---|---:|---:|
| Native verification attention | 9 | 0 |
| Transfer posting | 23 (14 IF, 9 IR) | 0 |
| Delivery SO | 101 (93 reconciled, 8 completed) | 10 |

NetSuite SuiteQL provided source headers, stable line IDs, item/type, units and
conversion factors, locations, fulfilled/received quantities and linked IF/IR
records. Fifteen uncertain IFs were also read directly. Fresh remote reads
immediately preceded rollback rehearsals and the final application.

The historical extra-line review did not weaken the production verifier:

- Special-order extras were checked against their exact source quantities,
  units, location and saved local physical progress.
- Sales Credit extras were identified as item 4646, `NonInvtPart`, with exact
  source identity/quantity; they were not treated as inventory movements.
- SOB122309's two extra inventory lines matched immutable earlier Operator
  load record 3486, including stable source keys, items, units and quantities.
- Original payloads and snapshots were retained. The reviewed verification
  input and adjustments were recorded separately in the maintenance audit.
- Transfer proofs matched NetSuite's separate outbound and receipt source
  lines. Two orders are still pending receipt: their IF jobs completed, without
  asserting that receiving had completed.
- Four service/charge-only SOs require no IF; their source lines explicitly
  have `isfulfillable = F`. Their authoritative completed headers were synced.
- SOA08854-S1 and SOA06143-S1 each exactly matched one existing IF. Only those
  child deliveries were completed; their partial parent status was retained.

The first rollback rehearsal passed 127 cases and exposed four service-only
orders with no IF, correctly requiring an explicit nonfulfillable-line guard.
The second passed 131 cases and exposed use of an incorrect split-table key.
The split-table key was corrected to `split_ref`; a targeted fresh rehearsal
then passed both remaining cases. The final apply completed **133/133**, with
no errors. Each change used a local transaction, locked relevant rows, checked
immutable identities/status/leases, and recorded operational evidence.

Native progress was reconciled to completed NetSuite quantities without
creating new physical load records. Existing receipt/load records were linked
to their verified accounting transactions. Cached order status was synced using
the existing mirror-aware repository functions. Local and accounting completion
were not fabricated for skipped deliveries.

The user explicitly skipped:

- SOA08854-S2 and SOA06143-S2 after reviewing Dispatch/NetSuite quantity conflicts.
- SOA08855-S1, SOA08855-S2, SOA10270, SOA10205, SOA10103, SOA09143-S1,
  SOA09143-S3 and SOA09140-S1 after reviewing open NetSuite status and missing
  Operator load evidence. Driver pickup/drop-off history was inspected first.

Post-apply verification checked all 133 entries, original native and Delivery
payloads/snapshots, released queue claims, and the database routing gate remaining
off. The two skip batches used the normal audited Admin resolution command.
The application remains on the original flow; Admin can later enable
**IR/IF posting via RESTlet** (`netsuite_ifir_posting_restlet`).

Operational audit files are under
`server/artifacts/netsuite-queue-resolution-20261021/`: `inventory-before.json`,
`remote-before.jsonl`, `remaining-before.json`, `missing-evidence.json`,
`rehearse*.jsonl`, `apply.jsonl`, `verification-after.json`,
`user-skipped-two.json`, `user-skipped-eight.json`, and `inventory-final.json`.
These are production audit/rollback evidence, not disposable test databases.
Scripts refuse to overwrite an existing audit. Do not rerun this dated repair
against a later queue without a new reviewed inventory.

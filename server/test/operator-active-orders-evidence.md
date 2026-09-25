# Operator stale active orders — September 18, 2026

## TOB00025: local obsolete duplicate corrected

Production reproduction returned obsolete internal ID 777039 in Active → TO.
The canonical ID 799386 is fulfilled/received and reconciled Completed.
SELECT-only NetSuite reads confirmed 777039 absent and 799386 Received.
The obsolete record had six missing lookups and an August 26 reconciliation note
identifying the duplicate, but its local active flag remained true. September 15
cleanup deliberately skipped the ambiguous reference rather than guessing an ID.

Applied at 2026-09-18 23:35:30 UTC: only `transfer_orders.netsuite_active` for ID
777039 changed to false, plus an audit entry. Both rows, all quantities and all
reconciliation history were retained. No NetSuite write or application deployment.

The exact SQL passed rollback rehearsal; the flag returned to true after rollback.
The apply transaction checked identity, lifecycle, missing evidence, absence of
operational activity and unchanged protected records. The actual Active TO feed
fell from 12 to 11 with all other IDs identical. A subsequent rollback rehearsal
was idempotent: 11 before and after. Among the 12 previously active TOs, this was
the only one with completed/cancelled/confirmed-missing reconciliation evidence.

Reproduction: `python3 tools/retire-obsolete-operator-to.py` (rollback default;
`--apply` is the guarded local correction). Artifacts and before-images:
`test-artifacts/obsolete-operator-to-20260918/`. No full application suite or
browser run was needed for this single local flag correction.

## SOA08404: split-parent visibility

Reproduced: Active showed original ID 985712; both materialized split children
were Loaded with all physical quantities loaded. The live query hides a parent
only while a child is not Loaded, which resurrects the unsplit parent after
children load. Current saved Driver evidence: S1 dropoff complete September 10
at 17:47:36 UTC; S2 complete September 17 at 12:14:45 UTC. The user clarified
that S1 is completed but has no local yard completion record. This distinction
is confirmed below; recorded Driver completion must be preserved.

Acceptance: active split children continue to hide their unsplit SO/TO parent
after loading. An unfinished child remains visible under its own split reference.
Packed parent cards also remain hidden. Inactive splits permit the parent to
return. Only the display query changes; no stock, loading or driver data changes.

Only two `local_yard_order_status <> 'Loaded'` child-existence conditions were
removed from `src/delivery-repository.js`. Eight database regression cases cover
SO and TO parents, completed children, unfinished children, Packed, and inactive
splits. The valid baseline failed four of these cases; all eight pass after the
change. The focused six-file packet passes 53/53 in both the workspace and exact
app image candidate.

The older worker image has two existing failures in reference-only group
handling: the same assertions fail on its unchanged baseline. Its baseline is
47 passed / 6 failed; the candidate is 51 passed / 2 failed, including all eight
new regression cases passing. `tools/active-split-parent-worker-baseline.py`
compares the complete failure details, normalizing duration and repository stack
line numbers displaced by the two removed lines. No reference-line behavior was
changed as part of this patch. Evidence: worker `baseline-comparison.json` in the
release directory and `test-artifacts/active-split-parent/worker-baseline.log`.

Read-only live preflight: 110 Active orders before, 109 with the candidate. The
only removed reference is the original SOA08404. Headers, line quantities and
Driver records for the original and both children retain identical fingerprints.
TOB00025 remains absent after its separate local correction.

Release directory:
`/home/ubuntu/operatorapp-deploy-backups/active-split-parent-20260918-v1`.
The app candidate is based on the concurrent field-sales release, preserving its
changes. No migration or NetSuite write is included. Deployed at
2026-09-18 23:49:33 UTC. Both containers have the verified source hashes and zero
restarts; local/public health returned 200, anonymous delivery access returned
401. Database and Ollama containers and app/worker configuration were unchanged.
The live post-deployment check reproduced 109 Active orders with only SOA08404
removed and protected delivery-history fingerprints unchanged. Full details are
in the release directory's `deployment-result.json`.

App image: `sha256:dda8e00d3f91810ce76aa4d4f0362ba5d8163fc66fb97a50341d46e24f638276`.
Worker image: `sha256:8d729701d34f59a0dd0edb6ee09c1b5012a4466ec10da3304ddd754b59a86266`.

## SOA08404-S1: missing yard evidence, independently confirmed

S1 has no `operator_load_records` row and no `delivery.order.load` audit event.
The September 15 delivered-SO cleanup changed its header from Open to Loaded and
filled three physical loaded quantities from the existing Driver completion. It
did not create an operator yard load record. Driver dropoff record 3246 completed
at 2026-09-10 17:47:36.878598 UTC; per-order completion event 15505 records that
evidence. The cleanup before/after is record 13 in
`test-artifacts/so-delivery-cleanup-20260915/dry-run.json`.

S2 has genuine yard load record 1134, created at 2026-09-16 23:17:59.094827 UTC,
with two photos and two loaded lines; delivery audit 2145343 records the load.
Its Driver completion is a separate later event.

The user approved a labelled historical reconciliation. Added local record
**1237** at **2026-09-18 23:53:59.592481 UTC**, with system audit **2157357**.
The record type is `historical_reconciliation`, its label is "Historical
reconciliation", and its unique source is `dispatch_order_completion_events`
record **15505**. It retains Driver job **3246** and the original completed time
**2026-09-10 17:47:36.878598 UTC**, separately from the reconciliation timestamp.

The record has no operator attribution, yard photos, new load request or reload
cycle. Its three line snapshots retain the already-reconciled loaded quantities:
459.4 SQFT Windermere, 96 PC Pisa Smooth and 7 EACH pallets. Metadata explicitly
states that original yard confirmation is missing and this is historical
reconciliation, with no new physical load or NetSuite fulfillment. It appears in
Control → Operator Load Records; the existing renderer exposes its historical
type and the readable label and supporting evidence in its details. Physical
load/movement reports continue to distinguish the original Driver-only evidence.

`tools/reconcile-soa08404-s1.py` defaults to rollback; `--apply` commits the one
record and audit entry. The exact transaction passed rollback rehearsal, including
actual history retrieval/rendering and repeated execution without duplicates.
Apply repeated those checks and verified the committed ID. Before/after
fingerprints for all three order headers, lines, Driver records, completion
events, pre-existing yard records, fulfillment records and other delivery audits
were identical. Active lists and physical load/movement reports were identical.
No application deployment, migration, quantity update or NetSuite call was needed.
Artifacts: `test-artifacts/soa08404-s1-historical-reconciliation/`.

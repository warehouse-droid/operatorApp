# Partial linked-order posting

User request, 2026-10-27: do not add pallet allocations; generally fulfill and
receive only the executed allocated quantity when the allocation is incomplete.
Tier 3. Spec approval: not obtained (autonomous run). The requested correction
and the two originally requested PO receipts are authorized; unrelated historical
orders are not a backfill target.

Acceptance criteria:

1. A verified linked PO pickup followed by delivery queues a durable IR job even
   when another PO line, including PALLET, remains unallocated. Pickup alone,
   cancelled links, wrong loads, reopened deliveries and changed identities do not.
2. The receipt selects only the delivered allocation quantities on their exact
   source lines. A 40/100 allocation receives 40; an unlinked pallet receives zero.
   Both whole-line and within-line partial receipts leave their residual open.
3. Multiple allocations on a line sum once. Replayed delivery, later duplicate
   evidence, concurrent workers and restart cannot consume one allocation twice.
   A later distinct delivered allocation may receive its own remaining quantity.
4. Positive NetSuite parent and line mappings, live remaining bounds, existing
   receiving gates, source claims, ambiguous-result recovery and verified remote
   transaction finalization continue to apply. Splits retain exact parent identity.
5. SO IF remains triggered by Operator loading, as currently configured. Partial
   load snapshots post only their saved quantity and explicitly deselect other
   lines. Later loads post only the increase; Driver completion cannot duplicate
   the load IF. No fake SO/PALLET lines or artificial loading/completion records.
6. General future admission is automatic. Historical recovery is bounded to
   LOINC-040951 / POB04107 (1082483) and LOINC-04087, now LOINC-040807 /
   POB04103 (1080498), using retained pickup 7271 and delivery 7300. Existing
   NetSuite fulfillment is verified and is not posted again.
7. Retain immutable execution/completion history, existing allocations, unrelated
   runtime files and production data. Record operational before/after evidence,
   exact posted references and partial status. No global historical queue scan.

Failure model: full-order over-receipt (exact payload and residual assertions),
duplicate consumption (unique allocation ownership, repeat/concurrency tests),
wrong route/line/parent (adversarial evidence and split tests), unsupported legacy
work (baseline regression comparison), disabled gates (negative admission),
partial transaction (rollback rehearsal), ambiguous remote save (existing durable
posting recovery tests), false local completion (real finalizer integration).

Setup: existing Node test runner, PostgreSQL, fast-check, ESLint, TypeScript and
c8; no new dependencies or commits. Freeze only scoped changes over the live
runtime. Tests use the repository disposable runner, bounded mbbs-tests.slice,
isolated credentials and unconditional container/volume/network/artifact cleanup.
Retain concise source evidence and genuine operational audits only.

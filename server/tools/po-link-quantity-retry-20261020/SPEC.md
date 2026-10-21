# Corrected PO quantities can be submitted after validation

Spec approval: not obtained (autonomous run). This follows the user's request to
fix GOB-122477-122479 / LOINC-039852 without a separate approval interruption.

Tier 3 for the boundary between rejected writes and uncertain retries. Scope is
the four quantity-capacity errors in createSalesOrderPoAllocationWithExecutor.

Acceptance scenarios:

1. With 28 EACH open on an SO and 23 EACH on its PO, requesting 28 returns HTTP
   400 and code DISPATCH_PO_LINK_QUANTITY_EXCEEDED. No allocation is committed.
   Correcting the same client dialog to 23 sends a new request and succeeds,
   leaving 5 EACH open on the SO and 0 on the PO.
2. The SO sales-quantity limit and both SO/PO physical-unit limits also return
   400 with the same code. Existing descriptive messages are preserved.
3. A batch that writes one line before another exceeds capacity rolls back the
   entire batch; the corrected batch succeeds without duplicate allocations.
4. A genuine HTTP 500 or lost response retains the exact original request and
   its identifier. The fix must not discard uncertain writes.
5. Partial quantities, exact limits, existing reservations, grouped sales
   targets, and repeated acknowledgement of a successful request retain their
   existing quantity and transaction behavior.

Failure model:

- Treating a rejection as uncertain freezes an obsolete quantity: actual HTTP
  plus the real client request runner tests the 28 -> 23 sequence.
- Treating an uncertain commit as rejected could duplicate work: existing
  save-reliability tests plus explicit 500/network-loss cases retain retries.
- Partial batch writes could allocate twice: DB integration verifies rollback.
- Relaxing capacity validation could over-allocate: boundary/property tests
  check both SO and PO limits and mutation checks remove individual guards.

Setup: reuse installed Node, PostgreSQL, browser and test dependencies. Add no
dependencies and no schema changes. Keep all unrelated workspace changes.
Capture the live runtime and release only the one-file delta over that capture.
Use the standard isolated Compose base under mbbs-tests.slice, bounded services,
and synthetic fixtures. Register teardown before startup, remove containers,
volumes and networks, and retain logs. Do not alter the user's operational links
or orders during validation. No checkpoint commits are required.

Evidence layers: regression tests, changed-line coverage, baseline-relative
static/lint checks, 3-5 manual mutants, boundary properties, actual HTTP
execution, source hash and dependency/capability diff, deterministic reordered
regression run, live health and cleanup verification. Whole unrelated product
suites may be recorded as unverified with an explicit scope explanation.

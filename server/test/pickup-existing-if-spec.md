# Customer pickup using an existing NetSuite IF

Tier 3: fulfillment evidence, duplicate prevention and concurrent confirmation.
The user requested that a locally pending pickup already billed in NetSuite reuse
its existing IF number and complete locally when the operator confirms pickup.
Implementation proceeds autonomously within that request; separate spec approval
has not been obtained. This document is the reviewable specification.

## Acceptance criteria

1. Each NetSuite-enabled customer-pickup admission reads the current source SO
   status. A normal open SO follows the existing posting path. Billed or Pending
   Billing SOs use existing fulfillment evidence and never create another IF.
   This intentionally revises the prior no-live-preflight choice for customer
   pickup; receiving and delivery-prep behavior remain unchanged.
2. Missing stored orderLine is recoverable from the authoritative SO item sublist
   using its stable lineUniqueKey and item ID. Never guess from SKU or row position.
3. Existing IF evidence must match source SO ID/reference, stable source line,
   source orderLine, item, exact inventory location, unit and shipped quantities.
   Read the actual IF by ID and verify its source, reference and positive lines.
   A Billed label alone is insufficient. Closed, void, unshipped, absent, conflicting,
   unreadable or insufficient evidence blocks completion and creates no IF.
4. Multiple IFs may jointly cover an exact source line; retain all their distinct
   numbers. Duplicate link rows must not double count quantities. Duplicate SKUs
   with different stable line keys remain distinct. Kit evidence that cannot map
   exactly is rejected for review rather than guessed.
5. Complete only the operator-confirmed quantities. Existing local quantity,
   packing, yard, photo and eligibility checks still apply. Partial pickup remains
   partial; a subsequent confirmation may use the same already-existing IF.
6. Persist an immutable reconciliation command with zero posting steps and an
   exact source claim. Keep request replay, local claims, worker leases and atomic
   finalization. Concurrent confirmations cannot complete the same local load twice.
7. Persist existing IF numbers in the operator load evidence and return them in
   the existing result transaction list so the pickup screen displays them.
8. NetSuite lookup failures preserve the local draft/photos and fail for review.
   No production fulfillment or receipt is created merely for validation; the
   previously audited orders are not bulk refreshed or marked picked up.

## Failure model and validation

- Wrong IF/source/item/location/unit: domain, property and adversarial tests.
- Duplicate line/link evidence and partial/multiple IF quantities: properties and
  hand-written mutation tests run independently against unit/property suites.
- Duplicate clicks, concurrent operators, failed finalization: real isolated
  PostgreSQL command/claim/rollback tests and the existing posting processor.
- Missing mapping blocks reconciliation: regression starts RED against the
  currently deployed behavior and covers the actual target/admission path.
- Evidence lost in response/history: finalizer tests plus existing UI renderer.
- Accidental NetSuite POST: HTTP boundary tests assert no transform request for
  reconciliation, and live validation uses GET/query only.
- Regressions: full baseline/final test comparison, zero new static diagnostics,
  changed-line coverage, secret scan and deterministic shuffled focused tests.

## Setup

Use existing Node 20, PostgreSQL 18, Docker, node:test, fast-check, c8, TypeScript,
ESLint and Playwright test image. No dependencies, migrations or commits are
planned. Preserve unrelated working-tree changes. Save an exact pre-change source
snapshot and run tests only on isolated disposable test databases. Add a focused
test runner, mutation/check scripts and evidence report in the repository.

Known boundary: a third party can modify NetSuite after a successful read. App
claims prevent competing app commands; they do not lock external NetSuite users.

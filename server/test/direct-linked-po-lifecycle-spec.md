# Direct-linked PO lifecycle correction

Spec approval: not obtained (autonomous run); the user authorized fixing PO/TO
schedule statuses and supplied the three affected orders.

The schedule follows the physical shipment: Direct ship before pickup, In Transit
after a linked pickup, and Completed after all linked product deliveries finish.

Acceptance scenarios:

1. A special PO with fully linked product and unlinked PALLET DEPOSIT lines completes
   at the real SO dropoff timestamp. LOINC-033146 retains September 14, 2026.
2. The same holds for narrowly identified non-stock Split Pallet Fee lines.
   LOINC-035332 retains October 1, 2026, from both active linked SO deliveries.
3. A fully linked PO with a completed pickup and no delivery displays In Transit
   in normal rows, status projections, filters and reconciliation enrichment.
   PO#B03964 must remain open until its delivery finishes.
4. Unlinked product quantities, unknown physical cargo, unpaid-for standalone
   pallet shipments, an unfinished linked SO, pickup-only and cancelled links
   cannot establish whole-PO completion.
5. Existing completed/manual statuses, review, hold, cancellation, partial-route
   completion and TO lifecycle behavior retain their precedence and contracts.
6. Receipt coverage still requires the existing whole-line proof. Newly accepted
   ancillary-only transport completion does not enqueue a NetSuite receipt.
7. Recovery is restricted to the two verified completed POs, preserves immutable
   Driver evidence, quantities and links, and is idempotent. A rollback rehearsal
   must leave no committed completion or receipt job.

Failure model and verification:

- Premature completion: adversarial product-residual, standalone pallet, unknown
  physical count and unfinished-SO scenarios against real PostgreSQL functions.
- Wrong historical date: exact active allocation and Driver evidence assertions;
  cancelled SO links do not supply the recovery timestamp.
- Accidental NetSuite posting: receipt-queue assertions, preserved strict admission
  and tests with external access disabled.
- Status regressions: schedule/filter/enrichment tests plus existing PO/TO lifecycle
  and completion suites.
- Partial write or replay: transactional rehearsal, rollback and repeated recovery.

Setup: use the existing isolated Docker runner and a task-owned cloned test database.
Add no dependencies and make no Git commits. Add one migration, extend schedule
projection and enrichment, persist tests, recovery/deployment scripts and evidence.
Deploy an overlay on the captured live image after tests, preserving app configuration
and unrelated concurrent workspace changes.

## User clarification, October 2

The user explicitly confirmed that PALLET lines are excluded from status, and
that completed product lines with unfinished remaining product lines must show
Partially Done. Replace scenario 4's standalone-pallet classification with the
rule that a pallet delivery cannot establish product progress. Add partial native
quantity and unfinished linked-SO cases, including filter and enrichment checks.
Split Pallet Fee treatment was asked separately; keep it explicit in evidence.

The user answered "Exclude the fee too". PALLET and the narrowly identified
non-stock Split Pallet Fee both follow the product shipment for status purposes.

The user then instructed "do not deploy first". Keep this follow-up patch and its
two-order historical repair local. Deployment and live migration require later
user authorization. Production has only been inspected with read-only queries.

Suite health follows the repository's per-file database isolation. An older TO
concurrency test commits a confirmed plan fixture; a subsequent PO planning test
in the same shared fixture fails its assignment-index readiness guard even on
the unchanged source. Reverse-order verification must use fresh fixtures per file.

## Deployment authorization, October 2

The user subsequently instructed “deploy with shortover with the waitlist change
as well”. This explicitly supersedes the preceding deployment hold and authorizes
the bounded two-order repair together with the tested waitlist enhancements.
The combined release was deployed and verified at 16:28 UTC; see
`deployments/po-status-waitlist-20261002/result.json`.

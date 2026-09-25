# Partial PO receiving and missing-line confirmation

spec approval: not obtained (autonomous run)

Tier 3: receipt creation changes inventory. User authorizes fixing SN1400625's
remaining pallet receipt, hiding already received lines, and adding a warning
when some outstanding lines are unconfirmed.

1. IR14645 received 360, 360 and 288 units on three split lines. Its unselected
   PALLET line remains 28 units. Reading SN1400625 shows only PALLET; confirming
   PALLET produces a new IR draft for parent POB03669, REST orderLine 34, quantity
   28, with SN1400625 in the reference fields. The earlier IR is unchanged.
2. Completed product line 25 must be omitted entirely from the new NetSuite
   static-sublist payload, even if cached parent counters lag verified postings.
   Other open, unselected parent lines remain explicitly deselected. Retain
   stored line identity, exact quantities, source claims and posting idempotency.
3. Successful local receipt quantities reduce the exact local PO line only.
   Failed/submitted records, deselected items, duplicate receipt evidence and
   sibling splits cannot consume the balance. Current NetSuite totals and local
   receipts overlap and must not be added twice. Keep source data unchanged.
4. A partial line remains open for its balance, with the previous confirmation
   consumed. A later confirmation can create another receipt. Recording the
   follow-up uses stable payload quantities, records a distinct receipt, and
   marks the shipment received only when every outstanding line is complete.
   Replaying the same receipt is idempotent; audit failure rolls back completion.
5. Selecting Receive with 3 of 4 outstanding lines confirmed opens a popup:
   one line is unconfirmed, with Go back and Receive confirmed lines actions.
   Go back preserves all confirmations. Proceed opens the photo/receipt flow.
   Completed lines are excluded from the count. Fully confirmed remaining lines
   proceed without a warning. Prevent duplicate dialogs on repeated taps.
6. Preserve existing transfer/local-CO behavior, photo requirements, completed
   order protection, allocation quantities, unrelated frontend edits and the
   previously deployed grouped-load/on-order fixes. No actual production receipt
   is posted during verification; the operator submits the outstanding pallets.

Failure model: duplicate receipts (replay/concurrency tests), wrong line or split
consumption (SQL fixtures and generated quantities), cache double counting
(overlapping evidence), stale confirmation (partial-line scenarios), omitted
static-sublist deselections (real draft assertions), partial local writes
(audit fault rollback), warning bypass (browser cancellation/continue/counts).

Use existing PostgreSQL/Node/fast-check/c8/ESLint/TypeScript/Playwright Docker
tools; no dependency installation, migrations, Git resets or commits. Add focused
tests and reproducible evidence scripts. Freeze deployed browser assets and apply
only the popup patch to those assets for release, since the workspace also has
unrelated frontend work. Compare related baseline tests and static findings,
measure changed-line coverage, kill targeted mutants, execute browser flows and
read-only production receipt drafts, and keep deployment rollback artifacts.

Cache contract clarification: this release must change operator.js and the
Operator service-worker cache to `20260917-receiving-followup-v1`. Existing tests
that pin the preceding return-release version must assert the exact new version.
Keep their behavioral assertions and additionally require the new popup CSS in
both the HTML and the installed service-worker asset list.

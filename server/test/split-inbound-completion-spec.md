# Completed split PO incoming inventory

spec approval: not obtained (autonomous run)

User authorization: exclude completed incoming split POs from incoming quantity and fix the general calculation.
Tier 2, using the old-coder workflow. No dependencies, migrations, commits, or external API calls are needed. Use the cached Node test image and an isolated PostgreSQL database. Preserve unrelated worktree changes. Deploy only the tested source files over the current app and worker images.

## Acceptance criteria

1. The POB03737 reproduction has three 24-PLT children whose NetSuite received counters are zero: two completed Driver drop-offs and one locally received child. Incoming is zero instead of 72 PLT.
2. Exact, case-insensitive, whitespace-trimmed PO split completion excludes that child only. Pending siblings, a matching SO reference, parent completion, and a completed pickup remain incoming.
3. A locally received header contributes zero even if its line counters are stale. Partial receipts subtract confirmed local physical quantities converted to sales units, plus the fixed pre-tracking baseline. Latest NetSuite receipts and local receipts overlap: use the greater cumulative receipt total, never add both totals. Unconfirmed or unposted receipt drafts do not consume incoming.
4. Remaining quantity is bounded by zero and the ordered quantity, including over-receipts. Full NetSuite receipt is recognized even when the fixed baseline is zero.
5. Planner, proposal inventory snapshots, vendor alternative evidence, and newly frozen transfer-phase PO evidence agree. Existing approved transfer-phase snapshots remain immutable.
6. Keep same-yard Blanket releases, active cross-yard releases, ordinary split relocation, closed/inactive/cancelled filters, and unrelated inbound reservations working. A completed child must not reappear as unsplit parent PO evidence.
7. Fix the calculation without rewriting PO quantities, receiving records, Driver completion evidence, or dispatch plans. Preserve manually edited proposal quantities and loads. If current draft display evidence needs correction, update only its inventory evidence, with before/after audit and rollback rehearsal.

## Failure model and verification

- False removal of pending supply: exact-reference, sibling, pickup, wrong-kind and partial-receipt regression tests.
- Double subtraction or mixed-unit errors: concrete cumulative-baseline examples and randomized bounded arithmetic tests.
- Different screens showing different numbers: real repository calls against PostgreSQL; frozen phase evidence checks.
- Unexpected edits: read-only live verification; any draft repair is transaction-bound with an audit and exact before-state guard.
- Static checks, changed-line coverage, at least five isolated manual mutants, existing related suites compared with baseline, reverse test order, and live execution.

Tooling and results are stored under `server/tools/split-inbound-completion-*`, `server/test/mbt/integration/split-inbound-completion.test.js`, and `server/test-artifacts/split-inbound-completion/`. Evidence will explicitly record skipped layers and limitations.

## Receipt draft boundary refinement

Inspection of `confirmReceivingLine` shows that editing another receipt overwrites the physical counters while the prior partial-receipt header remains. Only consume those local counters when their confirmation time is at or before the saved receipt time. A newly confirmed, unposted draft on a previously partially received PO must not reduce incoming. This adds a timestamp guard without changing terminal completion behavior.

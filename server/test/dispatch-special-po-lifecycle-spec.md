# LOINC-035925 direct pickup lifecycle

Spec approval: not obtained (autonomous run). The user requested correction of
duplicate planning and the missing Completed schedule status; prior deployment
authorization continues to apply. Tier 3: a database lifecycle correction.

The incident has a fully linked 1063.81 SQFT MBBS-Special line with 11 display
pallets, plus 11 EACH on its PALLET line. Both linked SOs have actual completed
Driver drop evidence. Special links intentionally store native Sales Qty, with
zero physical allocation quantities. Physical display counts must not create
additional freight after that native quantity has been fully linked.

Acceptance criteria:

1. Full native allocation of an MBBS-Special line leaves no PO route residual;
   partial allocation retains proportional display quantities and native cargo.
   All original PO/source quantities remain unchanged.
2. Ordinary stock lines keep their existing independent physical/native rules.
   Missing/zero native quantity, inactive links and unrelated line identities
   must not hide physical freight.
3. A fully linked special PO inherits Planned in SCM from its linked target.
   It becomes Completed only after every linked SO has Driver drop evidence.
   Pickup alone, one of two deliveries, or a partial allocation cannot complete it.
4. Completed linked POs are rejected by the existing server planning guard and
   appear Completed in SCM, using the real completion timestamp and evidence.
5. A new replay-safe migration corrects the coverage predicate and recovers
   missing historical completion from existing Driver evidence. Reapplication
   creates no duplicate event. Receipts, allocations, Driver records, plans,
   photos and NetSuite documents remain untouched.

Failure model and verification:

- Hiding real residual freight: exact incident tests, partial/unknown quantity
  adversarial cases, existing ordinary-stock suite and generated conservation cases.
- Premature completion: pickup, split delivery and partial-allocation integration tests.
- Duplicate history or partial migration: idempotent replay, transaction rollback
  rehearsal and previous application compatibility on an isolated database.
- Stale UI/server eligibility: live read-only SCM/order projection and planning
  guard probes after deployment.
- Unrelated production changes: freeze source, compare image files, preserve
  configuration, retain rollback images and take a fresh database backup.

Setup: use the installed Docker Node 20/Postgres 18 test images on an internal
network. No dependencies or credentials are added. Persist tests, runner,
mutation checks and evidence in this repository; preserve the existing dirty
worktree. No new commit is necessary to diagnose or deploy this correction.
Run related full suites, property checks, mutation checks, changed-line coverage,
lint/types relative to the current production baseline, and an actual image
smoke test. Record any unavailable or pre-existing failing layers explicitly.

Investigation addendum: the existing planning guard reads direct Driver refs,
which omit the PO on linked pickups. The completion projection must restrict
the visible PO card, and the server guard must recognize its canonical Driver
completion under both the current PO ref and original NetSuite number.

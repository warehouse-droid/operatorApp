# Evidence — PO Split discovery and PO/TO status consistency

Status: GREEN and deployed; final isolated gauntlet and post-cutover production
parity audit complete.

## Diagnosis and RED proof

The read-only production audit found `POB03782` in `purchase_orders` as an
active `B / Pending Receipt` PO with initial SCM status `Hold`, but with no
schedule, split, group, or indexed PO Split catalog entry. The internal catalog
refresh had been run through an anonymous audience filter, which removed Hold
orders before indexing. The catalog source was also capped at 500 records and
the indexed response returned its stored status without consulting the current
schedule row.

Before production changes, the focused integration suite failed 5/5: the 501st
PO was absent, an active Closed PO was absent, a `POB03782`-shaped Hold PO was
not indexed, indexed detail remained Queued after a saved Hold, and PO Split
disagreed with PO/TO Schedule. Two follow-on RED tests separately reproduced a
Hold-to-Queued role-filtering miss and missing Reconcile Review evidence when a
legacy schedule had no direct reconciliation-state pointer.

The post-cutover parity audits then found three additional production-shaped
failures before the work was declared complete:

- `POB03794` moved from Pending Approval to Pending Receipt in the durable
  delayed-status worker after its initial catalog refresh. The emitted type was
  `purchase_order`, while the catalog listener accepted only `PO`, so the newly
  eligible PO was not refreshed.
- the catalog entry `PO# B03429 (L1)` linked to schedule ref `POB03429`, but the
  live overlay checked only the display ref and therefore retained Queued.
- after the first linked-Hold repair was deployed, a newly arrived display alias
  `SN1399430` still showed Queued. It had no reconciliation pointer of its own,
  but linked source `POB03669` already resolved to Partially Done through the
  newer shared reconciliation state.

Each shape received a regression before its implementation. The delayed-event
test failed because the router was absent; the exact `PO# B03429 (L1)` test
failed with actual Queued instead of Hold; and the exact new-alias test failed
with actual Queued instead of Partially Done. Only then was the linked-status
selection generalized.

## Implemented behavior

- Full internal catalog builds are unbounded by the 500-row response guard and
  include every active non-Pending-Approval PO, including Hold and closed
  lifecycle rows. Existing role visibility and write-side closed-order guards
  remain in force.
- Pending Approval is rejected by NetSuite code `A` and by normalized
  `Pending Approval` / `Pending Supervisor Approval` labels.
- Indexed list/detail reads overlay current schedule, completion, assignment,
  and reconciliation evidence using the same terminal/review/timestamp
  precedence as PO/TO Schedule.
- Live evidence lookup follows every indexed linked PO identity. A display
  alias whose own effective state is only Queued or Planned yields to a linked
  source/split/group effective state that has advanced to Hold, Partially Done,
  or another non-baseline state. Non-baseline display states and existing
  completion/review precedence remain authoritative.
- Delayed NetSuite events normalize `purchase_order`/`PurchOrd`/`PO` and prefer
  `tranid` over a numeric internal ID when queuing a targeted PO catalog refresh.
- Role-filtered pagination scans past restricted live statuses so stale catalog
  snapshots cannot hide a PO that has returned from Hold to Queued.

## Verification

The reproducible command is:

```sh
npm run gauntlet:scm-po-split-status-consistency
```

Its final isolated run completed successfully with:

- clean migrations 001 through 189;
- 20/20 focused unit, property, and database integration checks, including all
  post-cutover production-shaped regressions;
- 3/3 indexed PO-catalog checks;
- 44/44 authoritative PO/TO status checks;
- 13/13 PO Split frontend checks and 7/7 schedule-loading/performance checks;
- passing behavior-level restricted-order DB/API and PO Split filter harnesses;
- 100% statements, 95.45% branches, 100% functions, and 100% lines for the
  extracted status-precedence policy;
- zero-warning focused ESLint, legacy browser syntax, and TypeScript checks;
- 12/12 killed mutations (100%), with source restoration verified;
- a clean changed-line secret scan and SHA-256 source-state manifest.

The older `test:scm-order-visibility` source-text harness is not part of this
gauntlet because this branch's pre-existing single-flight refactor renamed its
expected `async function listDispatchOrdersForResponse` marker. It fails before
behavioral assertions; the stronger live DB/API visibility harness passes.

## Predeployment production population audit (read-only)

The audit examined all current PO/TO mirror and schedule status families without
performing a write:

- `purchase_orders` contains 904 rows: 5 Pending Approval and 899 other rows.
  There are 883 active rows, including 553 Fully Billed, 116 Pending Receipt,
  78 Pending Bill, 78 Pending Billing/Partially Received, 39 Closed, and 13
  Partially Received. Three active rows are Pending Supervisor Approval, leaving
  880 active POs eligible for catalog discovery before existing role visibility.
- Active Transfer Orders include 722 Received, 41 Closed, 35 Pending
  Fulfillment, 4 Rejected, and 3 Pending Approval rows. The PO/TO Schedule reads
  these directly rather than from the PO Split catalog.
- Persisted schedule rows include PO statuses Completed 628, Planned 79, Queued
  52, Hold 47, Cancelled 36, and Partially Done 24; TO statuses include
  Completed 585, Planned 97, Queued 68, Cancelled 35, In Transit 19, and
  Partially Done 2.
- The ready PO Split catalog held only 21 entries. `POB03782` was active,
  `B / Pending Receipt`, initial status Hold, and had no schedule/split/group
  relationship, yet was absent. This is the exact background-audience defect
  covered by the new regression.
- Two apparent raw saved-status/catalog differences were checked and both had
  newer reconciliation application status `Partially Done`; they were valid
  precedence outcomes rather than stale rows.

No production schedule, NetSuite mirror row, or reconciliation state was
changed during diagnosis or test verification.

## Deployment and post-cutover proof

- The newest validated custom-format PostgreSQL backup is retained at
  `docker/backups/mbbs-before-dispatch-stale-identity-location-20260828T155056Z.dump`
  (234,195,058 bytes; 3,055 archive entries). Production was already current
  through migration 189, so migration was a no-op.
- The final generalized PO fix used an app-only cutover. Container recreation
  took 1.725 seconds at 16:09:23Z on 2026-08-28 (5.860 seconds end to end), and
  `/health` returned 200 with the app healthy. PostgreSQL and the webhook worker
  stayed online; the worker retained its original 15:54:45Z start time.
- The final app image is
  `sha256:eb477e3a2b8ef44960049557dbaf9fc95ed4d9a71df8e8f7e3bc9ee36b69ff24`;
  the uninterrupted webhook-worker image is
  `sha256:561ed980096ca2738d894cfe37b4dd5f5c447c274a15d348a13a285e65a44596`.
  Rollback tags were retained for both the original and intermediate healthy
  app images.
- The final PO catalog was ready at generation 47 with 884 entries, no error,
  and 55/55 refresh jobs complete. The database contained 889 active POs: 3
  Pending Approval and 886 eligible. All 886 eligible refs were represented
  directly or by a linked catalog identity; missing count and Pending Approval
  leakage were both zero.
- A full 884-card deployed-repository scan found zero linked-Hold rows still
  showing Queued or Planned. `POB03782` was directly searchable as Hold;
  `PO# B03429 (L1)` resolved to Hold; and new alias `SN1399430` resolved to
  Partially Done. Canonical completion evidence correctly kept the completed
  members of both linked families Completed.

The deployment intentionally rebuilt only the derived PO catalog. It did not
change any production schedule, NetSuite mirror, receipt, split, or
reconciliation source row.

## Follow-up — B03429 L1 user-authorized completion

On 2026-08-28 the user explicitly confirmed that `PO# B03429 (L1)` was
completed by Driver Dao on 2026-08-11. Before the write, production contained
the active split relation from `POB03429`, a saved Queued row for L1, a Hold row
for the source, and no canonical completion event. Driver master data resolved
Dao to active login `dao`; the only nearby PWA jobs belonged to L2 and Driver
Li, so those records were not reused.

The exact manual-completion command was first executed inside an unconditional
rollback transaction. Before it, the deployed repository projected L1 as saved
Planned / calculated Queued with Driver Dao. Inside the rollback proof, the
active view omitted it, the explicit Completed view returned calculated
Completed / Dao, and PO Split returned Completed with `manual_dispatch`
evidence. The rollback left no event.

The identical command was then committed atomically with a Dispatch audit and
targeted catalog refresh:

- canonical completion event `13738`;
- Dispatch audit `16581`;
- catalog refresh `71`, completed;
- completion timestamp `2026-08-11T16:00:00.000Z` (noon America/Toronto; the
  supplied date had no time);
- completion evidence `manual_dispatch`, explicitly naming Driver Dao and
  preserving that no Driver-PWA record was created.

Post-commit and post-cutover verification both returned no L1 row in the active
schedule, one L1 row in the Completed view with Driver Dao, and PO Split status
Completed with canonical event `13738`.

## Follow-up — linked initial Hold generality audit (2026-08-29)

A post-deployment audit of every reported bug class found a new production
shape before generality was signed off. `POB03782` had acquired display ref
`LOINC-029735`. Search returned that linked card, but its effective status was
Queued even though the current source mirror remained active, Pending Receipt,
and initial SCM Hold. The alias had a Queued schedule row and shared
reconciliation state; the source ref had no schedule row. The live overlay did
not query `purchase_orders.initial_scm_status`, so it could not select the
source Hold as the linked non-baseline state.

Before implementation, a disposable-database regression reproduced the generic
shape with generated source/display refs. The focused integration file ran
13 scenarios: 12 passed and the new case failed with actual Queued versus
expected Hold. Production remained read-only during diagnosis.

The resolver now looks up the current source PO mirror by every exact linked
transaction/display identity and exposes its initial SCM state to the shared
status policy. A saved schedule remains authoritative for its exact identity;
an unscheduled linked source Hold can replace only a baseline Queued/Planned
display result. The focused unit/property/integration suite is GREEN at 23/23,
including 500 randomized stale-alias states. Mutation testing killed 14/14
faults, including removal of the mirror lookup and removal of source-status
precedence, and restored the sources.

The complete isolated gauntlet then passed with the 23 focused checks, 3/3
catalog workload checks, 44/44 authoritative-schedule checks, the live
visibility/filter harnesses, 13/13 browser checks, 8/8 schedule-loading checks,
100% statements/lines/functions and 96.15% branches for the extracted status
policy, zero-warning lint/syntax/type checks, 14/14 killed mutations, and source
state SHA-256
`ac9130fc4add1f6eef63b634f3b423e19c1ad17042838371f2b114462b15fa50`.
The independent full MBT run also passed 428 files / 2,117 tests.

Before cutover, the candidate image was exercised read-only against the full
production population. Exact `POB03782` search returned display alias
`LOINC-029735` as Hold, and the alias-specific scan of all 888 catalog cards
found zero linked active-Hold sources still displayed as Queued or Planned.
Five exact searches took 26-47 ms. A separate direct PO, `POB03797`, retained
its exact saved Queued schedule; audit evidence showed that this was a direct
operator schedule override rather than a linked-alias miss, so the resolver did
not incorrectly replace it with the source PO's initial default.

The app-only production cutover was completed on 2026-08-29:

- validated pre-cutover backup:
  `docker/backups/mbbs-before-po-status-generality-20260829T010150Z.dump`,
  239,345,305 bytes, SHA-256
  `69c270878b0620f3e70fe446a77ddc73c5ff8c29bc8845f4a504df8f71f6a092`;
- rollback image:
  `mbbs-operator-app-app:rollback-pre-po-status-generality-20260829T010150Z`,
  image ID
  `sha256:22825c1fdb0e9f4aeef70527abb229c22c881b0a7506dd77b5e844268dc68e8d`;
- release image:
  `mbbs-operator-app-app:release-po-status-generality-20260829T010150Z`,
  image ID
  `sha256:a521b21fa5704b68263c0c2b364efd2c0f6b6dd499a2e7aed7338290f131b568`;
- Compose recreation itself took 1.650 seconds (4.537 seconds including tool
  round-trip). PostgreSQL and the webhook worker retained their prior container
  start times. The new app became healthy and `/health` returned 200.

Post-cutover, the rebuilt PO catalog was ready at generation 97 with 888 cards
and no error. `POB03782` remained `LOINC-029735 / Hold`; the full alias scan
again found zero stale linked-Hold baselines. `PO# B03429 (L1)` remained
Completed with `manual_dispatch` evidence. On the PO/TO Schedule read path the
fully split `POB03774` source remained hidden; completed child `SN1399024` was
available only in Completed history, while unfinished child `SN1399025`
correctly remained Hold.

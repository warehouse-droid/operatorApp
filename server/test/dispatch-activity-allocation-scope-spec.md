# Driver activity allocation scope

Spec approval: not obtained (autonomous run). Risk tier 3: this comparison
protects recorded cargo. No production writes or deployment are part of the
implementation/test run. Preserve all existing working-tree changes.

## Incident

September 13 plan 326, recovery 17308, app image
`mbbs-operator-app:recorded-po-load-20260914-v1`: CO-SOM06255-S1 is in Load 5.
After the existing timing overlay, the only conflict is an allocation change
on completed load `T7-L1789251646795-0332f4d1b90068`. Its actual stops and grouped
cargo are unchanged. The old snapshot also contains unassigned
CO-GOA-8111-8113, whose child references overlap assigned GOA-8111-8113.
Removing that unrelated catalog row triggers the guard. Restoring it in an
in-memory comparison removes the conflict. Live investigation is read-only.

## Acceptance criteria

1. Removing, refreshing, or adding an unassigned CO with children shared by a
   completed SO group must not create a driver allocation conflict. Appending
   CO-SOM06255-S1 to a later load remains allowed.
2. A related CO assigned to another, unstarted load remains editable. The
   executed load comparison must use that load's physical route assignments.
3. Every order in an executed consolidated pickup remains protected, including
   secondary `orderRefs` and grouped children. Actual changes to quantity,
   item, destination, or allocation among children must still fail.
4. Missing assigned order data and edits/removal/reassignment/reordering of
   executed physical stops still fail. An order assigned by a legacy alias or
   as an exact nested child remains subject to allocation protection.
5. A CO actually assigned to an executed load remains protected. Never exclude
   all COs merely by type, and never restore an unrelated CO to make saving pass.
6. Repository checks use persisted driver activity, return the existing 409
   conflict contract, and perform no partial writes on rejection. Existing
   route-prefix concurrency and assignment tests remain green.
7. Replay the recorded draft with the fixed comparison and the normal timing
   overlay; verify that completed load data, source records, driver evidence,
   active plan revision, and recovery drafts are unchanged by the replay.

## Failure model and verification

- Fail closed on real cargo edits: negative unit tests, fixed-seed properties,
  adversarial removal/type/alias cases, and deliberate allocation-guard mutants.
- Fail open on harmless catalog changes: reproducing RED tests and both-sided
  properties combining incidental catalog changes with real cargo changes.
- Partial write or Driver race: existing repository atomicity/concurrency tests
  and a scoped rollback replay where available.
- Scope creep into lifecycle or execution: keep the change inside the allocation
  comparison; preserve conflict codes, lock ordering, and runtime capabilities.

## Setup

Use installed Node, fast-check, ESLint, TypeScript and c8 from the existing
isolated test image. No packages, migrations, git commits, production repairs,
or changed client assets. Add focused tests, a fixture, persisted mutation and
gauntlet commands, and evidence. Run the new behavioral RED cases before code,
then affected suites, full MBT/legacy suites with baseline comparison, static
checks, changed-line coverage, mutations, and the recorded replay. Record any
unavailable layer explicitly. Test containers use isolated networks/databases.

## Authorization and replay update (append-only)

The user subsequently requested deployment after focused regressions pass,
followed by continued broader regression. The focused suite passed before the
app-only deployment. Production recovery drafts are not promoted automatically.

Automatic approval review rejected a scoped payload export to local disk because
the export/destination had not been authorized. No payload was exported. The
permitted alternative reads plan 326 and recovery 17308 in a read-only
transaction, evaluates the tested code in memory, and emits only assertion
results. This is the production replay, not a production save/confirmation.

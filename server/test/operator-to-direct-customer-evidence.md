# Completed direct customer TO: deployment and reconciliation evidence

TOB01208 is completed locally and **Received in NetSuite**. Its direct link to
SOA09895 remains. The repair reused shipped **IF157104 / 1046775** and submitted
exactly one **IR15082 / 1052933**, for item 1256 **26 PC** and PALLET item 1784
**1 EACH**. Fresh NetSuite source, linked transaction lines, and REST records
confirm both quantities and the correct transfer parent, 1045195.

The original all-TO reconciliation and its two Receiving exceptions remain
deployed. The current 1,053 local TO headers contain 985 Received, 54 Closed,
three Pending Receipt, three Pending Fulfillment, one Partially Fulfilled,
one Pending Approval, and six Rejected. Received and Closed totals include
historical and local mirror records; they are not new physical movements.
All current TO posting jobs are completed: 13 IF and one IR.

## Authorization and executable specification

The user authorized deployment and reconciliation of every TO, preservation of
historical completion, retention of the TOB01208 direct link, and completion of
its accounting after the delivered SO. Specification approval was **not obtained
separately (autonomous run)**. The append-only acceptance criteria are in
[operator-to-direct-customer-spec.md](operator-to-direct-customer-spec.md).
No dependency or unrelated SO behavior was changed.

| Specification | Executed evidence |
| --- | --- |
| Fully covered direct material and loaded pallet complete locally; one existing receipt owns the IR | Full-delivery integration, replay, real committed concurrency; live receipt 326 and one IR job |
| Residual material, incomplete allocations, cancelled plan, withdrawn Driver, mismatched receipt or absent physical proof prevent completion | Six negative integration cases; foreign existing IF regression |
| Verified IF precedes IR and belongs to the exact TO, scope, items and quantities | Waiting-IF integration, wrong-parent rejection, strict existing IF verification, 250 generated direct IR property examples |
| System receipts retain actual receipt and Driver identities; ordinary manual posting requires an Operator | Native draft hostile-input cases, ordinary receiving regression, PostgreSQL constraint rejection |
| Durable external ID, verification and finalization prevent duplicate accounting; original provenance survives | Idempotent finalizer integration; live native command completed, one posted step, attempt count 1, exact IR external ID |
| Accounting reconciliation preserves the linked delivery and physical history | Dry-run and audit-failure rollback; before/after live comparison of dependency allocations, Driver jobs and prior completion events, SO loads, packing/receiving drafts and receipt provenance |

## Validation

The exact captured production candidate passed **173/173** selected checks with
zero failures. These cover PostgreSQL, authenticated HTTP, ordinary TO yard flow,
direct customer completion, existing IF recovery, physical receipt capacity,
Driver/dispatch scope, native command admission, concurrency, direct PO
regressions and generated properties.

The original direct-completion RED run had ten behavioral failures and one
pre-existing ordinary actor regression passing. The final suite retains the
assertions. Eight deliberate application mutations were detected: admitting IR
before IF, counting unallocated material, borrowing another TO's IF, ignoring IF
quantity, skipping Driver replay discovery, inventing an ordinary system actor,
omitting the audit, and accepting missing system proof. The three applicable
IF/IR property mutations were independently detected by the property suite alone.
The remaining five target integration behavior outside that property's scope.

All **238/238 changed JavaScript statements** were executed, including
**125/125** statements in the new direct-completion repository. Changed coverage
is recorded in `test-artifacts/operator-to-direct-customer/changed-coverage.json`.
Targeted TypeScript comparison has **23 baseline and 23 final diagnostics, zero
new**. Lint, including the new-function complexity checks, has zero new findings.
The final source and operational scripts passed the credential scan. No
dependencies changed, so dependency audit and license review were not repeated.

The full repository suite and whole-repository compiler were not repeated for
this final direct-customer overlay. The earlier ordinary-TO comparison retained
109 pre-existing failing test files and 866 compiler diagnostics; details are in
[operator-to-yard-flow-evidence.md](operator-to-yard-flow-evidence.md). The
current 173 checks and targeted 23-diagnostic comparison do not claim a green
whole repository. Browser E2E outside the existing authenticated HTTP checks was
not repeated because no browser code changed. Reverse-order suite evidence
belongs to the earlier ordinary-TO run; this overlay used sequential test files.

Initial mutation tooling lacked the public-directory symlink; its infrastructure
failure was corrected before recording the eight valid mutation kills. New type
and complexity findings were corrected by refactoring, without weakening
assertions. Disposable mutant source copies were removed.

## Production verification and preservation

The deployed app is
`sha256:b33113d2cb6cc7f9ab04aec688d7da94b300723203c339f45bfe646b592b1705`.
It overlays five existing modules, one new module, and migration 280 on the
captured live image. The worker remains
`sha256:d1f7eed8916870fa7ebe9ca19a0d733e6e0d595ccdd26b27c937d068126f68c9`.
Environment values, unrelated source, production DB and Ollama identities were
preserved. Builds used the existing image and disabled networking.

The first production admission exposed a deployment omission: migration 280
was present in the image but had not been applied to the database. The existing
actor constraint rejected command creation **before any NetSuite submission**.
The deployment tool now explicitly applies only the verified migration, records
its prior constraint privately, and checks the live definition and migration
registration. Migration 280 was applied and verified at
2026-10-10T00:45:32.901Z; unrelated pending migrations were not run. The existing
direct-PO exception and ordinary Operator requirement remain enforced.

The same IR job, `ce5f4cbc-2cc5-44a5-aa0d-d24b7761faa9`, was resumed with fresh
NetSuite evidence and an operational audit. Its native command uses external ID
`MBBS-OP-ce5f4cbc-2cc5-44a5-aa0d-d24b7761faa9-1`, real direct receipt **326**, and
effective linked SO Driver completion **20971**. The worker completed and
verified IR15082 on its first NetSuite attempt. An initial wrapper JSON parsing
failure after worker completion was resolved by reading durable state; it did
not trigger another submission. Operational output now uses a distinct result
marker and retains private logs before parsing.

NetSuite readback at 2026-10-10T00:49:56.301Z confirmed transfer status **G,
Transfer Order : Received**, exactly one linked IF and one linked IR. The verified
IR and source progress were then reconciled into the local TO and dependency
accounting metadata. SOA09895 remained **Sales Order : Pending Billing**, with its
delivery completion and link unchanged.

Final read-only live checks at 2026-10-10T00:50:48.909Z confirm TOB01208 is absent
from open outbound and ordinary Receiving, with local loaded/received completion
and dependency accounting reconciled. No physical load or receipt was invented:
the TO still has zero canonical Operator load records and its original single
direct receipt. Its receipt payload, actor and delivery provenance, existing
Driver records/events, SO load records, dependency allocation quantities and
packing/receiving drafts match the private before snapshot.

TOB01134 remains visible in Receiving at **3445**, capped at 104.91 SQFT plus one
pallet. TOB01200 remains visible at **2967**, capped at the shipped one EACH saw.
TOB01224 remains receivable against its real loaded quantity, and unloaded
TOB01221 remains hidden from Receiving. Wrong-yard lists and detail access were
checked. The two legacy exceptions already have accounting receipt quantities;
the new physical acknowledgment cannot authorize duplicate IRs. TOB01134's
104.902 versus 104.91 SQFT accounting difference still needs review before any
additional accounting receipt.

All 12 Operator IF/IR gates and all four Dispatch SO IF gates are enabled across
3445, 2967, 12441 and 150, with global NetSuite direct access enabled. The SO
activation watermarks still prevent automatic replay of historical deliveries.

## Reproduction, retained records and cleanup

Run `server/tools/operator-to-direct-customer-checks.sh` against the captured
candidate, then `operator-to-direct-customer-evidence.py` to collect source
hashes, test/mutation/static results and the final secret scan. The deployment
tool includes an explicit migration stage. The live NetSuite capture,
reconciliation and read-only final check are separate scoped tools; `apply` is an
operational posting action and is not a test command.

Private operational source, before/after snapshots, NetSuite records, logs,
constraint backup, runtime configuration and rollback images remain under
`/home/ubuntu/operatorapp-deploy-backups/to01208-delivery-prep`. These are
authorized operational audit and rollback records, not test databases. Redacted
results are in `server/test-artifacts/operator-to-direct-customer`.

Tests used the bounded isolated Compose configuration and `mbbs-tests.slice`.
Teardown was registered before launch and removed containers, database storage,
and networks with `down --volumes --remove-orphans`. One-off scans used `--rm`,
init, explicit resource limits and the disposable-test label, with final removal
registered before launch. Final **docker ps and docker ps -a show only the four
production containers**. No test volumes or networks remain; production and
rollback volumes/networks were preserved. App, DB and Ollama are healthy, the
worker is running, and the live health endpoint passes.

The subsequent Customer Pickup UI overlay preserves this backend and TOB01208's
completion. The user later completed TOB01134 in NetSuite with IR15083; its
requested targeted sync now marks it completed locally and removes it from
Receiving. TOB01200 remains receivable. Current UI image, asset checks and sync
evidence are in
[customer-pickup-inline-wait-evidence.md](customer-pickup-inline-wait-evidence.md).

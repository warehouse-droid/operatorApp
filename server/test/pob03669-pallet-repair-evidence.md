# POB03669 PALLET repair — completed

Applied **2026-09-16 19:27:19 UTC**; independently verified at **19:28:05 UTC**.
User authorized the correction after reviewing the incident findings.
Separate executable-spec approval: not obtained (autonomous run).
Tier 3 inventory data repair; [specification](pob03669-pallet-repair-spec.md).

## Result

POB03669 / 939701 is **Partially Done / reconciliation OK**, with no reason.
Review case **375** resolved through `auto_resolve`; it was not accepted or
dismissed. Blocked schedule rows decreased from **18 to 0**. All 20 existing
schedule statuses stayed the same. Repair audit: **2143857**.

| Split / ledger | NetSuite evidence | Final quantity | Final source key / orderLine |
| --- | --- | ---: | --- |
| SN1399039 / 450 | IR14242 / 969277 | 22 | 4851536 / 34 |
| SN1399065 / 454 | IR14239 / 969017 | 40 | 4737073 / 8 |
| SN1399105 / 463 | IR14245 / 969704 | 23 | 4851536 / 34 |
| SN1399337 / 475 | IR14288 / 972610 | 28 | 4851536 / 34 |

Three source identities moved from local source 127428 to 368856. Child
`netsuite_order_line` values were also corrected. Quantities 18, 0 and 0 were
restored to 40, 23 and 28; the last two child rows were reactivated. Original
requested quantities and source baselines remained unchanged.

The source PALLET lines remain 249 and 341 units, with active split quantities
249 and 241 respectively. Fresh evidence contains **20 receipts**, including
IR14645. The refresh retained all previous receipts and deleted none. The
reconciliation's aggregate received/remaining counters are 21,357 / 3,785.

## Executed checks

| Specification | Evidence | Result |
| --- | --- | --- |
| Exact source, split and receipt identities | Fresh source query, four direct receipt GETs, linked receipt comparison and guarded row assertions | Pass |
| Correct line keys, quantities and stored orderLine | Actual transaction plus independent committed-state read | Pass |
| Existing receipt history and latest IR14645 | 20 stored snapshots, 0 deleted; IR14645 required | Pass |
| Capacity and baseline bounds | Line 8: 249/249; line 34: 241/341; both baselines 0 | Pass |
| Preserve unrelated inventory and operator progress | Compare 79 item rows and 59 ledger rows, allowing only the four specified changes | Pass |
| Preserve planning, holds, locations and completions | Compare 20 split headers, 21 PO headers, 20 schedules, 18 assignments and 18 completion records | Pass |
| Detect original defect | Pre-repair verification failed `REPAIR_SOURCE: 127428 !== 368856` | RED observed |
| Atomic correction and rollback | Complete repair plus two reconciliations inside forced rollback; complete snapshot equality afterward | Pass |
| Reject incorrect source, quantity and orderLine | Three deliberate transaction faults rejected with their specific assertion; complete snapshot equality after each rollback | 3/3 passed |
| Stable reconciliation | Two consecutive reconciliations produced identical quantities and target states | Pass |
| Repeated repair | Second apply returned `alreadyApplied: true` and performed verification only | Pass |
| Persisted result and audit | Independent verify command; review 375 resolved, 0 blocked rows, audit 2143857 | Pass |

Final focused regression: **30 passed, 0 failed, 0 skipped**. This includes
the existing memo-reference, destination-allocation and property tests; three
properties each ran 250 examples. The transaction fault checks are a separate
guard test, not a claim that the property suite killed those faults.

JavaScript syntax, Python AST parsing, shell syntax, scoped credential scanning
and Git whitespace checks passed. No dependencies, schema, NetSuite records,
application runtime code, deployment or commit were changed by this repair.

## Commands and source identity

From the repository root, the executed pre-apply workflow was:

```sh
sudo -n python3 server/tools/pob03669-pallet-repair.py capture
sudo -n python3 server/tools/pob03669-pallet-repair.py verify
# The preceding verify deliberately failed against the original broken rows.
sudo -n bash server/tools/pob03669-pallet-repair-checks.sh
sudo -n python3 server/tools/pob03669-pallet-repair.py apply
sudo -n python3 server/tools/pob03669-pallet-repair.py apply
sudo -n python3 server/tools/pob03669-pallet-repair.py verify
```

The checks entry point runs isolated regression/property tests, syntax and
credential checks, three rollback fault tests and the complete rollback rehearsal.
It deliberately refuses changed production preconditions. After repair, use
`verify`; rehearsing the original incident again requires an isolated restoration
of the private pre-repair snapshot. Do not revert live data to rerun a test.

Private backups, timestamped results, regression output and errors are retained
under `/home/ubuntu/operatorapp-deploy-backups/pob03669-pallet-repair-20260916/`
with restricted permissions, outside Git. The archive contains the full
before/after records needed to inspect the correction.

Git base: `8640191ca7709a882c00bb684dfe24db10b03b2d`; existing dirty work preserved.
Node: 20.20.2. Test image: `mbbs-retired-confirm-test:20260914`.

Repair runner SHA-256:
`96e2941ba1af57232b2ac297e6bff17853a55192c93a0535f133ab93d72980e2`.
Evidence fingerprint:
`2a36768eb08b010a0103641fe92505d424e40f5772772f01bc141c9a22623c29`.

## Limits and deviations

- Full application regression, TypeScript and application lint were not rerun:
  this was a scoped production data correction with no runtime code change.
  The repair tools received syntax and actual execution checks.
- Changed-line/branch coverage of the operational runner was not instrumented.
  Positive execution, rollback, all three injected faults and repeat execution
  were observed; these do not establish exhaustive branch coverage.
- Randomized whole-suite order and property-only mutation runs were not executed.
  The existing properties passed; transaction faults verified repair guards.
- No dependency/license audit was needed because no dependencies changed.
- Locks, changed-state guards and an active-posting check protect the local
  transaction. They cannot lock external NetSuite editing; receipt evidence was
  fetched at 19:25:29 UTC, less than two minutes before application.
- The first read-only snapshot attempt used an absent assignment-table `id`
  column and failed. The query was corrected to use its actual plan/reference
  fields before capture or any repair writes. All final checks used the same
  final repair-runner hash.
- Rollback rehearsals can advance PostgreSQL sequence counters. Their row
  changes and audits rolled back and exact snapshot equality was verified.

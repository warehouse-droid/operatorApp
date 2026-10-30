# Special request child PO evidence — 2026-10-28

Spec approval: not obtained (autonomous run). Scope and invariants are in
[special-child-po-spec.md](special-child-po-spec.md). No dependencies or commits
were added. The release applies only the task diff over the captured live image;
unrelated workspace changes are excluded.

| Acceptance | Executed evidence |
| --- | --- |
| Attach an active child of the source; reject invalid, foreign, cancelled, received or stale targets | Database integration suite; browser HTTP concurrent attachment race returns one 200 and one 409 |
| Preserve source/siblings; scope remarks, planning, completion and handoffs | Exact before/after database comparisons; completion integration; 50 seeded planning property cases; old-worker handoff trigger test |
| Save child routing and notes locally with revisions and locks | Real Chromium page and HTTP API; stale routing replay returns 409; unit boundary rejects any shared NetSuite Note write; attached child cannot be cancelled |
| Preview manually linked PO without draft lines, retaining native identity and authorization | 40 seeded snapshot property cases; document service with a native-PDF boundary; existing document tests |
| Show description and fractional child quantities independently | Schedule SQL integration asserts description, 1771.2 SQFT and sibling 1968 SQFT; existing parent-residual split suite |
| Preserve child reference during routing; rename through PO Split | Browser checks read-only reference and unchanged stored reference after save; unit and integration reject native reference editor for a child |
| Adopt an existing allocation to the request's exact SO on first attachment | Integration rejects another SO's allocation, accepts the exact SO, preserves all allocation/order rows, and rejects later detachment while allocated |

Initial behavioral RED: all six initial tests failed before implementation
(missing selector, rejected child routing, no attachment identity, invalid targets
accepted, missing product description and blocked manual-PO preview). The
old-worker test also failed before its database trigger: parent ID remained in
the handoff. The browser reference check exposed generic routing clearing the
child reference; preserving that identity made the check pass.
The compatible-allocation follow-up reproduced `SPECIAL_PO_SPLIT_LOCKED` for a
valid same-SO allocation before adjusting the guard; the corrected case passes.

Final affected run: 49 tests, 47 passed and two unchanged baseline failures.
Both failures were reproduced against the captured, unchanged live source and
matched by test name and error before being accepted as baseline:

- `created PO routing saves the real Note and exact schedule revision, preserving failed drafts`:
  the old test expects `Stock readiness option[value="true"]`, which the live UI
  no longer renders (`Expected: "Ready for Arrangement"`, element not found).
- `RESTlet prints SO and PO using native transaction forms with record-type verification`:
  the current RESTlet fails under the old mock with `The RESTlet request failed.
  Review NetSuite script logs with reference mbbs-REFERENCE.`

All 12 changed JavaScript files passed syntax checks. Routing UI TypeScript and
the scoped ESLint run passed. Five plausible mutations were each killed:
remove manual-PO preview allowance, route a child to its source, spread request
remarks to siblings, accept another source's child, and count source planning as
child planning. Runtime hashes were restored after mutation. Reversed focused
suite order passed all 11 tests. Seed 3429 was used for both property suites.

Initial measured changed-line coverage: 134/143 lines (93.7%). The final
compatible-allocation follow-up measured 5/5 changed lines. Nine lines in the large
request repository remain uncovered: inactive/skipped guards, legacy handoff
hydration/direct allocation paths, handoff listing SQL and closure guards.
Node coverage does not measure the 17 controller lines executed in Chromium or
the two Dispatch display lines; the latter were inspected only. Full-repository
tests, global types and exhaustive branch coverage were not run. These are
explicit limits, not a claim of complete coverage. Existing ESLint complexity
rules apply where configured; the legacy large repository is not globally linted.

Toolchain: Node 20.20.2, TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0,
fast-check 4.9.0 and Playwright 1.62.1. No dependency set changed, so package
audit/license installation checks were unnecessary. The scoped diff adds no
credentials or remote write capability for child routing.

Reproduce with `sudo -n bash docker/run-special-child-po-checks.sh final`.
The retention wrapper creates a unique artifact directory, registers teardown
before startup and uses the bounded standard Compose services under
`mbbs-tests.slice`. Each run removes containers, database storage, network,
coverage, browser artifacts, logs and temporary source. Both `docker ps` and
`docker ps -a` showed only the four production containers after teardown.

Deployment audit: `server/deployments/special-child-po-20261028/` contains
`tested-inputs.json`, `final-result.json`, the scoped patch, manifest and rollback
configuration. Deployed image:
`sha256:d52a64c9f917ddb1a40c2d81da81f2164569e72d24ea54e53618980d8ff66f14`.
Migration `321_special_child_po.sql` is additive; original view definitions were
saved before applying it. App configuration and all three dependent container
identities were preserved. Health passed locally and through the public host,
served assets matched the tested hashes, and the new anonymous API returned 401.
The host's layer limit required packaging the same 15 verified files into a single
image layer. Rollback image: `mbbs-operator-app:rollback-special-child-po-20261028`.

Live verification read request 379 without changing its revision or selecting a
child. NetSuite returned the native POB03429 PDF (`Purchase-Order_POB03429.pdf`,
37,027 bytes, valid `%PDF-` header). L3-18Plt now projects Richmond 80mm (6x13),
Grey Mix, 1771.2 SQFT and PALLET 18 EACH. L4 projects 1968 SQFT and PALLET 20 EACH.
Its existing allocations belong to SOB123598, the request's own SO; the final
guard permits that initial attachment while retaining the existing allocations.
The persistent empty API value was not reproduced; the product description and
fractional display were corrected and verified on the real schedule output.

# Sales-unit pickup and Operator allocation fix — 2026-10-23

Deployed at 20:14 UTC. The [specification](dispatch-sales-pickup-authority-spec.md)
records the user's authorization and subsequent partial PO/TO clarification.
Tier 3; spec approval: not obtained (autonomous run). No new dependencies,
migrations, credentials, commits, or inventory posting ownership changes.

## Cause and resulting behavior

GOB-122647-122650-122835-123218 had complete PO sales allocations to Techo,
but its cached physical allocation fields were zero. Independent subtraction
of pallets therefore invented a second pickup at 3445. The Driver's hydrated
data showed no cargo there. Rebuilding the catalog could recreate the misleading
requirement until the calculation itself was corrected.

Dispatch validation, hover, and Driver pickup projections now use sales units
as the allocation balance. Packing describes that same share of cargo. The
Operator repository already computed partial sales residuals correctly; fully
linked converted lines could still revive packing as a sales requirement.
The Operator server and browser now retain the projected zero, and the line
is marked as requiring no yard load. Legacy physical-only behavior remains.

For a 200-unit line, 100 PO units leave 100 Operator units. A 100-unit direct
TO has the same effect; 60 PO plus 40 direct TO also leaves 100. A replenishment
TO does not reduce outbound yard work. Loading 25 of the residual 100 leaves
75. Cancelled PO allocations are excluded.

## Evidence and reproduction

Run from the repository root:

```sh
bash docker/run-dispatch-sales-pickup-checks.sh all
```

The runner captures the live runtime and overlays only the release inputs.
The shared MBT HTML release input contains only the Dispatch script version
change; concurrent workspace edits are excluded. Exact runtime hashes,
toolchain versions, randomized ordering, failure names, and mutation outcomes
are in [the final report](dispatch-sales-pickup-evidence.json).

| Check | Final fresh run |
| --- | --- |
| Baseline regression | 25 files; 167 tests; 156 passed, 11 failed |
| Candidate regression and acceptance | 27 files; 176 tests; 171 passed, 5 failed |
| New failures against baseline | 0 |
| Focused repeat | 4 files; 19/19 passed |
| Changed executable lines | 63/63 covered by V8 |
| Deliberate faults | 9/9 detected |
| Numeric properties alone | Detected all 8 quantity faults |
| Static checks | 0 new type diagnostics, 0 changed-line lint findings, 6 syntax checks passed, 0 diff secret findings |

The repair guard fault is caught by the database integration test, not by
numeric properties. The broad suite is not wholly green. Its five remaining
failures also occur on the live-code baseline: RP-08 visit-scoped display,
RP-05 active travel, and the three legacy Dispatch harnesses. Existing missing
helper errors include `isMbtPlanningLoad` and `retainedDirectPickupManifest`.
The complete unrelated repository suite was not run; the comparison covers
the affected Dispatch/Driver/Operator suites. Existing type diagnostics remain.

Acceptance mapping:

- Sales-authority, zero, partial, legacy, conservation, and view agreement:
  `dispatch/unit/sales-pickup-authority.test.js`; two seeded properties with
  150 generated inputs each. Existing linked-stop tests exercise repeated
  item lines, same-yard TOs, separate vendors, groups, and CO manifests.
- The exact 200/100 examples, mixed links, replenishment, loaded balance, and
  real rendered residual text: `mbt/integration/operator-linked-quantity-repository.red.test.js`.
- Full-link converted-line behavior and retained legacy compatibility:
  `mbt/unit/operator-delivery-reference.test.js`.
- Exact repair scope, fleet lock, revision refusal, idempotence, recorded-cargo
  refusal, preview rollback, and audit-failure atomicity:
  `dispatch/integration/gob122647-empty-pickup.test.js`.
- Unchanged posting owners and conserved completion snapshots: existing
  Operator linked-fulfillment unit/property suites.
- Asset versions, configuration, other services, SOR preservation, and real
  application behavior: release hash checks and live verification below.

RED was observed before the quantity changes. The Operator property shrank
to `[1,0,1]`: one fully allocated sales unit and one stale pallet incorrectly
left yard work. Old assertions that required the false pickup or converted
yard work were explicitly revised in the append-only spec. Test scaffolding
initially omitted the cargo oracle and quantity helper dependencies; these were
corrected before the final run. An earlier wrapper run ended with a shell EOF
after the wrapper was edited during execution; the final unchanged wrapper
completed successfully. No failed run's results are used in the final totals.

## Live correction and deployment

The authorized repair removed only the empty 3445 stop, advanced plan 367
from revision 104 to 105, and retained its continue record as superseded with
original timestamps and payload. Audit ID 31129 records the correction.
Techo pickup and customer delivery records were preserved.

Release commands:

```sh
python3 server/tools/dispatch-sales-pickup-release.py prepare
python3 server/tools/dispatch-sales-pickup-release.py deploy
python3 server/tools/dispatch-sales-pickup-release.py check-routes
```

The image is `mbbs-operator-app:dispatch-sales-pickup-20261023`, with its prior
image retained under the matching `-rollback` tag. Deployment verified all
1,483 runtime files, unchanged configuration and dependency containers, and
healthy HTTP responses. Served Dispatch and Operator JavaScript hashes match
the tested source.

Live production data and the deployed browser functions confirmed:

- Required pickup: Techo only; 3445 hover: 0 items; Techo hover: 12 items.
- Driver delivery record 7300 remains in progress with the same cursor and
  no route attention; removed record 7294 retains its history.
- All four member orders show zero Operator yard sales quantity for their
  12 linked lines.
- SOR00248-Return remains item 10750 with an empty review reason.

Operational records are under
`server/deployments/gob122647-sales-pickup-20261023/`, including the repair,
release manifest, live route verification, and HTTP/cleanup verification.
This is actual repository/browser-function execution with live records; a
physical installed-device upgrade and a full browser interaction run were
not performed.

The disposable runner used the bounded shared test slice and removed its
containers, volumes, networks, and raw artifacts. Final `docker ps` and
`docker ps -a` both showed only the four production containers; health passed.

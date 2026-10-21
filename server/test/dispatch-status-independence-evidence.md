# SOM06964 Dispatch release and persistent local unit correction

SOM06964 is available for Dispatch planning and PO linking. The live response has no Dispatch completed flag, the actual Link PO preview is allowed, and the rendered selected actions contain Link PO. The user confirmed the misleading completed label disappeared after the updated screen loaded.

The exact StoneArch line, NetSuite line 5137294 / local row 544895, is **28 SQFT and 7 pieces**. Only its sales unit and corresponding loaded unit changed from PC to SQFT. Other lines were compared before/after and remained unchanged. NetSuite was not written. An active per-line source sync hold preserves this local correction across ordinary upserts and missing-line deactivation; ordinary local packing/loading fields remain writable. The other StoneArch line remains 60 SQFT / one pallet. Audit **29145**, actor **testAdmin**.

Spec approval: not obtained (autonomous run). Tier 3, with user-authorized priority release before broader checks. The user explicitly superseded the old Billed-only/Operator-load restrictions for Dispatch planning and linking, and explicitly authorized excluding the corrected line from sync. The append-only specification and the earlier contract test copies are retained in `test/dispatch-status-independence-spec.md` and `tools/som06964-release-20261015/prior-contract-tests/`.

## Evidence

| Layer | Final result |
| --- | --- |
| Relevant functional suite | 82/82 passed, zero skipped or failed |
| Repeated suite | 82/82 passed; actual reverse file order, pristine isolated database per file |
| Static types | 10366 baseline diagnostics, 10347 final; zero new diagnostics |
| Lint | Zero new runtime messages; zero messages in new tests |
| Changed JavaScript coverage | 17/17 mapped changed lines reported covered by c8 |
| Mutation tests | 10/10 deliberate faults detected |
| Property-only mutation checks | 4/10 detected; example/integration tests cover the remaining domains |
| Database rollback | Empty hold schema rollback/reapply passed; rollback refuses to discard hold evidence |
| Adversarial checks | Wrong hold identity, inclusion of Operator fields in a source snapshot, true Driver completion/activity, mixed selections, allocated split and stale quantity/conversion guards |
| Production execution | Live canonical/catalog response, backend PO-link preview, actual selected-action renderer and enabled hold trigger verified |
| Host cleanup | Only four production containers remain; no task containers, test volumes or test networks |

Behavior mapping:

- Missing Link PO for Pending Billing/loaded source data: `dispatch-status-independence.test.js` frontend and integration suites. A real PO allocation and unlink execute through the command service without clearing Operator quantities.
- False Dispatch completed label: current authority replaces cached accounting completion; actual Driver delivery remains restricted. Existing SO planning/catalog/group tests were revised explicitly to the new display contract.
- Split allocation blocker and unsplit conservation: all 14 existing `sales-split-allocation-unsplit.test.js` cases passed, including the fleet-lock race and legacy descriptive-piece restoration. The prior general blocker/unsplit release remains intact.
- Persistent 28 SQFT correction: all eight `sales-line-sync-hold.test.js` tests passed, including a real sync upsert, missing-line deactivation, unaffected sibling sync, ordinary local packing, explicit release, malformed snapshots, properties and rollback rehearsal.

Observed failures and resolutions:

1. Original runtime failed four of six focused tests: Pending Billing/loaded status hid Link PO, Operator quantities blocked the command, and accounting status was projected as Dispatch completion. Two existing safeguards already passed and were then challenged by mutation.
2. The first full run caught a projection merge restoring a packing-only Reconcile Review display. The implementation was corrected with the original assertion retained.
3. Hold tests initially compared PostgreSQL numeric strings to numbers. Assertions were normalized at the database boundary, then RED reproduced the two actual sync-overwrite failures before the trigger was implemented.
4. Static checking caught one missing frontend parameter annotation; it was fixed.
5. Repeating an HTTP fixture against the same disposable database encountered its prior edit lease. The runner now recreates only the strictly validated `mbt_test` database from an isolated pristine template before each reverse-order file. Assertions were not weakened, and all templates are dropped before Compose teardown.

Scope and limits: this is the affected Dispatch/sync suite, not the entire repository's unrelated MBT suite. Existing source lifecycle/identity, supply-allocation, plan lease/revision, Driver/offline evidence and structural data-integrity safeguards remain. This change does not reset Operator records or rewrite NetSuite fulfillment. Coverage of extracted frontend functions uses retained V8 offsets; SQL behavior is verified with database tests and mutations, not claimed as JavaScript line coverage. No new packages, lockfile changes, external writes or public endpoint were introduced. Dependency/license audit was therefore not rerun. No separate long-duration load test was run; the existing fleet-lock race and atomic operational transaction checks were retained.

## Reproduction and release identity

From `/home/ubuntu/apps/operatorApp`: `python3 server/tools/som06964-release-20261015/run.py final`. This runs the scoped tests, types/lint, JavaScript and SQL mutants, reverse-order repetition, coverage mapping, diff credential-pattern review, and mandatory resource teardown. The captured candidate and pinned test image/tooling mounts are retained; no disposable databases are retained.

Node/tool versions: `{"c8": "12.0.0", "eslint": "10.8.0", "fast-check": "4.9.0", "node": "v20.20.2", "playwright": "1.62.1", "typescript": "7.0.2"}`.

Final image: `sha256:75de2e1e03e5eccaac8110710d5f509f6b4bac7207de33c1325bf81ab7f3a465`. Release input hash: `ce6a7433de9d28aaaf33dcdaac1496c2db660361b28986e2c650946edec2ae1a`. Exact source/test hashes are in `test-artifacts/som06964-release-20261015/summary.json`. Baselines, RED/GREEN logs, final coverage, mutations, cleanup and operational audit snapshots are in that same artifact directory. The production overlay/rollback manifest is in `deployments/som06964-release-v2-20261015/`.

The hold is deliberately persistent. An intentional future release must set release metadata for this exact hold and record a new operational audit; application rollback keeps the hold and its audit evidence. Do not delete the hold table or audit records as test cleanup.

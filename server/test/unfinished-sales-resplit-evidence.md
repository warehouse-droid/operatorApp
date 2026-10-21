# Unfinished Sales Order resplit evidence

The existing action on an unfinished SO split opens the existing Split editor. Replacing S2 creates the next root-family references and retires only S2. Completed S1 remains retained. No additional button, database migration or dependency was introduced.

Spec approval: not obtained (autonomous run). Spec: `test/unfinished-sales-resplit-spec.md`.

| Layer | Final result |
| --- | --- |
| Focused acceptance, adversarial, HTTP, browser and real PostgreSQL lock tests | 40/40 passed |
| Reordered focused files | 40/40 passed |
| Relevant regression comparison | 57 checks; 6 existing failures; zero new failures |
| Changed executable lines | 244/244 covered |
| Types | 23705 baseline, 23584 current, zero new diagnostics |
| Runtime and new test lint | zero new diagnostics |
| Manual non-equivalent mutants | 6/6 killed |
| Properties alone | 4 relevant mutants killed |
| Disposable test cleanup | all test containers, databases, project networks and volumes removed; both Docker listings checked; live application healthy |

Acceptance mapping: root S3-S5 references, quantities, conversions and hostile allocations are covered by the unit examples and deterministic fast-check property; real replacement/history/link preservation, numbering, stale native/global quantities, exact retry, rollback and operator/Driver lock races are covered by `unfinished-sales-resplit.test.js`; private role/edit-lease requirements and expiry after lock waiting are covered by `unfinished-sales-resplit-http.test.js`; action count, actual quantity editor, saved completed route and failure retention are covered by the browser suite. Existing first-level splitting, packing splitting restrictions, completed-prefix handling, address isolation, cross-date conflicts, registered splits and Control reopen are included in the regression comparison.

Known baseline failures: five hover-unit-fixture tests fail identically on baseline and candidate because their VM fixture omits `findStop`; the real-browser hover/split regression passes. Separately, `unmaterialized splits can save, replace, clear, and pin the parent address` fails identically on captured live and candidate code with `DISPATCH_ADDRESS_REQUIRED` when its fixture attempts a blank address. No assertion was weakened or skipped.

Corrections during verification: the initial browser fixture wrongly omitted its completed S1 from the expected save and compared unnormalized route metadata; it now requires S1 and exact preservation of the normalized JSON wire payload. PostgreSQL returns exact numeric text `109`, so the rollback expectation uses that representation. A numbering mutant initially survived properties despite being killed by examples; the strengthened property requires exact next references and unchanged native S1 records. The lease-expiry race was observed failing before its server fix. Final checks were rerun after the last source and test edit.

Reproduce all verification: `sudo -n python3 tools/unfinished-split-20261012/run.py final`. Generate this report: `python3 tools/unfinished-split-20261012/evidence.py`. Source hash: `32fe86aaa0ff66ba6607d9743ea6f6681f585a88613f53b1aa73d0d9fe5ceb82`. Runtime/test/support hashes are in `summary.json`; tooling hashes and Node version are in `tooling-manifest.json`.

Limits: the full repository suite and unrelated external NetSuite integration suites were not run; the nine relevant regression files were compared to the captured live baseline. No external NetSuite write or actual customer order split was used for verification. Dependency audits were not rerun because dependencies did not change. Tests demonstrate the stated constraints, not an exhaustive proof. Production release uses only the verified overlays on the captured live image and retains rollback artifacts.

Production release: deployed at 2026-10-12T07:07:48.946784+00:00; only the application container changed, with configuration preserved and no migration. The first deployment probe used `/dispatch` (the menu) instead of `/dispatch/planning` (the planner), so automatic rollback restored the previous image. The probe was corrected without changing runtime or acceptance-test code. Normal dispatch-cache refresh changed derived-row timestamps; live verification checks S1 cargo/group membership against its preserved historical assignment and checks full immutable Driver record/photo and assignment hashes. Both completion records and all four photo references remain retained. S2 remains open and unchanged. A read-only production preview resolves S3/S4/S5; no actual customer split was performed.

Deployment details and runtime hashes: `test-artifacts/unfinished-split-20261012/deployment-result.json`. Rollback/code overlays: `deployments/unfinished-split-20261012`.

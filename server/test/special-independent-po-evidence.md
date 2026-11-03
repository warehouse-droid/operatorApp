# Independent Special Request PO evidence — 2026-10-29

Spec: [special-independent-po-spec.md](special-independent-po-spec.md).
Spec approval: not obtained (autonomous run). Tier 3: financial order creation.
The user clarified that “UOM” refers to the SCM screen, not a separate sales
units field. No new dependencies or commits were introduced.

## Result and release status

Implementation and isolated candidate validation passed. Production deployment
completed at **2026-10-29 14:44 UTC**, following the user's explicit `deploy`
instruction. Migration 322 and the verified application release were applied.
Authorization is recorded in the release's `approval.json`.

The candidate contains only this task's changes over the captured live app.
The existing live SO packing behavior is preserved; PO packing is added
separately. No production SO/PO was created or edited. Live read-only NetSuite
lookups returned PC, LNFT, TON, SQFT, BDL, EACH, RL and YARD for item 2055, and
EACH/PC for PALLET item 1784.

Post-deployment verification passed: local and public health returned 200, all
12 deployed file hashes matched the candidate, public asset hashes matched,
anonymous UOM access returned 401, migration 322 was present, and application
configuration plus the database/worker/Ollama containers were preserved.

Candidate source SHA-256:
`179f5270a7d96c229dbddb485f063d7789bfb2bb1d5cd42186d38846538e93b2`

Built image:
`sha256:44a4c777e5dd44fb1f5251257708c285094789fdd8179d96094ed5648dd86a98`

Base image:
`sha256:6efe15f3279dd9b1e08174d8080cc0dd040e10820185baf3e4a2bac3a4361474`

Per-file hashes, candidate, scoped patch, validation result and rollback image
are recorded under `server/deployments/special-independent-po-20261029`.
These are deployment/operational records, not disposable test artifacts.

## Reproduce the checks

From the repository root:

```sh
bash docker/run-special-independent-po-tests.sh
```

For the prepared live-based candidate:

```sh
python3 server/tools/special-independent-po-release.py validate
```

The runner executes `tools/special-independent-po-gauntlet.mjs`, including the
persisted mutation and legacy regression scripts. It registers teardown before
launching containers, uses the standard bounded Compose configuration and
`mbbs-tests.slice`, and removes its artifact directory after teardown.

Final candidate run: Node 20.20.2, TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0,
fast-check 4.9.0 and Playwright 1.62.1. Versions are also in `verified.json`.

## Acceptance mapping

| Behavior | Executable evidence |
| --- | --- |
| Different PO descriptions, quantities, UOM and packing preserve SO/request content | `integration/special-independent-po.test.js`: database snapshot and real repository creation tests; appended service regression forbids SO synchronization/native discovery |
| NetSuite-backed UOM identity, no quantity conversion, unitless fees | `unit/special-independent-po.test.js`: exact IDs/aliases, invalid IDs/catalogs, inactive/sales-only items and no-unit behavior |
| Authenticated item-specific dropdown endpoint | `integration/special-independent-po-http.test.js`: real app HTTP endpoint with boundary NetSuite fixture; SCM 200, Sales 403, anonymous 401, invalid ID 400 and no-store |
| Add/remove PO-only items, fee totals, independent packing, preserved failed-submit edits | `integration/special-independent-po-browser.test.js`: actual scripts in Chromium at 1440px and 390px, no horizontal overflow, submitted values and native UOM ID checked |
| Atomic validation, approval/revision fences, duplicate prevention | `integration/special-independent-po.test.js`: rejected invalid inputs leave no partial changes; successful creation and lost-response retry issue one remote POST |
| Preserve current dispatch behavior and existing manual/native paths | Integration assertion keeps application-created PO custom-linkage false; manual-link, native-workflow, local-adjustment and operation regression suites |
| Migration compatibility and retained fee rows | Integration migration reapplication, rollback with no added items and forward preservation of existing extra rows |

Paths in the table are relative to `server/test/mbt`.

## Final checks

| Layer | Result |
| --- | --- |
| Feature and related unit/database/HTTP suites | **115 passed, 0 failed, 0 skipped** |
| Desktop/mobile browser flows | **2 passed, 0 failed, 0 skipped** |
| TypeScript `checkJs` on three new modules | Passed |
| Focused ESLint, complexity <=20 and nesting <=4 | Passed, zero warnings |
| JavaScript syntax checks on 10 affected modules | Passed |
| New purchase review module coverage | **51/51 statements**, 100% lines/functions/branches |
| New purchase UOM module coverage | **80/80 statements**, 100% lines/functions, 98% branches |
| PO/SO payload builder coverage | 100% lines/functions; 90.9% branches |
| Manual mutations | **4/4 killed**: forged unit identity, sales-only item eligibility, missing PO packing, new native SO discovery |
| Property layer | 100 generated packing/quantity cases, seed 20261029; packing mutant also killed by the property alone |
| Reversed unit file order | **74 passed**, no failures/skips |
| Existing Special Request command | **76 tests, 74 passed, same 2 baseline failures; zero new failures** |
| Host budget/cleanup policy | 6 configuration checks passed; both `docker ps` and `docker ps -a` showed only the four production containers after cleanup; production health passed |

The two pre-existing failures were compared with the captured pre-task source:

- `multi-line case transitions atomically from Sales to SCM and back to an exact SO draft`
- `Sales and SCM Special tabs are real feature-gated interfaces`

They are not skipped or changed. The regression runner fails on any additional
failure. The first is an existing customer-confirmation state expectation; the
second is a source-pattern expectation in the Sales UI.

## Limits and corrections during verification

- Early RED runs reproduced the SO description overwrite, missing extra-item
  validation, missing PO packing, and the free-text UOM control. Later endpoint
  and operation-fence tests were added as regression coverage rather than all
  being individually run against the old implementation.
- Validation caught an overly broad custom-link flag that would change dispatch
  routes; the flag is now retained only for its existing manual-link behavior.
- Initial TypeScript errors were corrected with explicit boundary/DOM types.
  A candidate-specific mutation selector was corrected after the live packing
  implementation differed from the workspace. Assertions were not weakened.
- The global c8 gate targets unrelated MBT code and is not used for this suite.
  The new backend modules have an explicit 100% statement gate. Legacy repository
  and service modules are reported (47.47% and 92.61% line coverage), but complete
  changed-line coverage across the monolithic modules and browser UI is not
  claimed or gated. Functional browser checks exercise the requested editor flow.
- No full application-wide suite, load benchmark, live NetSuite transaction write
  or retroactive detachment of already issued native POs was performed. Tests mock
  external NetSuite transport, not the repository or payload logic under test.
- Dependency audit was not rerun because the dependency set did not change.
  The capability changes are read-only item/UOM metadata requests and the existing
  PO creation path; there is no new credential or external messaging mechanism.
- Test databases, containers, networks, logs, coverage and screenshots were removed
  by the runner. Temporary pre-task source copies are removed at task completion.

## Follow-up 2026-11-03 — SO lines no longer gate PO creation (SPREQ-000178)

Cause: SO SOB123911's PALLET line became inactive in NetSuite while the case SO
snapshot and reviewed PO kept PALLET; PO claim/submission reconciled the SO and
raised `SPECIAL_ORDER_COVERAGE_MISMATCH`. Both SO reconciliations were removed.

Release `server/deployments/special-po-so-independent-20261103` (tool
`tools/special-po-so-independent-release.py`), deployed 15:24:42 UTC with the
user's `deploy` instruction; app-only swap, ~6.6 s unavailable. Validation ran 154
Special unit/integration files on captured live vs candidate: live 1054 passed /
13 failed (7 new regression tests reproduce the block), candidate 1061 passed /
6 failed — the same 6 pre-existing failures as live (vendor-confirmation stage
projections and one test-skip ETA case), none introduced.

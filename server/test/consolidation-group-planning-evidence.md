# Consolidation Load: grouped-order planning lookup

Status: [deployed and verified](operator-improvements-deployment.md) on 2026-09-16. The final full suite has zero new failures.

## Result

Sep-16 (2026), yard 3445 / location 1, Dispatch plan 328 contained four packed groups whose original orders had null dispatch fields. Expanding the groups discarded the only available planning date, so Consolidation Load treated those children as unassigned.

The repository now resolves a missing date from active group membership of the same order family, using one batched read. Existing child dates retain precedence. Canceled plans and conflicting dates do not supply a fallback. The current plan snapshot still determines the actual truck/load. List, child-ID preview and submission revalidation share this lookup.

The read-only production replay returned two rows before the fix and ten original-order rows with the candidate. All six Dispatch cards are represented:

| Dispatch card | Original orders | Truck / load |
| --- | --- | --- |
| GOA-8600-8648 | SOA08600, SOA08648 | CC46868 / Load 1 |
| GOB-120124-120358 | SOB120124, SOB120358 | CC46868 / Load 1 |
| GOB-120251-120252 | SOB120251, SOB120252 | BC71838 / Load 5 |
| GOB-120300-120301 | SOB120300, SOB120301 | BC71838 / Load 3 |
| SOB120385 | SOB120385 | BL27129 / Load 1 |
| RP-UNI-GORMLEY-3445-0915-1 | RP-UNI-GORMLEY-3445-0915-1 | BC71838 / Load 1 |

All three truck/load selections containing the missing children also produced valid snapshots. This used `REPEATABLE READ, READ ONLY`; no preview records, loads, photos or NetSuite transactions were created. The candidate was imported in memory. Its undeployed photo-queue write boundary was replaced with a throwing guard because production does not yet contain that pending module.

## Specification and behavioral evidence

[Spec](consolidation-group-planning-spec.md): autonomous implementation run; human spec approval was not obtained. Tier 3 because the lookup determines loading eligibility. No checkpoint commits. Deployment was separately authorized afterward. The prior IF/IR timing, photo queue and receiving work remains intact.

The four new tests in `test/mbt/integration/consolidation-group-planning.test.js` map to the acceptance criteria:

1. Group-only packed children with null dispatch fields appear, retain their quantities and leave source projections unchanged.
2. Group and child selections produce equal previews; submission reloads children successfully; replay records each order once without SO NetSuite work.
3. Missing, return-only, duplicate and changed loads are rejected; actual child yard checks remain enforced.
4. Eighty generated states exercise active membership, order family, existing child dates, canceled plans and conflicting group dates (seed 16092027).

Existing tests additionally cover overlapping selections, races between submissions/batches, revoked yard access, invalid photo ownership, quantity drift, rollback/retry and mixed TO/SO posting boundaries.

All four new tests failed behaviorally before the implementation. Before that RED run, the fixture's required membership position and a numeric-format assumption were corrected. No behavioral assertions were weakened. Static checking later caught an untyped query row; the explicit result type fixed it. The interrupted full run from before that correction was discarded.

## Final validation

| Layer | Result |
| --- | --- |
| Full regression suite | 2,504 tests: 2,501 passed, 2 known baseline failures, 1 existing skip; 492 files; zero new failures |
| Focused consolidation tests | 36 passed |
| Deterministic shuffled file order | 36 passed across four files |
| Changed executable line coverage | 21/21 |
| V8 branch entries starting on changed lines | 14/14 exercised |
| Manual mutation | 4/4 killed; all 4 also killed by the property test alone; restored source passed |
| Type baseline comparison | Same 233 existing errors; zero new errors |
| Lint and complexity | Zero warnings/errors; complexity budget 12 |
| Browser regression | 5 passed |
| Live read-only replay | 2 rows before; 10 after; three valid load snapshots |
| Dependencies and capability review | No package/lockfile changes; one additional parameterized DB read; no new runtime write boundary |
| Secret-pattern scan | No matches in additions |

The four mutation bugs were: skipping the group date, accepting inactive membership, accepting another order family and choosing one of conflicting dates. Mutants ran in temporary copies; the workspace implementation was never mutated.

The two known full-suite baseline failures are:

- `P3.12: browser specs share one worker-owned database-pool lifecycle`
- `quality non-regression: the gauntlet builds and validates the omit-dev runtime`

Dependency vulnerability/license scans were not rerun because no dependencies changed. No live posting/load test was performed: isolated tests exercise mutations, while production verification is read-only. Randomized-order checking covers the four affected test files; the complete suite uses its standard isolated order. No new migration or UI assets require separate rollout work for this fix.

## Reproduce

From `server/`:

```bash
sudo -n bash tools/consolidation-group-planning-gauntlet.sh
```

This rebuilds the pre-task baseline from the reversible manifest, runs every validation layer, checks source hashes and scans additions for common secret patterns. It uses disposable PostgreSQL databases on internal Docker networks. The final live comparison requires access to the existing production container and the Sep-16 operational state; subsequent legitimate loading may change the expected rows.

Tool versions: Node 20.20.2, TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0, fast-check 4.9.0, Playwright 1.62.1. Test image: `mbbs-retired-confirm-test:20260914`; browser image: `mbbs-mbt-p1-test-e2e:latest`.

Source manifest: [consolidation-group-planning-changes.json](consolidation-group-planning-changes.json). Aggregate hash of changed-file paths and SHA-256 hashes: `1e2c36df3a0be438dfe4b0b16253d5ba2b01ab161aa0d072d9af2e834bccedd1`.

Artifacts are under `test-artifacts/consolidation-group-planning/`: RED, focused/shuffled/full logs, exact type/lint comparisons, coverage JSON, mutation counterexamples, browser results, live replay and the final `summary.json`.

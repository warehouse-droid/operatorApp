# Sales Truck Monitor map access

Spec: [sales-monitor-map-spec.md](sales-monitor-map-spec.md). Tier 3 because the correction touches an authorization gate. Spec approval was not obtained (autonomous run). The scope is a single new condition in `requireDispatchAccess`; the page, map provider, budgets and Dispatch mutation permissions are unchanged.

The failure was reproduced using a real Sales login against the app: truck data/config could load, but POST `/api/dispatch/maps/browser-session` returned 403. The monitor collapsed that failure into its generic usage-policy message. The pre-fix HTTP/property/browser run failed all four tests. Live read-only inspection found normal mode, a configured browser key, 631 admitted units in the rolling window and 290 dynamic-map units; the existing policy allowed another map load.

## Acceptance evidence

| Spec behavior | Evidence |
| --- | --- |
| Signed-in Sales can obtain map admission | Real HTTP test checks 200, browser-only key, private no-store response and one metered ledger admission |
| Sales Truck Monitor constructs a map and truck marker | Playwright uses the real app, login and admission endpoint; only Google script and vehicle-feed boundaries are substituted |
| Reloading truck positions reuses the map | Browser refresh asserts one map construction and one admission with refreshed markers |
| Other writes/roles stay restricted | 40-case property plus exact method/role/anonymous matrix, malformed path variants, existing Sales planning read/write test |
| Usage policy stays effective | Real endpoint tests disabled/conserve/missing-key responses; existing Maps policy/gateway/budget suites |
| No new Dispatch mutation authority | Four targeted mutants, each rerun against the full feature file and property alone |

Four focused tests pass. The changed line and its four instrumented branches are covered. Strict types are checked on the exact authorization function extracted from the legacy server monolith with typed request/response/helper boundaries; this is not whole-server type coverage. Syntax and lint checks pass. Four mutants produce eight expected failing runs: denied Sales maps, all POST paths admitted, all methods admitted, and all staff admitted. The property checks both allowed and denied counterparts.

The Maps neighbor suite has 30 passes and one pre-existing source-contract failure, reproduced against the saved pre-fix source. It expects a route-refresh call directly inside `confirmCurrentPlanAtomic`, while the current wrapper delegates to `performDispatchPlanConfirmation`. The assertion was preserved. Shuffled scope has 15 passes and that same known failure. No new failure is accepted by either comparison.

## Reproduction and limits

Run `python3 server/tools/sales-monitor-map-gauntlet.py` for the focused layers and full regression comparison; `--focused` and `--full-only` run those portions separately. Artifacts are in `test-artifacts/sales-monitor-map/`. Toolchain: Node 20.20.2, Playwright 1.62.1, fast-check 4.9.0, c8 12.0.0, ESLint 10.8.0, TypeScript 7.0.2. No new dependencies or commits. No schema changes or live business writes; no billable Google call was made for verification. Supply-chain audit and migration/rollback rehearsal are not applicable to the unchanged dependencies and schema. The release retains the prior image for rollback.

Google's external tiles are substituted in the isolated browser test, so that test verifies the authenticated loading path and map/marker construction, not Google's external service availability. Real usage restrictions remain effective if a limit is reached later. Public Sales access remains disabled as configured.

Verification corrections are retained honestly: the first ledger assertion incorrectly expected a raw actor ID and was corrected to the existing SHA-256 identifier (spec clarification, no ledger change); the first coverage command inherited whole-server percentage thresholds and was replaced with explicit changed-line/branch checks; the first full run used an unmigrated disposable database and was discarded and rerun after migration. Their logs are preserved. Test formatting was corrected without changing behavioral assertions.

The final full regression run completed 567 files and reported 3,013 tests, 2,988 passes, and the same 24 known failure names across 21 files. It has zero new failures and zero resolved failures. Full results and the comparison are retained in `full.log` and `full-regression.json`; the existing suite is not globally green.

Verified source fingerprint after correcting the deployment probe: `80252795dbfcbfbca9bba368c6eb55d8582e24fa4b3a0a0bf195724541c0a067` (original tested application/tool state: `10099b9a3f50255cc824eed1926dd0b9429d256cc27dd005722aaea1e8b36bbe`). Only the read-only verification script changed between these states. The release image is `mbbs-operator-app:sales-monitor-map-20260922-v1` (`sha256:be07b5be1e921fe66d4131026ad5943c8a678a0d517590f163079b4c2ede680f`). It applies only the one-line fix over the current `aggregate-next-request-20260922-v5` image, preserving unrelated differences in the live server file. That exact candidate passed static checks and all four HTTP/property/browser tests; its Maps neighbor comparison retained only the recorded existing failure.

The initial cutover attempt stopped at the deployment preflight because one Dispatch edit session was active; no app replacement occurred in that attempt. The active-edit result is saved as `preflight-active-edit.json`. After the user reported that the editor exited, preflight confirmed zero active editors/postings/fulfillments.

The first restart automatically rolled back because the verification script incorrectly expected Express middleware to return its `next()` callback value. Dispatcher/Admin middleware correctly called `next()` without returning it. The corrected probe checks exactly one callback invocation for allowed requests and zero for denied requests, plus the 403 denial result. It passed all 12 cases against the exact candidate image in an isolated container and passed lint. Runtime application code/image did not change. Before retrying, the restored image, server hash, configuration and dependency containers were verified against the captured baseline. The original probe, rollback record and correction are retained in the deployment artifacts.

Successfully deployed and verified at **2026-09-22 19:06:10 UTC**. The deployed server hash matches the candidate, configuration and other services are unchanged, both internal/public health and Sales monitor pages return 200, anonymous map admission remains 401, and all 12 deployed authorization cases pass. Read-only policy evaluation allows map loading in normal mode. At verification, rolling total usage was 639 units and dynamic-map usage was **297/300** in the 30-day window; the existing automatic map-loading quota is near its limit. No quota was raised and no billable Google map admission was issued by the deployment probe.

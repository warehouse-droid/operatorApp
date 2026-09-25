# Recent construction leads

Deployed to `/field-sales/` at **2026-09-19 00:41 UTC**. The planner defaults to the last 12 months, offers 6/12/24 months and All ages, hides isolated minor/service work, and shows the qualifying City date and work. Milestone and permit-status selections choose the appropriate source and clear the conflicting stage filter. List, map, counts and bulk selection share the same predicates. Imports and saved jobsite/route history are retained.

The user approved the plan with “Implement the plan.” The append-only [specification](../test/field-sales/spec.md) records the date rules, exact work exclusions, compatibility and regression cases. This follow-up uses old-coder Tier 2; it adds no dependencies, migrations, configuration changes or production test records.

## Reproduce and identify

From the repository root, run `bash server/tools/field-sales-recent-test.sh`, then `python3 server/tools/field-sales-recent-evidence.py`. The runner uses an isolated PostgreSQL 18 database and the retained `field-sales-check-2941306` test image, with source mounted read-only and no production credentials or external network. To rebuild that tool image, use the existing `server/Dockerfile.test` target `test-e2e` and set `FIELD_SALES_TEST_IMAGE`.

Runtime SHA-256: `5a983481c4f74c775447c409a00ff55705014cc6f91af12d0fc9a8f6be51af68`. Per-file source, test/tool and artifact fingerprints are in `test-artifacts/field-sales/recent/evidence.json`. Recorded tools: Node 20.20.2, Playwright 1.62.1, c8 12.0.0, ESLint 10.8.0, fast-check 4.9.0, TypeScript 7.0.2.

## Acceptance and results

| Behavior | Evidence |
| --- | --- |
| Old permits stay old; inclusive Toronto calendar cutoff; invalid/missing dates | `recent.test.js` R1/R5; policy P1/P3 |
| One source must satisfy all constraints | R2/R4; SQL/JS parity property P3 |
| Exclude isolated service work; retain house/foundation/building drainage | R3; policy P3/P4 |
| Qualifying date labels and priority/date/readiness ordering | R4; policy P4; new Chromium scenario 1 |
| Milestone source switching and clearing conflicting status | R6; policy P2; Chromium scenario 2 |
| Shared map/list/count/paging/bulk rules, route persistence | R6; Chromium scenario 3; all seven existing map scenarios |
| Older details/import dates and manual records preserved | R5/R7; Chromium scenario 1; isolated release image |
| Existing offline visits/photos, routes and quote/PDF flows | Complete Field Sales suite and five existing browser scenarios |

- **80/80 Field Sales tests passed**, zero failures/skips. All 22 test files also passed in seeded randomized file order (`20260919`).
- **15/15 Chromium scenarios passed**: three new, seven map/ward and five original desktop/phone scenarios; zero uncaught browser errors.
- Lint passed without warnings. Strict types passed for the shared domain and the new policy/SQL-filter modules. Python compilation and shell syntax checks passed.
- Coverage for the repository and two new policy/filter modules: **309/309 lines, 41/41 functions, 387/409 branches (94.62%)**. Both new modules have full line coverage; their branches are 62/63 and 34/36. Browser rendering and service-worker branch coverage are not included in these percentages.
- **5/5 deliberate mutants were killed by the expected named tests**, independently exercising old-detail retention, calendar cutoff, milestone/source alignment, SQL application-date fallback and legacy date labelling. Mutation copies are temporary; the workspace is never mutated.
- The seeded SQL/JS parity property ran 40 generated arrays of up to 25 records, including hostile date strings, malformed calendar dates and mixed work categories. Date/work interpretation must agree in both directions.
- Runtime secret-pattern scan passed. No dependency audit was repeated because this five-file release changes no dependencies. New policy functions remain small; database operations evaluate compact matching sources before fetching full evidence for a page.

The original database RED failed six new regressions; unchanged detail retention passed and was later mutation-verified. The browser RED detected missing recency controls. Later policy tests were individually mutation-verified. A lint variable shadow and incorrectly escaped throwaway mutant were corrected without weakening assertions. Correlated source checks were replaced with materialized candidates/matches after the realistic dataset exposed avoidable latency.

The Google Maps SDK/session boundary is simulated in browser checks; application UI, authenticated HTTP, PostgreSQL, IndexedDB and persistence are real. No paid Maps or live NetSuite call was made. Broader unrelated repository suites were not repeated for this isolated read/filter update; their recorded baseline remains in [the original evidence](field-sales-evidence.md). Full UI branch coverage and account-specific NetSuite behavior are not claimed.

## Packaged and live verification

`tools/field-sales-recent-deploy.py` stages only five files over the image live at preparation, compares original source hashes, retains rollback, checks idle queues and configuration, and recreates only the app. `tools/field-sales-recent-release-check.sh` started the exact image on a disposable database and verified four entrypoints, six authenticated endpoints, anonymous denial, recency, complete-application search, map counts and access to older records. No runtime source override was used in that image check.

Image: `mbbs-operator-app:field-sales-recent-20260919-v3`, ID `sha256:7866a9ebfabe1b00e38e0a02ac2274cee2752f549c2a43af1523c343e742fc4e`. Rollback retains the preceding `sha256:3a275f774e87dc9f0f52614e8ed44e11efef6a71377d482719516d65af941aab` image.

All five runtime hashes matched. **12 public/local checks passed**, including health, three served assets, module entrypoint and anonymous API denial at both origins. Service configuration and worker/database/Ollama identities were preserved. No rollback was needed.

`tools/field-sales-recent-probe.py --deployed` executes the deployed repository inside an explicit read-only transaction against the imported City data. Final snapshot:

| Filter | Jobsites | Sequential count + list + map |
| --- | ---: | ---: |
| Recommended, last 12 months | 8,879 | 4,892 ms |
| Complete application milestone, last 12 months | 170 | 793 ms |
| 276 Prince Edward Dr S, All ages + minor/service work | 1 | 2,043 ms |

These are database probe timings and snapshot counts, not guarantees of end-user latency or future feed counts. The 2022 DRN source remained intact. Private deployment manifests, checks and rollback configuration are retained in `test-artifacts/field-sales/recent-deployment-20260919/` and must not be published.

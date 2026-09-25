# Child-location fulfillment verification

Scope: customer-pickup and delivery Sales Order fulfillment. Active child
locations inherit their parent yard's permissions and existing posting switches;
the inventory location on each fulfillment line remains unchanged.

The user approved implementation and explicitly authorized the production
SOB120598 test before deployment. The executable specification is
[child-location-fulfillment-spec.md](child-location-fulfillment-spec.md).
Verification followed the [old-coder skill](/home/ubuntu/.codex/skills/old-coder/SKILL.md),
Tier 3. No dependencies were added and no unrelated workspace changes were
included in the release. No git commit was made in the shared dirty workspace.

| Acceptance scenario | Evidence |
| --- | --- |
| Parent-yard pickup with child stock location | C1, C7–C9; H1, H2, H4, H5; SOB120598 read-only preflight |
| Active descendants, no foreign-yard grants | C1–C3, C7, C11; Q1; H2, H3; existing yard-access suite |
| Combined IF first; exact-location fallback | C4–C6; P1, P2; Q2, Q3 |
| No split on unrelated errors or uncertain responses | C5; P4–P6, P8, P12; Q3 |
| Durable identity and safe retries | D1–D7; P3, P4, P7–P9, P11, P12 |
| Complete only after every part verifies | P2, P3, P9, P10; existing posting services; browser result test |
| Shared delivery behavior and REST line identity | C8–C10; P10; existing delivery fulfillment suite |
| Refresh preserves whole source line set | NetSuite pickup fallback reads the complete source; existing sync and source-line regression suites |

Final candidate checks and source hashes are recorded in
`test-artifacts/child-locations/verified.json`; the deployment manifest identifies
every changed file and the exact image. The candidate layers only 28 changed or
added runtime files over `mbbs-operator-app:return-batch-ra-20260918-v5`.

- 31 focused test files, 212 tests passed, including real HTTP requests and
  isolated PostgreSQL concurrency, immutable identity and rollback checks.
- Reversed file order also passed. Full-suite comparison requires zero new
  failing test names against the captured production baseline.
- All 403 lines of the five new runtime modules executed; 201/236 branches
  executed. Existing-module coverage is reported separately. The initial broad
  c8 run hit the repository's 95% global threshold because it included unchanged
  legacy code; the release check instead enforces 100% lines for the new modules
  and records branch coverage. This does not claim full branch coverage or
  coverage of every changed line in the large existing modules.
- Eight manual defects were killed by example tests; five domain defects were
  independently killed by property tests; two access defects were killed by HTTP
  tests. Mutants ran on throwaway copies and the restored code passed.
- Type and lint results match the baseline: one existing lint error and 237
  existing type diagnostics, zero added diagnostics. Existing tool versions:
  Node 20.20.2, ESLint 10.8.0, TypeScript 7.0.2, fast-check 4.9.0, c8 12.0.0.
- Chromium verified font/colour settings, reset, scanner input, account settings,
  centered single-row toolbar, navigation and driver units. The new completion
  result renders both IF references and actual locations, with remote text escaped.
- The release patch and new runtime files passed the repository's secret scanner.

Failures found during development included missing child-yard access, missing
canonical driver REST lines, foreign inventory in consolidation, missing draft
recovery, and a nullable posted-ID database constraint. Each received a failing
test before its fix. NetSuite transport fixtures now answer the location-directory
read; existing authorization assertions remain in place. The query-scope
assertion now requires the exact authorized descendant set. A surviving mutation
exposed a missing assertion for deselected quantities; that assertion was added.

Reproduce the automated release checks with:

```sh
sudo -n bash server/tools/child-location-gauntlet.sh
```

The script accepts `CHILD_LOCATION_RELEASE_ROOT`, `CHILD_LOCATION_SOURCE_ROOT`
and `CHILD_LOCATION_BASELINE_ROOT` for a captured candidate and baseline. It uses
the existing test image and cached browser binaries, disposable databases and
internal Docker networks. It never calls live NetSuite. The separately gated
production tool is `tools/child-location-deploy.py`; its `live` command is limited
to SOB120598, retains an intent and one attempt before posting, recovers by a fixed
external ID, and verifies source, item, REST line, location, quantity and replay.

Known limits: SOB120598 contains only location 14, so its real test cannot establish
whether this NetSuite account accepts a mixed-location IF. Combined and split
behavior are covered by boundary-injected tests. Automatic splitting requires a
narrow, explicit native location validation response; unfamiliar account-script
errors remain visible for review. No other order is used for a production test.

Deployment and real transaction results will be appended after their checks pass.

## Final result — 2026-09-18

NetSuite production test passed at 2026-09-18T06:50:18.799Z: **IF154026** (internal ID 997397) for **SOB120598** / Sales Order 996102. The IF contains REST line 1, item 8497, **51.26 SQFT**, and actual inventory location **14 — 3445 : 3445 Special**. Source remaining quantity became zero. A second external-ID lookup verified the same IF without another POST. The real IF remains in NetSuite.

The final complete run covered 533 files and 2744 tests: 2721 passed, 22 failed, 1 skipped, 0 cancelled. The 22 failures are the exact same failures recorded against the deployed baseline; no new failures. Their names are preserved in `test-artifacts/child-locations/full-comparison.json`. This is a no-regression comparison, not an assertion that the existing repository suite is entirely green.

Deployment passed at 2026-09-18T06:50:59.749150+00:00. Image: `mbbs-operator-app:child-location-20260918-v1`, `sha256:741d39bcaa342c07e79e7ad9358d7196d871a9ed2f4b9f6e82f1ea5273a9747a`. Local and public health returned 200; anonymous delivery requests remained 401; all released asset hashes matched. Application configuration, worker and database containers were preserved. The additive migration is `208_child_location_fulfillment.sql`; posting switches were not changed.

Release manifest, rollback image, validated database backups, immutable live-test intent/attempt, transaction result and deployment result are retained under `/home/ubuntu/operatorapp-deploy-backups/child-location-20260918-v1`. The actual test called the shared posting adapter; it did not fabricate operator photos or local packing/completion records.

After cutover, the deployed image independently read and verified IF154026 again. A scoped refresh then read SOB120598 from NetSuite and applied its authoritative status and single source line through the existing sync repository; see `test-artifacts/child-location-cache-refresh.log`. No additional NetSuite transaction was created.

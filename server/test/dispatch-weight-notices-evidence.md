# Weight-only updates do not require review or re-planning

The user explicitly requested this rule after seeing SN1400072 change from 77531.9376 to 77531.938 lb. The saved and current order each contain the same two lines; the only source comparison difference is calculated weight. The accepted behavior is recorded in the appended [specification](dispatch-executed-review-active-lines-spec.md).

Weight changes are excluded from dispatcher notices, including larger updates. Weight still processes normally, and the existing executed-work comparison remains intact. Existing weight-only notices are hidden without deleting or acknowledging their ledger rows. Item, quantity and location changes retain their normal review behavior. Weight changes also preserve the token and acknowledgement of an existing genuine notice, including legacy notices containing both cargo and weight changes.

## Verification

- Initial regression: all 7 new tests failed before implementation; all 7 pass afterward.
- Focused integration/property/browser run: 28/28 tests passed. Includes the real webhook path, planning saves before acknowledgement, and 80 generated weight/execution cases.
- Randomized adjacent suite: 140 tests, 136 passed, four failures identical to the captured baseline; no new failures. The existing failures remain listed in [the earlier report](dispatch-executed-review-active-lines-evidence.md).
- Changed executable lines: 30/30 executed across the two production modules. This is changed-line coverage, not exhaustive branch coverage.
- Deliberate regressions: 4/4 caught (weight filtering removed, historical weight-only notice exposed, duplicate notice insertion, and genuine cargo changes incorrectly treated as unchanged).
- Static checks: zero lint findings in the changed modules, new test and checker; zero new type diagnostics (254 pre-existing). Two test-variable naming warnings were corrected without changing assertions, then the focused suite, mutations and static checks were rerun.
- Read-only candidate replay: the actual notice repository returns no SN1400072 or SOA09413 alert; SN1400072's historical row remains byte-for-byte unchanged. An in-memory quantity change still requests re-planning.
- No dependencies or schema changes. The exact task patch reconstructs the baseline successfully; credential-pattern scanning passed. No new performance benchmark was required for the small internal comparison change.

Run `bash tools/dispatch-weight-review-gauntlet.sh` to reproduce. Tool image: `mbbs-bin-planning-test:20260927` (Node 20.20.2, fast-check 4.9.0, ESLint 10.8.0, TypeScript 7.0.2, c8 12.0.0, Playwright 1.62.1). Source hashes, baseline files and logs are under `test-artifacts/dispatch-weight-notices`; the scoped patch is [dispatch-weight-notices.changes.patch](dispatch-weight-notices.changes.patch).

Deployment uses `tools/dispatch-weight-notices-deploy.py` to layer only the two verified backend files over the current app image, preserving unrelated releases and retaining a rollback image. The final release state is recorded in `deployments/dispatch-weight-notices-20260928`.

## Deployed verification

Deployed and verified on 2026-09-28 at 16:53 UTC: image `mbbs-operator-app:dispatch-weight-notices-20260928`, ID `sha256:4e2491050a702711662738ebfb330ecce31fdb41ce0dd89112ea5f16d4b46b79`. All 28 focused tests also passed against the captured release runtime. Application configuration, worker and dependencies were preserved.

The app is healthy with zero restarts. Local and public health checks returned HTTP 200; the notice endpoint still requires authentication. The actual deployed notice repository was queried in a read-only transaction: SN1400072 and SOA09413 have zero visible incident notices, and SN1400072's original observation remains stored. Genuine quantity changes still request re-planning. See the [deployment result](../deployments/dispatch-weight-notices-20260928/deployment-result.json).

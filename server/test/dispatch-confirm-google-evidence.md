# Dispatch Confirm Google route refresh evidence

Spec approval: not obtained (autonomous run), Tier 2. The requested behavior and the explicit choice to confirm with warnings authorize this work. The acceptance spec is `test/dispatch-confirm-google-spec.md`.

## Diagnosis

Read-only production evidence captured at 2026-09-30 19:20 UTC showed 155/155 recorded dispatch route calls succeeded with HTTP 200, with one overlapping admitted interval at most. The latest Confirm calls used two to four stops and completed sequentially. Configuration and budgets were available. This does not support simultaneous requests or Google rate limiting as the reported cause. Pre-admission policy fallbacks and browser rejection of a successful response are not fully represented in that ledger; the exact previously reported browser failure remains unproven. See `test-artifacts/dispatch-confirm-google-diagnosis/diagnosis.json`.

Confirmed source defects: Confirm selected only missing/invalid estimates, skipped cached valid routes even when map data was absent, discarded the failed-route report, and could treat an already-running manual refresh as an empty result. Save serialization and the persistent cache dropped the Google timestamp. A timing-valid result without geometry could overwrite a prior complete matching map. Required pickup/return reconciliation happened too late to include its new routes in the refresh pass.

## Resulting behavior

Confirm normalizes the date plan first, refreshes every editable route with physical travel once in driver order, bypasses cached estimates and awaits a matching manual request already in flight. Each request uses the departure calculated after earlier routes. It saves the collected results before confirmation, preserving timing, route identity, road paths, ordered stop coordinates and the provider timestamp. Date/plan changes during refresh or draft saving stop the old confirmation action.

Google failure produces a per-route confirmation warning while retaining a previous usable matching estimate. A missing-map result retains the entire previous complete matching Google estimate, including its timestamp; it never reuses a different route signature. Existing Google budgets, the more-than-12-stop standard request guard, manual refresh controls, edit leases, revision/digest fences, uncertain retry bodies, Driver evidence and shared-BIN ownership remain in force. No automatic paid retry queue was added: the requests were already sequential, and the user's queue request was conditional on overload.

## Executable evidence

New focused tests first reproduced missing all-route refresh, driver-order/departure sequencing, silent partial failure, manual-flight overlap, date changes, missing-map warnings, late-save scope changes, normalization order and loss of a prior complete map. Historical RED TAP files are retained under `test-artifacts/dispatch-confirm-google-routes-*.tap`.

The isolated PostgreSQL suite reproduced the missing timestamp in the baseline and verifies direct/cache serialization, raw stored JSONB, full save, compact update, confirmation, reload and rejection of stale saves. A throwaway geometry-loss backend mutant was killed. Backend source was not changed. Historical results are under `test-artifacts/google-confirm-persistence-6_g952rm/`; the final central validator reruns the DB suite against the exact deployment candidate.

The repeatable final command is `python3 tools/dispatch-confirm-google-check.py`. It pins source and test bytes, compares captured-baseline and candidate regressions, checks syntax and differential ESLint/TypeScript findings, intersects changed-line coverage with actual compiled executable AST nodes, kills four manual frontend mutants, and runs the real isolated DB suite. It makes no paid Google calls or production plan writes. Final metrics and deployment verification are appended after completion.

## Release scope

Only `public/dispatch.js` is overlaid on the captured current app image. All 1,152 runtime files, package bytes, app configuration and dependency containers are checked. The unrelated workspace pickup edits are preserved locally and excluded from deployment. The release helper requires all verification layers, gates on active operations, hashes seven saved-plan tables across cutover, checks local/public static assets and health, and automatically rolls back a failed app release without restoring the database or overwriting a concurrent unrelated release.

## Final frozen validation — 2026-09-30T20:02:47.250555+00:00

Candidate `public/dispatch.js` SHA256: `f4089f9fbf486477f723378a62fa19ce750f61400d0c050339f7da64d8c1df85`. Workspace source SHA256 is different (`893d9be90eef4de2e7f134823cdd5e3705daaa6c5d2d9889fb1f9054da108c6a`) because the candidate deliberately excludes unrelated local pickup overrides. The task patch was applied to the captured live asset with zero fuzz. Baseline, candidate runtime, test fixtures and validator tool hashes stayed frozen.

All 14 new frontend cases and all 27 existing maps/gateway tests pass. The broader regression differential ran 106 baseline tests (104 pass, 2 fail) and 120 candidate tests (118 pass, the same 2 fail), with no skips, cancellations or new failures. The preserved baseline failures are `DP-33 frontend: active CO projection retains every current relationship pickup` and `dispatch rendering and autosave never trigger route API work`. These pre-existing failures were not weakened or claimed fixed. The save-confirmation fixture now compiles the real new notice helpers; its assertions are unchanged. Eligibility assertions execute in both driver and truck planning modes. A cache-only fixture requires a fresh request and fresh provider geometry.

Syntax passes. ESLint findings are 84 baseline / 84 candidate and TypeScript findings are 3,017 baseline / 3,016 candidate, with zero new findings. The legacy app is not claimed lint/type clean. Tools: Node 20.20.2, ESLint 10.8.0, TypeScript 7.0.2, c8 12.0.0 and Espree 11.2.0.

Changed executable line coverage is **72/72 (100%)**. This is line coverage intersected with actual original compiled AST ranges and executed containing declarations, not a per-node or branch metric; no omitted scaffold code is counted. The real Confirm-button callback and request Map initializer execute. Four manual frontend mutants are killed by assertions: missing-only selection (7 failed tests), browser cache reuse (1), warning discard (5), and unawaited manual flight (1). The mutation layer caught a genuine cache-only test gap; that case was added before the final complete rerun. Historical backend geometry-loss mutation evidence is also preserved separately.

The exact final candidate passes all 3 real isolated PostgreSQL persistence tests. No paid Google API call, external NetSuite mutation, real production Confirm action or production plan save is part of verification. This proves the browser control flow and DB save/reload seams with substituted Google/network boundaries; it does not reproduce an actual failing Google response in production.

Full machine-readable evidence: `test-artifacts/dispatch-confirm-google/validation.json`. Release approval gate evidence: `test-artifacts/dispatch-confirm-google/verified-gate-check.json` and `release-full-layers-gate.json`.

## Deployed — 2026-09-30T20:15:30.831132+00:00

Image `mbbs-operator-app:dispatch-confirm-google-20260930` / `sha256:48e647f0a9363292fdeb789f0be5f6fb0644a81a5c2047e5d992877a9f138ffc` is live. Local and public health, planning HTML and dispatch JavaScript returned HTTP 200; the served JavaScript is the exact frozen SHA256 above. All 1,152 runtime files match the verified candidate. App configuration, dependency containers and package bytes match the captured baseline. Seven saved-plan tables have identical endpoint visible-row versions across the successful cutover and verification. No Google request or production plan write was made by deployment verification. Existing plans are refreshed and saved when their operator clicks Confirm; deployment itself does not rewrite their Google estimates.

Two preliminary attempts are recorded honestly. The first stopped before cutover because full-row hashing exceeded the 20-second read-only timeout; snapshot history occupied approximately 19.6 GB including TOAST/index storage. The second automatically restored the previous app after a conservative row-version guard reported differences. Its aggregate result cannot retrospectively establish content equality. A subsequent per-row live probe showed 22 changes, all exclusively `xmax`; captured background maintenance takes row locks without persisting unchanged plans. Failed-attempt evidence is preserved in `test-artifacts/dispatch-confirm-google/failed-apply-mvcc-20260930T201112Z/` and `row-version-idle-probe.json`. No database restoration was performed.

The final guard uses deterministic primary keys, counts, `xmin` and `ctid`, omitting lock-only `xmax`. Ordinary visible committed UPDATE/INSERT/DELETE changes these endpoint row versions or identities. This is a short-window row-version equality check, not an independently recomputed business-content checksum or proof of absence of transient writes. Physical rewrites can conservatively reject a release. The efficient probe took 0.179 / 0.151 seconds before the lock-only refinement; final successful cutover used the corrected method.

After rollback recreated the container, baseline metadata was rebound only after identical image ID, configuration, all runtime bytes, packages and dependency metadata were established. Only container identity/start time, image reference and Compose provenance changed. The archived rebind proof is under `test-artifacts/dispatch-confirm-google/baseline-rebind-20260930T201406/`; source verification was reused only for identical bytes. Final authoritative deployment result: `deployments/dispatch-confirm-google-20260930/result.json`. Earlier rollback evidence remains historical.

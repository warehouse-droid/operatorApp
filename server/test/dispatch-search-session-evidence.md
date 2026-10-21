# Dispatch historical search session evidence

**Deployed and verified at 2026-09-30T16:00:36.424977+00:00.** Both TOB01164 and TOB01163 were found by all eight live ordinary/historical legacy/versioned searches using the deployed browser request builder. Configuration and dependency containers are unchanged; order/line hashes are unchanged; diagnostic records were removed.

History Edit Mode searches sent `historyPlanDate` and the edit-lease token but omitted `sessionId`. The server reads the tab session from the query/body and rejects an empty value with HTTP 400, “A dispatch browser session is required.” Both legacy and versioned searches were affected. The shared request builder now carries the active date, tab session and lease token through search, browse, sync and search pagination. Server authentication and lease guards are unchanged.

The release [validation.json](../test-artifacts/dispatch-search-session/validation.json) and actual [HTTP log](../test-artifacts/dispatch-search-session/http-final.log) record:

| Check | Result |
| --- | --- |
| Focused browser/property regression tests | 10/10 passed, none skipped |
| Actual HTTP tests against a disposable database | 6/6 passed, none skipped |
| Broader regression selection | 58/59 passed; only the preexisting `DP-33 frontend: active CO projection retains every current relationship pickup` failure remains |
| Changed executable lines | 26/26 covered |
| Removed-session/date/token mutants | 3/3 killed |
| New lint findings / type diagnostics | 0 / 0 |

The HTTP tests preserve rejection of missing sessions, wrong sessions/tokens, cross-date credentials, expired leases and unauthenticated requests. The broader candidate selection adds no failure relative to its captured baseline.

Reproduce from repository sources without production captures:

```bash
python3 tools/dispatch-search-session-test.py
```

The standalone run [result.json](../test-artifacts/dispatch-search-session-reproduction-wlhljrk5/result.json) records the reverse-patched baseline at 49/59, current sources at 58/59, focused tests at 10/10 and isolated HTTP tests at 6/6. It also records 26/26 changed-line coverage, three killed mutants, zero new lint/type findings and unchanged repository asset hashes. Each invocation creates a fresh artifact directory and isolated database; no production inspection or credentials are required.

The [release manifest](../deployments/dispatch-search-session-20260930/manifest.json) uses the actual captured application image `sha256:61a4a18b02f32c9b0b0f144d1ff3c43a8bcb0dc707376fa975b32525ce589189` as its baseline. The candidate image is `mbbs-operator-app:dispatch-search-session-20260930` (`sha256:9aad1341e9afa6e0612177918d0b9d8766be753f0739f70302ce9bfd611f778b`). Its runtime delta is exactly `public/dispatch.js` and `public/dispatch.html`; the complete 1,147-file runtime hash map was checked. No Git commit, package installation, migration, order edit or plan edit is part of this change. Configuration and dependency containers are preserved.

An initial operational verification used the wrong planning-page URL, `/dispatch`, and rolled back. Verification now uses `/dispatch/planning`; the corrected [public checks](../deployments/dispatch-search-session-20260930/public-check.json) passed health and both asset hashes. A subsequent immediate historical read exceeded the diagnostic 15-second deadline and triggered another rollback. The restored baseline also exceeded that deadline on an ordinary search, and the [baseline latency observation](../test-artifacts/dispatch-search-session/baseline-latency-observation.json) subsequently found `TOB01164` with HTTP 200 in **17,976 ms**, with order/line hashes unchanged and diagnostic records removed. This establishes that the 15-second deadline was shorter than an observed baseline read; it does not identify the backend latency cause.

A later [baseline live-context probe](../test-artifacts/dispatch-search-session/baseline-live-context.json), with the missing request context explicitly supplied, completed all eight ordinary/historical legacy/versioned searches for both reported references: every request returned HTTP 200 and `found: true`, in **17.845–22.701 seconds**. It recorded unchanged order/line hashes and removal of all diagnostic records. This confirms that the baseline server can return both orders when the session context is complete.

The operational live checker now allows 60 seconds per read and gives its temporary diagnostic session/lease a 15-minute expiry. It creates diagnostic rows transactionally, refuses to replace an existing lease date, removes its lease/session/operator in `finally`, and checks cleanup plus the two TO order/line hashes. Release verification requires exactly eight HTTP 200 results with `found: true` on every result, unchanged order/line hashes and confirmed cleanup. These operational settings do not change the accepted browser, property, HTTP or performance regression tests. The final [release result](../deployments/dispatch-search-session-20260930/result.json) and [live check](../deployments/dispatch-search-session-20260930/live-check.json) record eight HTTP 200 results with both reported orders found. Live response times ranged from 19,896 to 31,729 ms. This frontend fix removes the missing-session error; backend search latency remains a separate limitation.

Final live requests:

| Order | Historical edit | API | Status | Found | Time (ms) |
| --- | --- | --- | --- | --- | --- |
| TOB01164 | No | Legacy | 200 | True | 22709 |
| TOB01163 | No | Legacy | 200 | True | 25209 |
| TOB01164 | No | v2 | 200 | True | 19896 |
| TOB01163 | No | v2 | 200 | True | 23404 |
| TOB01164 | Yes | Legacy | 200 | True | 21608 |
| TOB01163 | Yes | Legacy | 200 | True | 26100 |
| TOB01164 | Yes | v2 | 200 | True | 31729 |
| TOB01163 | Yes | v2 | 200 | True | 20592 |

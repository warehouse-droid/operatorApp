# Dispatch historical search browser session

Spec approval: not obtained (autonomous run). The user reported search failure for TOB01164 and TOB01163; proceed with the narrow bug fix and its verification.

Tier 2: repair the browser request context. The server's authentication, lease ownership, expiry, completed-order restrictions, and write guards stay unchanged. Failure model: missing session on one API/mode (real Chromium regression across off/shadow/on); lost context on refresh/pagination (browser tests); unsafe encoding (deterministic request properties); accidentally allowing invalid leases (actual isolated HTTP tests); shipping unrelated dirty files (release built from the running image with only the task patch, complete runtime hash comparison and rollback image).

Acceptance:
1. In History Edit Mode, typing TOB01164 and TOB01163 renders the matching order without the browser-session error in all three order-pool modes. Each request carries the active date, exact tab session, and lease token.
2. Historical browse, refresh/sync, and search pagination use the same credentials. Browse type, limit, cursor, and explicit search survive.
3. Current-date and historical view-mode searches retain ordinary feed behavior and send no history lease context. Search text is URL encoded without adding parameters.
4. The actual HTTP APIs still reject a missing session, a wrong session/token, and an expired lease; a valid isolated historical request succeeds. No production order or plan is repaired or rewritten.
5. Existing pool retention, planner request contracts, date validation, and lease-storage tests remain green. Check changed-line browser coverage and manually remove session, history date, and token independently; all three mutants must fail.
6. The scoped release contains only the new search behavior and the Dispatch script cache version; preserve runtime configuration and dependencies. Verify public asset hashes and application health after deployment.

Setup: existing Docker Node 20, Chromium/Playwright, ESLint, TypeScript and disposable PostgreSQL; no new packages, Git commits, or NetSuite calls. Add browser/property/HTTP regression tests, this spec, a reproducible check/deployment tool, and evidence. Keep production captures and raw logs in ignored test-artifacts. Use the existing isolated database runner for HTTP checks. Static checks compare baseline with candidate because the classic-script app uses globals and has existing diagnostics.

Implementation clarification: DPO-10's original structural assertions assumed the API path and page limit appeared inside every caller. They now inspect each caller together with the shared request builder and additionally require that the caller invokes the builder. All original assertions, endpoint/limit patterns, and behavioral expectations remain intact; the real browser checks exercise the resulting requests. The history-helper test fixture now supplies its tab session variable.

Operational diagnostic acceptance: use eight GET searches for both reported TO references across ordinary/historical context and legacy/versioned APIs. Every result must be HTTP 200 and contain the requested order. Create a unique temporary dispatcher/session and a `1900-01-01` edit lease in one transaction; refuse to overwrite an existing lease date and remove all diagnostic rows in `finally`, confirming cleanup. Compare the two TO order rows and their associated line hashes before/after to require unchanged cargo and status. Perform no sync, order/plan write or NetSuite call. The operational checker uses a 60-second request deadline and 15-minute diagnostic expiry based on measured baseline latency; the existing regression and performance test expectations remain unchanged.

# Sales routing confirmation and precise SO quantity errors

Spec: [quantity rejection and confirmation requirements](regular-stock-quantity-message-spec.md). Tier 3: order execution, stale preview protection and retry safety. Spec approval: not obtained (autonomous run); the user explicitly requested both behaviors and previously authorized deployment. No new dependencies, migrations, commits, live test orders or notifications were introduced.

## Behavior and evidence

| Requirement / failure mode | Executable evidence |
| --- | --- |
| Approved 760 / SO 912 is rejected with item, SO, both quantities and units | `regular-stock-confirmation.test.js`: exact SOB121631 case and 200 generated over/under cases; `regular-stock-external-workflow.test.js`: real HTTP 409 and exact message |
| Invalid quantity never creates a handoff or writes SO/TO | HTTP test checks unchanged request revision, zero handoffs, zero order writes for both preview and execute |
| Sales must confirm the exact location/TO action | Real preview returns action/token; missing confirmation and a changed SO route receive 409 before ownership/handoff creation |
| Cancel writes nothing; confirm executes only once | Browser tests dismiss then accept both location and two-route TO popups, count execute requests, and verify token identity |
| Changed SO, request or selected row cannot use a stale confirmation | Existing revision guard plus integration changed-route / invalid-selection checks; 150 generated fingerprint checks cover request identity, route, target, customer and quantities |
| Retry recovers saved routing, including partially applied location changes | Saved-plan preview uses no new remote read; JSON round-trip property covers timestamp serialization; existing real TO/location retry and concurrent execution tests remain intact |
| Result stays readable after reopening | HTTP GET returns persisted action, time and TO references; both browser flows reload and assert the stored yard / TO details |
| Structured errors display readable text, never `[object Object]` | Unit cases cover nested and top-level messages, plain strings, codes/status, null and unknown object fallback; browser RED captures the unreadable notice, then the final browser run displays the exact structured message and retries successfully |
| Existing completed requests remain readable; unsafe text is escaped | UI unit tests cover fallback request/transfer data and hostile `<script>` references |
| Header, non-stock companions, prices and exact quantity rules remain intact | Prior header/ancillary/NetSuite integration and property suites are included unchanged |

## Final fresh checks

Entry point from repository root: `python3 server/tools/regular-stock-confirmation-check.py` (Docker access required). It creates an isolated network and fresh disposable PostgreSQL database, runs migrations and every layer, and removes only its disposable resources. It reuses the existing `mbbs-regular-v2-runner` environment and images built by `docker-compose.mbt-test.yml` + `docker-compose.regular-stock-v2.yml`; no production credentials or databases are used.

- Relevant full regression suite: **171 passed**, **zero new failures**. One preserved neighboring missing-item-master harness failure remains (`Expected active item_master input.`).
- Focused reverse-order suite: **54/54 passed**.
- Browser: **11 workflow checks passed**, zero page errors, including popup Cancel, Confirm, stale-action error/retry and persisted result after reload. Mobile history screenshot inspected for readable wrapping and references.
- Changed executable lines: **85/85 covered**. Changed branches: **86/90 covered**; uncovered branches are optional missing-field / fallback cases, not unexercised write paths. HTML cache-version changes are verified by browser loading and deployment asset hashes, not JavaScript coverage.
- Mutations: **5/5 killed**, both by the combined unit regressions and the generated-property tests alone. Mutants corrupt requested/SO quantities, remove missing/stale confirmation guards, or break saved-plan serialization. Restored copies pass again.
- New generated properties: **350 cases**, seeds 121631 / 121632, in addition to existing stock/header/ancillary properties.
- Syntax, strict typed domain/parser checks, lint and diff whitespace: pass. Existing lint baseline: 85 unchanged diagnostics, zero new diagnostics; new module/test/tool lint passes separately.
- Node **20.20.2**, fast-check **4.9.0**, c8 **12.0.0**, ESLint **10.8.0**, TypeScript **7.0.2**. Existing pinned Docker toolchain, unchanged package hash. No dependency audit or new license review needed because the dependency set is unchanged.
- Capability / secret review: existing API endpoints and JSON columns only; runtime adds local SHA-256 comparison and browser confirmation, with no new network destinations, filesystem/process/environment access or credentials.

Sources, source hashes, raw TAP, browser results/coverage, coverage gaps, layer outcomes and screenshots are in `test-artifacts/regular-stock-confirmation/`. The task-scoped [patch](regular-stock-confirmation.changes.patch) is based on captured deployed files, not the repository's unrelated dirty changes. There is no commit checkpoint; immutable source hashes and isolated-copy mutant restoration identify the tested state.

## Investigation and limits

The first RED run failed seven new assertions against the original behavior. The initial implementation also exposed a real retry discrepancy: PostgreSQL JSON serialization converted Date objects to strings, changing a transfer-plan fingerprint. A new failing property reproduced it; canonical Date serialization fixed the defect without weakening the assertions. Initial coverage revealed that resume-preview behavior needed an explicit integration check; that test now verifies the saved action can be previewed after an external location change without reading a conflicting new order snapshot.

No live SO/TO/PO creation or location/quantity edit is performed by deployment verification. Real application and NetSuite adapters execute against a boundary transport in the isolated HTTP tests; account-specific live write permissions and downstream workflows are not claimed as verified by those tests. Existing adapter race checks and idempotent retry protections remain active. Strict types cover the established typed core; untyped handoff/UI code is covered by lint, execution, properties and browser checks. No performance SLA or schema migration applies.

The first cutover passed the live quantity check but rolled back automatically when the public verifier used Python’s default user-agent and received HTTP 403. The established deployment request headers returned 200 for all four verification URLs; the verifier now uses those headers. A second automatic rollback caught Cloudflare’s injected analytics script in the byte-for-byte HTML comparison. The existing deployment normalization was restored and validated against the live page: removing only that injected script leaves every application byte unchanged. The same tested image was then retried; runtime code and all source hashes stayed fixed. The user then reported `[object Object]`, reproduced by the browser when the Sales API helper coerced a structured error. The final UI extracts nested/top-level message strings and has a readable status fallback; the new RED and final green evidence are retained.

## Release

See [deployment and live verification](../deployments/regular-stock-confirmation-v2-20260929/README.md). The release overlays exactly six files on the deployed header/non-stock fix and verifies all 1,133 source/assets/migration files. Runtime settings, worker, database and Ollama remain unchanged. The previous image and Compose rollback are retained.

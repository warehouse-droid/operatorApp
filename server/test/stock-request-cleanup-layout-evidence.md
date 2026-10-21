# Stock request cleanup and layout evidence — 2026-09-27

Deployed image: `sha256:b352ee38fbbd03e4c6ebfe1b96283ff603e1ff763eb42602a20c7377d8959cd2`.
Spec approval: not obtained (autonomous run). The user explicitly approved removing application SPREQ records while retaining the closed NetSuite orders. The specification is [stock-request-cleanup-layout-spec.md](stock-request-cleanup-layout-spec.md). Tier 3 applies to deletion and authorization; UI verification was kept focused.

## Outcome and requirement mapping

| Requirement | Evidence |
| --- | --- |
| Remove the eight application test cases only | Exact manifest IDs 57–64 / SPREQ-000002–000009. Transaction receipt confirms 8 requests, 8 cases, 11 case lines, 27 draft order lines, 136 case events, 1 handoff, and 6 cached PDFs removed. |
| Durable backup and safe recovery | Complete JSON backup saved with directory mode 0700 and file mode 0600, fsynced before deletion. A serializable transaction rehearsed deletion, restored every owned row, compared the complete snapshot, and rolled back. |
| Preserve other requests and orders | Before/after hashes matched for all 56 regular requests, their lines/events/transfers/reservations, both linked SO headers and 8 SO lines, and the linked PO header and line. No NetSuite requests were made. SPREQ-000006 was never retried. |
| Guard stale backups, wrong identities, active work, unexpected dependencies | Unit safety cases and five manual mutations, recursive inbound FK inspection, short lock/statement timeouts, row locking, exact snapshot comparison, atomic deletion, and preservation checks before commit. |
| Multiple-yard filtering and authorization | PostgreSQL integration tests verify exact selected-yard results, Sales authorization intersections, empty selections, malformed selections, and backward-compatible singular parameters for Special and Regular lists. Seeded properties exercise duplicate and empty selections. |
| One desktop filter row and usable mobile layout | Chromium checks and screenshots for Sales/SCM at 1440, 768, and 390 pixels. Both Special and Regular filters were exercised; no horizontal document overflow. |
| Sales order references follow summary; case lines hide once SO exists | Browser assertions cover pre-SO cases, a closed SO without PO, and closed SO+PO. They verify immediate summary adjacency, SO references, PO references, and absence of Case lines after SO creation. |
| Preserve preview roles and loaded-card behavior | Sales has exactly one SO preview and no PO preview. SCM retains both previews. PDF dialog delivery is mocked at the HTTP boundary; loaded-card selection makes no detail or queue fetch. |
| Live acceptance | Both services healthy with original configuration and dependencies. All 8 public assets matched deployed source, accounting for the edge proxy's injected analytics tag in HTML. Special queue reads return no cases; all preservation hashes still match. |

## Final validation

The reproducible scoped entry point is `python3 server/tools/stock-request-layout-check.py`, using the existing isolated Docker runner and databases. It does not delete production data.

- 37 focused tests passed; the same tests passed with reversed file ordering.
- Six browser views passed with no page errors, covering both request types.
- 136/136 changed lines executed across the seven measured JavaScript modules; 81/106 changed-line branch outcomes executed. Remaining branches are documented in `test-artifacts/stock-request-cleanup-layout/changed-lines.json`, primarily display fallbacks and alternate UI states.
- Five of five manual mutants were killed. Both yard-filter/authorization mutants were also killed by the property test alone. Cleanup safety is additionally supported by the real rollback/restoration rehearsal, not a property-only claim.
- Syntax checks, scoped lint, and type checking of the shared filter module passed.
- Runtime diff reviewed for credentials and capability changes. No dependencies were added, no package/lockfile changed for this task, and no new runtime external-write capability was introduced.

Tool versions: Node 20.20.2, c8 12.0.0, fast-check 4.9.0, TypeScript 7.0.2, ESLint 10.8.0, Playwright 1.62.1. Source-tree SHA-256 for the validated source manifest: `619ae850988ea13b717d7f9bc7fbea3d8dfdc189ddbde413176443b751e2aa32`.

The initial Special integration tests failed because plural yard filters were ignored. A Regular fixture initially used incompatible PostgreSQL parameter types and was corrected. Existing source-contract tests needed the requested checkbox contract; an older VM fixture also lacked the page's `location` input and expected an obsolete asset version. Behavioral composer assertions were retained, and browser assertions exercise the actual menus. The initial coverage command inherited a whole-module percentage threshold from c8; the final check uses an explicit changed-line gate without changing the repository's global configuration. A missing legacy `prompt` lint global was declared; the new parser received explicit type annotations. The production rehearsal caught an incorrect order-header column in the verification query before any committed deletion; it was corrected and the rehearsal passed.

Limits: the repository-wide unrelated regression suite was not run for this scoped change. The three new forwarding expressions in `server.js` are checked by route contracts, not included in the measured changed-line coverage; API filtering itself ran against real PostgreSQL. CSS/HTML are verified in the browser, not through JavaScript coverage. Whole-monolith type checking was not added. Dependency vulnerability/license audits were not repeated because dependencies did not change. NetSuite transactions were deliberately retained without edits or API requests. The cleanup's database effects ran in real transactions; its production execution was not instrumented for V8 coverage. Cleanup concurrency protection was verified through lock/transaction design, stale-snapshot tests, and rehearsal, not a sustained production contention test. No commits or subagents were used.

## Operational records

- Validation and screenshots: `server/test-artifacts/stock-request-cleanup-layout/`.
- Private backup: `server/test-artifacts/stock-request-cleanup-layout/private/SPREQ-000002-through-000009.json`.
- Backup SHA-256: `ebd87f307bb29b0629f083434b67e9fd1220d064f736255548c3396206ef4dcc`.
- Rehearsal and deletion receipts: `private/rehearsal.json` and `private/deletion-receipt.json` in that directory.
- Deployment manifest, health checks, and rollback image information: `server/test-artifacts/stock-request-layout-release-20260927/`.
- Read-only post-release verification: `python3 server/tools/stock-request-layout-live.py`.
- Production cleanup commands already completed: `python3 server/tools/stock-request-test-cleanup.py backup`, then `rehearse`, then `apply`. They are deliberately not repeatable against the deleted records.

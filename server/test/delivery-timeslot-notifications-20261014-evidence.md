# Delivery timeslot, trip and notification evidence

Deployed to live MBBS on October 14, 2026 at 16:51 UTC after the user explicitly
requested “deploy”. The image is
`mbbs-operator-app:delivery-timeslot-notifications-20261014`. Local and public
health/asset checks pass. The exact release candidate repeated the verification
below with 226 passed, the same two established stock failures, and eight
detected mutations. See the [deployment record](delivery-timeslot-notifications-20261014-deployment.md).

Spec: [acceptance criteria](delivery-timeslot-notifications-20261014-spec.md).
Spec approval: not obtained (autonomous run). This Tier 3 verification covers
the stated concurrency and pricing rules; it does not prove that the spec covers
every business rule.

| Requested behavior / invariant | Executed checks |
| --- | --- |
| Sales requests another timeslot after securing delivery; Dispatch receives an alert | Delivery browser/event-stream regressions and `app-notifications-browser.test.js` background Dispatch alert |
| Dispatch counters; only Sales accepts that counter; secured window stays authoritative until acceptance | `delivery-timeslot-counter.test.js`; repository secured counter/replay/history/planning and competing-reply tests; desktop/mobile delivery browser counter flow |
| Preserve quote, SO links, secured timestamp and stopped expiry; reject wrong roles, invalid windows, stale revisions and races | Counter unit/generated invariant tests; delivery domain/HTTP/planning/repository regression suites |
| Select Single, Round or Multi-stop; round return costs exactly one truck trip | `delivery-request-trips.test.js`, including fractional BIN capacity and complete-journey consolidation choice; repository route/save/tamper tests; delivery browser trip form |
| Multi-stop records each pickup, drop-off and quantity; first pickup and last drop-off are MBBS yards | Trip unit validation and generated additive-pricing properties; repository directional-route/yard-evidence tests; browser endpoint selectors, add/remove legs, quote invalidation and save |
| Edit multi-stop to single without retaining obsolete legs; reject stale/forged quote inputs | Repository trip-edit and quote-authority checks; existing pricing, route, idempotency and consolidation regressions |
| OS alerts while MBBS is open, including background tabs; explicit permission; popups remain usable on denial or failure | Eight notification browser tests; hidden-tab alert and queued popup; explicit enable/disable, denied permission and notification failure; real Chromium persistent service-worker notification |
| Avoid repeated notices across refreshes and tabs; prevent previous-account notices after logout; local links only | Cross-tab/dedup, reload, delayed worker/logout, account-boundary and foreign-link browser assertions; selected mutation checks |
| Existing delivery, PO-reference, special delivery-method, regular-stock, special-stock and aggregate alert workflows | 23 affected suite files, deterministic shuffled file order, seed 14102026; two unchanged baseline stock failures recorded below |

The final fresh run completed after the last runtime/test edit. Reproduce the
verification and regenerate source identity/coverage evidence from repository root:

```sh
bash server/tools/delivery-timeslot-notifications-check.sh final
python3 server/tools/delivery-timeslot-notifications-evidence.py
```

The test entry point uses the repository's bounded isolated Compose harness.
Teardown is registered before resources are created. The raw test process exits
1 for the two established baseline failures. The verification wrapper succeeds
only when there are zero new failures and the failing test names and unchanged
test-source hashes match the persisted baseline. It retains the raw failures;
no tests are skipped or weakened to hide them.

| Layer | Final actual result |
| --- | --- |
| Affected regression suite | 228 tests: 226 passed, 2 established baseline failures, 0 skipped/cancelled/todo; 23 files |
| Types | Scoped delivery TypeScript check passed |
| Lint / complexity | Scoped ESLint passed, zero warnings, maximum function complexity 12; four modified sidebar/alert adapters also pass JavaScript syntax checks |
| Changed backend instrumented lines | 154/154 covered: domain 141/141, repository 13/13 |
| Backend coverage | 972/972 lines and statements; 128/129 functions; 645/696 branches (92.67%) |
| Browser coverage | Raw V8 reports retained for UI and alert scripts. No complete changed-browser-line percentage is claimed; the service-worker click handler was not instrumented |
| Manual mutation | 8/8 selected bugs detected; all temporary source copies restored and removed |
| Independent properties | 3/3 relevant mutants detected by generated invariant/pricing tests alone; generated counter and multi-stop properties each run 100 cases |
| Real execution | Isolated PostgreSQL and application HTTP/repository tests, desktop/mobile Chromium UI, and actual Chromium service-worker notification creation/readback with request-link data |
| Host cleanup | All task test containers/databases, volumes and networks removed; both `docker ps` and `docker ps -a` show only the four production containers; production health checks pass |

The two baseline failures also reproduce with the original touched browser assets:

- `Wait for Transfer requires ETA, sends the date, and keeps the selection after saving`
  (`special-stock-alert-browser.test.js`): the browser reports
  `Cannot read properties of undefined (reading 'map')`.
- `changing queues discards an unfinished Resolve reply without submitting or closing the case`
  (`regular-stock-resolution-browser.test.js`): the Closed queue still contains
  pending request `STREQ-000004`.

These stock failures remain unresolved in this delivery/notification change.
The baseline source hashes and exact names are recorded in
`tools/delivery-timeslot-notifications-baseline.json`. Baseline and final raw
logs are retained for comparison.

The eight mutations cover premature schedule changes, accepting one's own
proposal, quantity-multiplied return charges, a final drop-off outside an MBBS
yard, omitted multi-stop legs, suppressed background delivery alerts, repeated
OS notices, and accepting foreign notification links.

Earlier RED runs demonstrated missing counter, trip/pricing, yard-endpoint and
notification behavior. An initial UI test setup omitted navigation; that setup
was corrected before rerunning RED against the original UI and confirming the
missing forms. Regression runs also caught legacy DTO-shape and first-row
layout changes, which were corrected while retaining the assertions. Native
notification validation initially encountered the headless shell's denied
permission; the final run uses full Chromium with an isolated persistent
profile and origin-scoped permission, and asserts actual notification readback.

Tool versions: Node 20.20.2, Playwright 1.62.1, c8 12.0.0, fast-check 4.9.0,
ESLint 10.8.0, TypeScript 7.0.2, pg 8.21.0 and Express 4.22.2. No application
dependencies, database schema, credentials or commits were added. Existing
locked development dependencies support the isolated harness. Runtime capability
changes are browser notification permission/display, same-origin staff-session
verification and a dedicated notification-click worker. The worker does not
replace the existing Operator or Driver PWA worker.

Known limits: the broader repository suite was not run; verification covers the
affected delivery and shared-alert suites. No cross-browser/OS matrix,
physical notification click, performance benchmark or closed-application Push
API subscription is claimed. Closed-application push is outside the user's
explicit “while MBBS is open” requirement. Dependency/license auditing was
omitted because the dependency set did not change. Browser permission/OS
notification settings remain under the staff user's control; staff enable
notifications through the new “Enable OS notifications” control.

Source hashes, runtime-only patch, raw failure logs, suite order, versions,
coverage, mutations, screenshots and cleanup/health evidence are under
`server/test-artifacts/delivery-timeslot-notifications-20261014/`.
`EVIDENCE.json` identifies the scoped source tree by SHA-256 rather than an
unrelated dirty-workspace git revision. Source snapshots and logs are retained;
no test database or persistent browser profile is retained.

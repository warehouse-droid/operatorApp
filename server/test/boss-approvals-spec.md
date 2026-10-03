# BOSS approvals executable specification

Approved in conversation: implement the BOSS plan; Accounts must also have an
email field. Tier 3: authorization, financial decisions, external side effects,
queue races and notification delivery. No new npm dependencies or git commits.
Use the existing Node/PostgreSQL/Playwright/fast-check toolchain in the dedicated
internal-network test stack managed by `tools/boss-test-env.sh`.

## Acceptance contract

1. Only a successfully fetched AND committed SO status observation can create
   approval intake. Pending Approval is eligible even when the existing refresh
   job outcome is retry/failed because the order remains pending. Failed reads,
   missing results, lease loss and rollback create nothing. PO/TO never enter.
2. SOT receives the same durable delayed check through an approval-only path;
   its exclusion from dispatch/fulfillment is preserved. Existing backoff stays.
3. Three configured active BOSS identities: Tony Tan, Jason Pu, Alex Huang.
   Customer custentity4 is matched by verified list IDs. A matching owner sees
   only their request; null/other owners route to all three. Admin alone cannot
   approve. First eligible Accept or Reject wins; requests cannot be bulk acted.
4. Show order/customer, customer creditLimit/balance and currency. No workflow
   Credit Balance. Missing financial values are unavailable, never fabricated
   zero. Snapshot changes require refreshed confirmation. Offline disables writes.
5. Accept is green #15803D with white text; Reject is red #B91C1C with white text.
   Both are >=48px tall; both confirm; rejection requires no reason.
6. Decisions are durable and idempotent. Only confirmed NetSuite final outcomes
   enter history and trigger result notices. Unknown outcomes are reconciled
   without blindly repeating a workflow action. Repeated pending refreshes must
   not resurrect rejected requests; a verified resubmission starts a new cycle.
7. All BOSS users see immutable decision history. Eligible users receive new
   request alerts; all three receive approved/rejected alerts including actor.
   In-app notices persist, with read status; email jobs retry independently.
8. Account email is optional for normal accounts, validated on create/update,
   returned by account APIs and editable on Accounts. All three configured BOSS
   accounts need email before activation. No guessed accounts, IDs or addresses.
9. NetSuite integration uses a narrow RESTlet with configured workflow actions,
   signed request identity, version checks, decision receipt and workflow outcome
   verification. Native REST supported record actions do not include Sales Order.
   Integration stays disabled until required configuration/readiness is verified.
10. Initial pending orders are enrolled through the delayed-refresh gate. BOSS
    data is never put on unauthenticated general event streams or public Sales.

## Failure model and verification

- Wrong owner/role and crafted identifiers: property, HTTP and adversarial tests.
- Premature request publication/partial writes: real PostgreSQL rollback tests.
- Duplicate webhooks, workers or opposing decisions: concurrency/idempotence tests.
- Remote timeout after execution: receipt reconciliation tests, no duplicate action.
- Account/owner/balance changes: revalidation tests before durable decision claim.
- Lost emails or notification leakage: recipient/outbox/retry and role tests.
- Broken mobile view: Playwright at 320, 390 and 430px, accessible dialog/buttons.
- Existing behavior: refresh policy/service/repository, role and navigation suites.
- Static checks, coverage, deliberate mutants and shuffled test order are recorded
  in the final evidence report. Real NetSuite workflow execution requires deployed
  action IDs; any unavailable live verification must be stated as a limitation.

## Approved conversation revisions

- Use standard NetSuite REST PATCH of salesOrder.orderStatus to B for Accept,
  followed by authoritative read-back. There is no RESTlet and no change to the
  existing NetSuite workflow. Rejected requests stay pending in NetSuite; reject
  is a local decision with history/notifications, no reason or remote write.
  They remain suppressed while NetSuite stays pending, including ordinary edits.
  A verified departure from pending followed by re-entry is a new review cycle.
- Use company Gmail SMTP for email, with credentials only in server environment.
  Add one pinned dependency, nodemailer, for TLS SMTP and MIME generation instead
  of implementing an SMTP client. Audit the added dependency and record version.
  Normal account emails are optional; configured BOSS accounts require email.

## 3 October 2026: three credit figures and sticky phone header

User-authorized scope: show Account Credit, Current Owed (outstanding balance
plus unbilled orders, presented as a deduction), and Credit Balance on the BOSS
approval page. Keep the header, tabs and search bar visible while scrolling.
This supersedes the two-figure presentation in acceptance criterion 4.

Acceptance examples:
- A single refreshed customer snapshot with creditLimit=200000,
  balance=14723.64 and unbilledOrders=37021.83 displays Account Credit 200,000.00,
  Current Owed -51,745.47 and Credit Balance 148,254.53. Show the outstanding
  and unbilled breakdown; never subtract the current order a second time.
- Decimal arithmetic is exact; an actual credit on the customer account keeps
  its mathematical sign. Zero never displays as negative zero. Missing values
  yield Unavailable, not zero. A missing unbilled value prevents acceptance.
- All three values derive from the same live customer read. No historical
  custom NetSuite Credit Balance value is substituted. A change in unbilled
  orders invalidates confirmation just as an outstanding-balance change does.
- Cards, confirmation dialogs and history details use the same three-figure
  presentation. Existing history without unbilled values is not rewritten and
  shows unavailable derived values instead of inventing a historical balance.
- At 320, 390 and 430px widths, financial values fit without horizontal overflow;
  the header, tabs and search remain visible during real document scrolling.
- Existing owner routing, refresh-success gate, native acceptance, local rejection,
  decision history and notification behavior remain covered by their regressions.

Failure model: sign/double-counting/rounding errors (example and property tests);
missing financial data shown as zero (adversarial cases); unbilled data changes
after confirmation (fingerprint and service regression); historical records
rewritten (repository/browser check); sticky controls overlap cards or escape
the viewport (phone browser checks); unrelated release changes (scoped image
overlay and complete source-tree comparison).

Setup: existing disposable PostgreSQL/Node/Chromium test stack, existing
fast-check/ESLint/TypeScript/c8; no dependencies or commits. Append evidence in
test-artifacts/boss-credit-display-20261003. Tier 3 for financial arithmetic;
spec approval: not separately obtained (autonomous run based on the user's
explicit display request and previously agreed calculation).

## 3 October 2026 — global search, grey approved cards and audit snapshots

Spec approval: not separately obtained (autonomous run based on the user's requested changes). Whole approved card grey confirmed explicitly by the user. Tier 3 for historical financial evidence and authorization. Continue using existing disposable PostgreSQL/Chromium/Node/fast-check/c8/ESLint/TypeScript; no new dependencies, database migrations or commits.

- A nonblank order/customer search returns a combined result list from Pending and History, from either tab. Pending/processing entries remain restricted to the current BOSS's routing; all three BOSS can see all completed entries. Case-insensitive partial matching and literal percent/underscore/backslash characters work. Search ignores a previously selected History decision filter. Blank/whitespace search restores the selected tab. Stable combined pagination returns every authorized match once.
- The interface labels combined results "Search results across Pending and History". Clearing search or selecting a tab returns to that tab's normal view. Typing a query is not lost to automatic refresh. If the user changes a search/tab while a request is running, the latest view wins; an old response cannot paint wrong results or suppress the user's new request.
- An entire approved card has a grey background, keeps an explicit Approved badge, and has no Accept/Reject actions. At 320/390/430px it remains readable without horizontal overflow; sticky header/tabs/search remain functional.
- A successful BOSS approval explicitly saves the decision command's financial snapshot in the completed request and event. Account Credit, outstanding balance, unbilled orders, Current Owed, Credit Balance, currency, customer/order identity and order total remain the values reviewed before approval, even if NetSuite changes during read-back or later refreshes. UI identifies saved figures, their capture time, approver and completion time. Older incomplete snapshots retain their original missing values. External NetSuite resolutions retain the last saved pending figures and identify NetSuite as actor.
- The main Admin Audit Log includes BOSS events directly from the immutable event history, including prior events. It supports order number, action, approver and date filters with the saved snapshot in details. Stored approver/order names remain historical even if current account/order names change. No duplicate event copying and no privileged access expansion. Untrusted customer/actor text is escaped in the audit UI.

Failure model: cross-owner data leakage (real-database authorization tests); stale/paged search results (browser delayed-response test and pagination test); history overwritten by post-approval balances or later re-entry (database/service/concurrency regression); audit missing past events or wrong actor (filtered union-query and browser tests); stored XSS from financial snapshot text (browser adversarial test); release collateral changes (scoped live-image patch, source/configuration hashes and candidate regression suite). No automated test sends real email or changes a live NetSuite order.

Snapshot representation clarification: the existing decimal normalizer stores `54.10` as the exact canonical string `54.1`; snapshot preservation keeps that stored representation. The interface formats monetary figures to two decimals. The new audit assertion uses `54.1` to match this existing storage contract.
### Additional randomized search regression (2026-10-03)

Generate mixed pending/rejected orders assigned to each BOSS or to everyone, with literal wildcard and quote characters in customer names. From either tab the result must equal the authorized pending subset plus all completed decisions, even when an old decision filter is supplied. Use a recorded seed and compare exact request IDs. This supplements the fixed pagination and hostile-input cases; no production access or new dependencies are needed.

## 2026-10-03 — native REST rejection closes the sales order

User authorized closing SOB121952 and SOB121951, then implementing Reject when native REST closure works. Live queries confirm both are H / Closed with all item lines closed. User explicitly requires an in-app confirmation popup, not window.confirm; no reason is required. Test emails remain held.

This amendment supersedes the earlier local-only rejection requirement and its assertions. Spec approval: not obtained (autonomous run under the user's implementation instruction). Tier 3: financial mutation, authority and concurrency. No dependencies, migrations, commits or workflow-definition changes. Reuse the existing isolated Node/PostgreSQL/Playwright tooling; capture file preimages and apply only task diffs onto the captured live image. Add reproducible tests, mutation/coverage tooling and deployment evidence.

Acceptance/failure model:
1. Reject confirmation is an accessible in-app dialog, identifying the order/customer and saved financial figures, explaining closure, offering Cancel and a red/white “Reject and close order” button. No browser dialog, reason field or write on Cancel; confirmation disables duplicate submission.
2. Both decisions enqueue one durable command and put the request in processing. Concurrent/replayed decisions cannot cause duplicate writes or completed notices before verification.
3. Native close runs inside the existing mutation queue, reads expanded SO items, validates identity, Pending Approval, unique positive exact line IDs and complete line list, rechecks current authority/owner/credit/version immediately before PATCH, then sends only existing line IDs with isClosed=true. No record deletion or direct orderStatus H assignment.
4. Reject becomes rejected only after NetSuite confirms H. A/B/other states, read errors, workflow reapproval, transport loss and permission errors must never falsely report closure. An ambiguous write is reconciled using reads every 30 seconds and is never automatically sent again. Known failure keeps the request actionable, with accurate error text.
5. Workflow-locked record reads may use fresh SuiteQL evidence only for an exact SalesOrd identity at status H. Missing, duplicate, mismatched and non-H query rows fail safely; no invented pending financial values.
6. Completed rejection saves the exact durable command snapshot and actor; all three BOSS get one rejected_closed event, shared history/audit and normal notifications only after confirmation. Legacy local-only rejections remain distinguishable and must not claim closure. Existing approved figures/history remain immutable.
7. Owner restrictions, successful-refresh intake, acceptance, cross-tab search, sticky header, authentication, numeric reset codes and email handling retain their previous contracts.

Layers: adapter/service contracts and properties for status outcomes/line identities; PostgreSQL race/idempotency/lease/snapshot/notification tests; real HTTP/browser mobile cancel/confirm tests; strict scoped types/lint, changed-line coverage with honest exceptions, 5 manual mutations and property-only mutation checks, shuffled full feature regression, exact candidate and public deployment smoke. Known limit: external NetSuite changes between the last read and PATCH cannot be made atomic by REST; unexpected post-write states are reconciled, never claimed closed without H. Live test orders began Pending Fulfillment; the Pending Approval close path is additionally exercised through the real application endpoint against an isolated NetSuite boundary.

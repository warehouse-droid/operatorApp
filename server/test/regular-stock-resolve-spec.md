Regular Stocking Resolve — executable specification

Scope: SCM can resolve a regular request using the Stocking method (Transfer or Purchase) before purchasing or transfer execution starts. The optional scope question has no answer yet; this follows the user's wording and the stated Stocking-only assumption.

Scope confirmation: the user selected Stocking requests only. Transfer and Purchase Stocking remain in scope.

Notification clarification: the user asked about the persistent top-bar notice. Explained that the Sales badge tracks unread decisions until the requester opens the case; other unread decisions keep the badge visible. SCM's review badge counts pending work. The Resolve notice uses that existing acknowledgement behavior. Notification privacy means only the requester receives/acknowledges the notice; case visibility retains existing yard permissions.

Spec approval: not obtained (autonomous run). Tier 3 because closure, concurrent SCM actions, and private Sales notifications must remain consistent.

Acceptance criteria:

1. Resolve opens a reply form with required Existing PO number and ETA date. Desktop and phone layouts, keyboard submission, refresh, language changes, and server errors preserve the entered reply. Cancel leaves the request unchanged.
2. SCM submits a valid case revision, an exact existing mirrored PO number (case insensitive), and a real ISO calendar date. Empty, malformed, oversized, unknown, deleted, and ambiguous PO references are rejected without writes. ETA is a date; historical dates are allowed.
3. Resolve stores the canonical PO identity, ETA, actor, and completion time; closes remaining open lines and the case; and shows the reply in Sales Completed and SCM Closed. It does not create, amend, allocate, or fulfill a PO or TO, or call NetSuite.
4. The original Sales requester gets one unread decision even though the case is closed. Peers and other yards cannot read or acknowledge it. Opening the reply uses the existing acknowledgement and the alert stays dismissed after refresh or a retry.
5. Concurrent identical submissions and a lost-response retry return the saved result with one closure event and one revision increment. A different reply cannot overwrite a closed case. Stale revisions and competing decisions fail without partial updates.
6. Only SCM writers can resolve. Special requests, Pickup/Delivery methods, cancelled/completed requests, transfers, SO handoffs, TO conversion, accepted Purchase demands, and unexpected line states cannot be closed through Resolve. Existing review, purchase, transfer, Sales access, and notification behavior remains covered by the affected suite.

Failure model:

- Duplicate notifications or partial closure: real SQL transactions, concurrency tests, rollback injection, acknowledgement/replay checks, and manual mutants.
- Wrong PO or malformed ETA: canonical mirror lookup, exact reference tests, hostile input tests, calendar properties, and unchanged-PO assertions.
- Orphaned purchases/TOs or reopened cases: lock purchase planning before the case, prohibit existing commitments, verify closed queues and purchase reconciliation, and race tests.
- Private response disclosure: authenticated HTTP tests for role, requester, and yard restrictions.
- Unusable form or a lost reply: real browser execution on desktop/phone with refresh, validation, errors, and Sales notification navigation.
- Unrelated production changes lost: capture running sources, merge only the listed files, verify full image source hashes and preserved configuration, prepare rollback, and guard live operations before publication.

Setup: use existing Node, Playwright, TypeScript, ESLint, c8, and fast-check in the isolated review container/database. No dependencies, schema migrations, Git resets, or checkpoint commits. Keep private captures under test-artifacts/regular-stock-resolve-20261002 and deployments/regular-stock-resolve-20261002. Add focused tests, a reproducible gauntlet, source hashes, and an evidence report. Tests must never use the production database. Any live publication uses the guarded release workflow and applicable authorization.

Draft lifecycle clarification: changing SCM queues discards an unfinished Resolve reply without submitting or closing the case. Returning to the request requires opening a fresh empty reply. The implementation already provided this behavior; a throwaway queue-reset mutant must demonstrate that the additional regression test fails when the reset is removed.

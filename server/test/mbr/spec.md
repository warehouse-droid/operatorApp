# MBR Contract executable specification

Approved: the user's implementation instruction accepts the proposed MBR plan.
Additional requirement: both staff and customer layouts must work on phones.
Assurance: old-coder Tier 3 (roles, contractual evidence, expiry races).

## Behavior and failure model

1. MBR Sales and admins manage all MBR contracts. Ordinary sales cannot access
   MBR, and an MBR-only account cannot read other protected staff modules.
   Mixed-role accounts retain their pre-existing access. Check real HTTP routes.
2. Sales fills every agreement blank for one equipment item, CAD rates and
   deposit, and a positive whole expiry duration (default three days). Reject
   invalid dates, reversed rental periods and invalid monetary values.
3. Pending saves without a link have no deadline. Issue once, then copy the same
   link without restarting time. Edits keep that link, append a version, and
   restart the configured period. Signing an outdated revision returns 409.
4. At or after the deadline, unsigned contracts are expired and signing/edits
   fail, even without the worker. Renewal is explicit, rotates the link, keeps
   the contract number, and records the expiry history. Check clock boundaries
   and concurrent renewal/signing/expiry/edit operations using PostgreSQL.
5. Customers need no account. Sign only the current revision after an explicit
   protection choice, full-agreement consent, signing name and nonblank drawn
   signature. Protection remains 15% of applicable charges. Do not calculate
   a rental total or add separate initials.
6. Signature, exact template/fields/choice, server signing time and PDF commit
   together. Renderer failure rolls back everything. Duplicate retries do not
   duplicate evidence. Completed records cannot change or expire; their links
   retain read-only access. Decode actual PDF text and verify the supplied
   agreement's complete wording, filled fields and protection selection.
7. Tokens are random, contract-scoped, hash-validated and encrypted at rest for
   staff retrieval; renewals invalidate previous tokens. Never log raw tokens
   or signatures. Reject malformed/oversized images, cross-origin signing and
   hostile fields. Bound public request rates and memory. Check these failures.
8. Public agreement data and MBR pages bypass service-worker caches. Customers
   re-review changed terms; retries retain their work until a successful save.
   Check no-account review, finger signing, mouse signing and network failure.
9. At 375 px and 390 px wide, staff lists/editors and customer review/signing
   have no horizontal overflow, readable text, >=44 px controls and stacked
   fields. Check Chromium and WebKit plus accessibility.

## Setup and evidence

Use installed Express, pg, pdfkit, sharp, Node crypto, Node test, fast-check,
c8, ESLint, TypeScript and Playwright. No new dependencies or automatic commits.
Preserve the existing dirty workspace. Record original integration files and
their hashes before editing them, then identify final source by a tree hash.
Persist a runner, manual mutants, screenshots, coverage and spec-to-test report.
Run RED before implementing each behavior group. Then run the relevant full
regression suites with zero new failures, focused checks, types, lint, changed
coverage, property tests, mutation, adversarial cases and real HTTP/browser use.
Record failures and skipped/unavailable layers honestly.

Use only the repository's isolated Compose configuration, bounded workloads in
mbbs-tests.slice and disposable-test labels. Register finally/SIGINT/SIGTERM
cleanup before starting. Always down --volumes --remove-orphans, verify ps and
ps -a, and preserve production and other active tasks. Keep evidence, not DBs.
Roll out with the independent MBR_CONTRACTS_ENABLED flag (default off); retain
contract records and the persistent link key on rollback.

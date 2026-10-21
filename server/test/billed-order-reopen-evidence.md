# Billed order reopen and PO link evidence

Spec: [billed-order-reopen-spec.md](billed-order-reopen-spec.md).
Spec approval: not obtained (autonomous run). Tier 3, calibrated to the local
fulfillment safeguards. No dependencies, database migrations or NetSuite writes.

Reproduce from the repository root:

```sh
bash server/tools/billed-order-reopen-20261015/gauntlet.sh
```

The captured source is in tools/billed-order-reopen-20261015/baseline and the
verified source is in candidate. Per-file SHA-256 values are in
test-artifacts/billed-order-reopen-20261015/summary.json. Base image and capture
identity are in tools/billed-order-reopen-20261015/capture.json. No commits were
made in the existing dirty workspace; the deployment overlays three files only.

| Layer | Final measured result |
| --- | --- |
| Existing baseline | 82 passed, 1 failed / 83 |
| Full relevant suite | 98 passed, 1 baseline failure / 99; zero new failures |
| New tests, reversed file order | 16/16 passed |
| Changed executable lines | 9/9 covered |
| Manual mutation tests | 5/5 killed |
| UI property-only mutations | 2/2 killed |
| Type diagnostics | 4581 baseline, 4581 candidate; zero new |
| Lint | Zero new production diagnostics; zero new-test diagnostics |
| Real execution | Authorized HTTP reset and browser reopen of an isolated Billed fixture passed |
| Cleanup | Project containers, volumes and networks removed; production healthy: True |

Scenario mapping:

1. Billed reset, preserved NetSuite status/quantities/photos/audit, exact retry:
   billed-order-reopen.test.js real HTTP and browser cases.
2. Actual fulfillment IDs, timestamps, quantities and durable fulfillment records,
   Pending Billing and inactive/closed blocks: the same file's negative matrix.
   Existing control-order-reopen suites cover authorization, receiving, posting,
   consolidation, Driver start, stale previews, atomic groups and real lock races.
3. PO action visibility, stale eligibility, execution states, raw metadata,
   mixed selection and ordinary open orders: billed-order-po-link.test.js,
   including fixed-seed two-sided properties and two property-only mutants.
4. Link preview before/after reset: new real HTTP scenario; allocation and split
   correctness: existing dispatch-po-split-link-target.test.js suite.

Known baseline failure, reproduced unchanged:
`real browser: manager previews, confirms reset and sees retained images in Operator`. Its broad `[role="status"]` locator matches both
the reopen result and the application notification status. The existing test
was not weakened or skipped. The new billed-order browser case scopes the
same result assertion to the Order Reopen panel and passes. Static checking
also retains existing diagnostics instead of hiding them.

Initial failures and repairs: both reported behaviors failed before runtime
changes. Two added partial-fulfillment UI cases exposed an incomplete exception;
the exception was tightened without weakening assertions. The first snapshot
fixture targeted a table that does not support SO; the append-only spec correction
documents replacement with the actual durable SO fulfillment table. TypeScript 7
returns 1 for diagnostics; the runner now validates diagnostic output explicitly.

Scope and limits: unrelated module suites were not run. No live order was reset
as a test. Mutation results cover selected plausible regressions, not all possible
faults. The UI property mutations cover UI gating; backend safeguards use concrete
evidence matrices and existing database/concurrency properties. No new capability
or package was added to runtime; dependency audit is not applicable. Source changes
are small expressions, with no new functions or external I/O.

Tools: {"c8": "12.0.0", "eslint": "10.8.0", "fast-check": "4.9.0", "playwright": "1.62.1", "typescript": "7.0.2"}; Node v20.20.2.
Logs, browser screenshot, coverage, mutation results and cleanup listings are in
test-artifacts/billed-order-reopen-20261015. Production verification and rollback
are recorded separately by tools/billed-order-reopen-20261015/deploy.py.

Live release and requested linkage (2026-10-15): deployed image
`sha256:fe6d0858dddcc511ab2fabedd6705954babf9f174d145c3340c3c4eeee5a6144`.
The three-file overlay preserves the intervening pickup-remaining-packs release.
An initial verification requested the Dispatch menu instead of `/dispatch/planning`;
automatic rollback restored the previous healthy image. Correcting that verification
URL and repeating deployment passed. Both attempts and rollback data are retained.

Live read-only verification confirms SOM06964 is locally open, not fulfilled,
reopen is allowed, and Link PO is visible. The user then requested PO linking
without knowing the PO number. Existing special-stock cases 141 and 142 identify
POB04024 (#263967) and POB04022 (#263968), respectively. The application's normal
atomic dependency command created allocations 268–272, covering Porcea quantities
26.66 SQFT, 9 PC, 72 SQFT, and StoneArch 60 + 28 SQFT. Receipts are
`615c6885-a501-43b2-a808-4338cda536b8` and
`9a8fa0fe-06ac-4cea-98bd-b2ee74dd4338`, attributed to
`codex:SOM06964:20261015`. These were authorized operational changes, not tests.
Canonical SO/PO headers and lines were conserved; both preflight and transaction
hash are `a7ba0f134f91c96aa8dc5d7cc35c660450c8c8c0ca4bcbe37061e068a59c245a`.
Two limestone pier caps (10.88 SQFT) have no available matching PO and remain
unallocated. A separate read-only verification after commit sees all five links,
healthy production, and only the four production containers in ps and ps -a.

The user's subsequent request extends local reopening to the full Dispatch and
Operator workflows, beyond the initial PO action fix. Its additional specification,
tests and release are recorded separately under `local-reopen-20261015`.

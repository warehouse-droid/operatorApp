# MBBS Order Billing V3 — Verification Evidence

Date: 2026-08-13 (UTC)

Scope: exact Toronto completion-date filtering, scrollable billing tables,
vendor-to-MBBS PO routing, Delivery-only default Sales Order selection,
explicit Pick-Up database search, completed custom local orders, and atomic
conversion of server-recalculated candidates into durable local-only billing
cases.

## Safety boundary

- Tests ran only in the disposable Compose project
  `mbbs-mbt-billing-v3-red` with its isolated PostgreSQL database.
- No production database, external transport, NetSuite outbox, Dispatch plan,
  Sales Order method, or Driver PWA record was mutated.
- No deployment or commit was performed.
- Migration 158 is forward-only and extends the immutable completed-load source
  allowlist with `billing_candidate` and the cross-charge source allowlist with
  `CUSTOM`.
- After verification, the exact Compose project, temporary database state,
  network, and four generated test/runtime images were removed. They contain no
  production data and can be recreated from the repository.

## RED evidence

Before implementation, the focused acceptance/contract packet failed at the
newly specified boundaries: PO origin-scope rejection, missing Delivery/custom
selection, absent exact-date filtering, absent durable conversion, missing
rollback evidence, and missing UI controls. Eight expected checks were red.

## GREEN evidence

| Gate | Result |
|---|---|
| Focused V3 unit/integration/property packet | 10/10 passed |
| Randomized custom-order billing batches inside focused packet | 300/300 passed |
| Existing billing compatibility packet | 46/46 passed |
| Migration upgrade/idempotency test | 1/1 passed |
| Scoped billing mutations | 8/8 killed (100%) |
| Focused Playwright billing workflow | 6/6 passed: desktop Chromium, mobile Chromium, iPhone WebKit |
| Full MBT Node suite | 290/290 isolated files; 1,565 tests passed |
| TypeScript check | passed |
| Full repository-configured MBT ESLint, zero-warning policy | passed |
| Browser script syntax check | passed |
| Billing-scoped changed-line secret scan | 23 paths passed, zero findings |
| Dependency license policy | 383 packages passed; existing `buffers@0.1.1` metadata exception retained |
| `git diff --check` | passed |

The broader `secrets:mbt` command still reports two existing synthetic fixture
assignments outside this change in
`test/mbt/e2e/operator-reload-photo-capture.spec.js` and
`test/mbt/unit/delivery-instruction-upload-policy.test.js`. The scanner was
therefore rerun against the exact billing change set and passed. No scanner
suppression or credential-shaped value was added by this work.

## Proved invariants

- A retained PO vendor address and MBBS destination address calculate as one
  vendor-to-yard route even when the vendor is outside a rate graph's yard
  metadata.
- Any supported candidate with references and two retained addresses is not
  rejected solely by origin-yard scope.
- Default Sales Order candidates require delivery method `Delivery`; a
  completed `Pick-Up` can enter only after explicit database search and add.
- Completed, non-cancelled custom local orders are first-class `CUSTOM`
  cross-charge sources.
- Exact date boundaries are interpreted in `America/Toronto`, including the
  tested midnight/DST offset boundary.
- Conversion accepts only candidate IDs and selection context; the server
  reloads sources, reloads the active rate graph, recalculates distance and
  cents, freezes immutable snapshots, and then writes cases.
- A multi-band batch retains the correct band and exact cents per physical
  load.
- Exact replay and an independent repeated command converge on one deterministic
  snapshot/case/version/line identity.
- Injected mid-batch failure rolls back snapshots, cross-charge cases, billing
  versions/lines, command receipt, and audit together.
- Successful conversion remains `local_only` with `externalWork: null` and
  creates no NetSuite chain or outbox row.

## Mutation packet

The persisted scoped packet killed regressions for the candidate ceiling,
batch ceiling, distance concurrency, two-address eligibility, immutable snapshot
creation, atomic failure hook, explicitly searched Pick-Up conversion, and
optimistic address revision.

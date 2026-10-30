# Stock exchange validation

Specification: [stock-exchange-spec.md](stock-exchange-spec.md). Tier 3
(inventory movement, quantity reservations, concurrency and external posting).
Spec approval: not obtained (autonomous run); the user confirmed Position for
the SO number. No new dependencies, checkpoint commits or production writes
during implementation validation. Deployment is recorded in
[stock-exchange-deployment.md](stock-exchange-deployment.md).

Reproduce from the repository root:

```sh
bash docker/run-stock-exchange-checks.sh
```

The entry point uses the existing test image and retention runner, fresh
migrations, synthetic data, bounded Compose services and `mbbs-tests.slice`.
It retains no generated logs, coverage, browser output or mutant source copies.

Final fresh run on 2026-10-29: **passed**, source unchanged during validation.
Feature-manifest SHA-256 (paths and contents listed in the runner):
`77f7f41cf3aea8ed234070a77cbbd83591e85941a80dbee5a6319c2cebd5ea7a`.

| Check | Final result |
| --- | --- |
| Exchange acceptance | 25 passed, 0 failed |
| Existing return regressions | 264 passed, 0 failed across 29 files |
| Posting policy and admin gates | 19 passed, 0 failed |
| Reversed acceptance file order | 25 passed, 0 failed |
| Browser | 390px and 1024px passed |
| Lint/complexity, types, edited-file syntax, scoped secret scan | Passed |
| New-module coverage | Lines/statements 298/298 (100%); functions 31/31 (100%); branches 168/183 (91.8%) |
| Manual mutation | 5/5 killed: quantity, reason, month, Position, uncertain retry |
| Properties alone | 4/4 applicable domain mutants killed; two fixed-seed properties, 150 cases each |
| Host test budget | 6/6 configuration checks passed |

Runtime/tool versions: Node v20.20.2, ESLint 10.8.0, TypeScript 7.0.2,
c8 12.0.0, fast-check 4.9.0, Playwright 1.62.1. Mutant failure attribution:
quantity/Position → quantity property; month → exact yard memo test; reason →
invalid-reasons test; retry → unknown-outcome blocking test. Property-only kills
were separately executed, not inferred from the combined suite.

| Specification | Executable evidence |
| --- | --- |
| Three return choices; exchange stays in Quality Issue; drafts and results identify exchanges | Unit menu/draft tests; browser rendering and payload checks at 390px and 1024px; real HTTP submission/history test |
| R1–R5 only, supported yards, positive quantity and sales units, no pallet mixture | Admission rejection test, adversarial domain test, 150 generated valid cases and 150 generated invalid reasons |
| Shared remaining SO-line quantity | Admission pool test, simultaneous return/exchange race, draft/replay/void test, reservation checks after successful and uncertain posting |
| Dedicated IT posting policy; no RA/CM | Monthly and scheduled recovery tests, zero batch-authorizations assertion, existing return and posting-gate regressions |
| Monthly memo, exact quantity, main-to-Return location, units, Reason Code (SO), SO in Position | All-yard/month boundary tests; generated payload properties; REST adapter and complete readback tests; concurrent monthly posting test |
| Safe retries, existing lines preserved, uncertain outcomes cannot release quantity | Lost create/append tests, mismatched readback test, unknown-outcome blocking test, before/after line proof tests |
| Durable checkpoints and migration safety | Outer rollback test; migration replay and rollback; immutable-intent assertion |
| Simultaneous postings remain executable under connection pressure | Ten-request monthly stress test, including a database read in the remote adapter boundary |
| Existing fallback retry fingerprints stay compatible | Legacy fingerprint comparison and distinct exchange identity unit test |

Failures found and resolved: the first admission/posting runs failed before the
implementation existed. Empty exchange drafts initially selected the pallet
editor. The HTTP test originally expected 200 for a new record; it now asserts
the unchanged 201 endpoint contract, documented in the spec amendment. Two
legacy VM tests needed `currentModule` in their fixture (assertions unchanged).
Exact admin catalog expectations gained the three specified exchange gates.
A synthetic test token was renamed to the scanner's synthetic-token convention.
Lint issues were fixed without relaxing rules. A stress test reproduced a
connection timeout; monthly lock waiters now release their connection between
attempts, leaving capacity for the active writer and NetSuite authentication.
The compatibility test then caught `exchange: false` changing legacy fallback
fingerprints; the added identity property is now limited to exchanges.
One complete run passed its checks but failed the source-stability guard after
another workspace task edited return processing; final results use a fresh run
against the updated shared source.
An intermediate run reported 263/264 return regressions; its truncated error
output omitted the failing case. The harness now prints failing cases first.
The unchanged 264-test suite passed on the diagnostic rerun. That transient
failure was not reproduced, so it remains a suite-stability limitation rather
than a claimed bug fix; no assertions were relaxed.

Validation boundaries: NetSuite transport is mocked; production access was
read-only metadata/location inspection. Metadata confirmed `custcol_position`
is a string, `custcol_atlas_rc_so` is a record reference, and Original SO Line is
a checkbox. Active Return child locations resolved to 9 (3445), 39 (2967), and
42 (150). No live Inventory Transfer was created or changed.

Browser checks exercise actual rendering/payload functions with synthetic state,
not a complete authenticated browser journey. The real HTTP test runs the
application against disposable PostgreSQL. Type checking covers the new domain;
lint/complexity checks cover new modules and harnesses; syntax checks cover edited
legacy JavaScript. Coverage is limited to the four new exchange modules, not all
changed legacy application lines. The selected return/gate suites are not the
entire repository suite. Dependency auditing was not repeated because no package
or lockfile changed.

Remote limits: incomplete/paginated readback and manual edits that invalidate
the recorded before/after proof stop posting for reconciliation. Confirmed
transfers are not subsequently reconciled by the existing RA/CM background
reconciler. App locks serialize app writers; they do not lock manual NetSuite
edits. Posting gates default off. Deployment followed the user's later request;
see the deployment record above for the live state.

Final teardown verified: only the four production allowlisted containers appear
in both `docker ps` and `docker ps -a`; no test-project volumes/networks remain;
the disposable artifact directory is empty; production `/health` returned 200.
Before deployment, read-only inspection confirmed the deployed app had neither
the exchange service nor the exchange menu.

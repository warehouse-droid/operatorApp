# Operator receiving: keep the created IR visible

Specification: [receiving-posting-status-spec.md](receiving-posting-status-spec.md).
Spec approval: not obtained (autonomous run). This is a scoped browser correction;
the release contains `operator.js`, `operator.html`, and `service-worker.js`.

## Incident evidence

Read-only production checks matched the local jobs with their existing NetSuite
receipts, including source PO, external ID, and transaction identity:

| PO | Local receiving reference | Existing IR | Current local job |
| --- | --- | --- | --- |
| POB03896 | SN1400935 | IR14757 (1006027) | completed |
| POB03896 | SN1401069 | IR14772 (1007563) | completed |
| POB03903 | POB03903 | IR14775 (1007837) | completed |

POB03903 originally needed attention because its IR included an additional
`SURCHARGE` line: item 3025, source line 12, quantity 1. An earlier reconciliation
at 2026-09-23 13:46 UTC had already finalized that receipt locally. Both POB03896
split receipts were completed on September 22. Their active posting claims were
released. This task did not create or repair any NetSuite receipt.

The browser labelled every submission/polling exception “Receiving failed.” It
discarded the useful job evidence, had no receiving-job journal, and refreshed
the receiving list rather than the open receipt screen after completion events.

## Behavior and acceptance coverage

| Spec | Evidence |
| --- | --- |
| 1: created IR while review is pending | `known IR remains visible...`; browser attention/reload scenario |
| 2: lost response and polling outage | `lost admission response...`, `polling outage...`, authorization-error test; two browser outage scenarios |
| 3: recover completion without another POST | recovery tests and all four browser scenarios: exactly one submission each |
| 4: reload/reopen and account/order isolation | journal replay and isolation tests; actual browser Back/reopen/reload |
| 5: authoritative failure versus review | rejected-admission and failed-job tests; premature-completion mutation |
| 6: stale responses and concurrency | coalesced refresh test, unrelated-job test, late admission/polling response tests |
| 7: success text follows the recorded IR | `successful receipt copy uses recorded evidence...` |
| 8: acknowledgement and existing workflows | journal acknowledgement, photo client, latency, receiving-return, quantity and posting tests |
| 9: untrusted text/storage | escaped reference and unavailable/corrupt storage tests |

Tests first reproduced the reported failure and missing reference. The
authorization-expiry and navigation races were also observed failing before
their fixes. Three existing VM test fixtures were updated to initialize the
real receipt-result state or load the real journal helper; their behavioral
assertions were preserved.

## Verification

Use `bash server/tools/receiving-posting-status-gauntlet.sh` from the repository
root to rerun the isolated verification. It uses the existing Docker test image
`field-sales-check-2941306:latest`, Node v20.20.2 and the installed project tools;
it creates and removes its own isolated PostgreSQL test environment.

Final focused tests: **51 passed, 0 failed**, also run in reverse file order.
Real Chromium checks: **4 scenarios passed, 0 browser errors**, with exactly one
receipt submission per scenario. The scenarios cover review/reload, a lost
submission response, a polling outage with Back/reopen and automatic recovery,
and a receiving-completed event.

Changed executable JavaScript lines: **142/142 exercised**, combining browser
coverage and the actual browser functions executed in the VM. The coverage
manifest is source-hash checked. HTML and service-worker version references are
checked through candidate/browser and served-asset verification.

Manual mutations: **8/8 killed**, using temporary source copies. The property
suite alone killed 4/8; the remaining four cover journal persistence,
submission identity, rejected admission and local-only behavior and are covered
by the corresponding scenario tests. The property suite is not claimed to
cover those separate behaviors.

Syntax checks and the scoped secret scan passed. Static comparison permits no
new lint/type findings over the captured baseline. No packages were installed
or dependencies changed. No database migration, data repair, NetSuite transform,
or quantity update belongs to this release. Migration/rollback rehearsals and
dependency/license audits are therefore not applicable. Production rollback
uses the prior app image.

Full project suite: **3,080 tests; 3,055 passed, 24 failed, 1 skipped**, across
577 files. The baseline had 3,063 tests, 3,038 passed, the same 24 failed tests
in 21 files, and one skipped test. There are **zero new failing tests or files**.
The failures include existing cache-version assertions and unrelated
environment/integration checks. They were retained and recorded, not weakened.

Static results: **26 existing lint findings, 1,278 existing type diagnostics;
zero new findings**. The captured baseline had 26 and 1,300 respectively.

The full-suite and static baseline is recorded in
`receiving-posting-status-baseline.json`. The reproducible source manifest is
`test/support/receiving-posting-status-changes.json`. The release gate, exact
candidate hashes and deployment result are in
`test-artifacts/receiving-posting-status/verification.json` and its `release/`
directory. The live app changed during validation; the release was rebased
onto that newer image, then its exact assets were retested.

Deployment completed at **2026-09-23 20:05:54 UTC**. Image:
`sha256:1449bab351c610855631c03c1946d3a338ff20be85c051c92179d453900105fc`.
All three served assets matched the candidate through both local and public HTTP;
both health endpoints returned 200. The runtime configuration and other services
matched their captured state. The release candidate passed all 17 recovery tests
and all four browser scenarios after rebasing onto the newer live image.

## Operational limits

A created receipt awaiting line review remains explicitly pending local
verification; only the server's completed job produces the completed screen.
Recovery checks use the existing job's GET endpoint. Browser storage restrictions
retain recovery in memory, but persistence across a full browser restart depends
on storage being available. Existing account authentication still governs reads.

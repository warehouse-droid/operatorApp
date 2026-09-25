# Return Authorization workflow evidence

Implemented the approved plan in [the specification](return-ra-workflow-spec.md).
No deployment, production NetSuite write, gate activation, or new dependency was performed.
The earlier order-search optimization request remains cancelled.

## Results

| Check | Observed result |
| --- | --- |
| Focused repository, authenticated HTTP, client and regression tests | 52 passed |
| Existing return repository harness | Passed |
| Changed executable lines in seven server modules | 399/399 covered |
| New domain | 100% lines, 100% functions, 88.23% branches |
| Deliberate faults | 6/6 killed; reason/quota mutants also killed by properties alone |
| Chromium | 5 passed: posting on/off at 390px and 1024px; all 20 Admin gate cells |
| Types | 240 existing diagnostics before and 240 after; zero new; new domain passes strict check |
| Lint | 2204 existing diagnostics before and 2202 after; zero new |
| Secrets | No findings in the scanned affected runtime sources |
| Suite order | New tests passed again in seed-91726 file order |
| Full suite | 510/511 files pass; the one pre-existing infrastructure assertion remains |

The remaining full-suite assertion is:
`dispatch-unpacked-split.spec.js must use the shared worker-scoped E2E fixture.`
It also failed in the preserved starting workspace. The initial baseline run had two
additional schema failures because its copied contracts directory was missing;
restoring those unchanged fixtures produced 8/8 passing contract tests. Existing
standalone Operator/portal UI harnesses also have stale CSS/asset assertions in the
baseline; they are recorded separately from the main suite and were not weakened.

## Behavior-to-evidence mapping

| Spec | Evidence |
| --- | --- |
| G1/G2 | Eight off-by-default RA policies; all yards and global ceiling; Admin revision/replay checks; stale/missing/wrong-yard tokens; no later posting of local-only records |
| V1 | Actual confirmation accepts formerly approval-required stock; rejects prohibited items, missing photos and excess quantities; legacy approvals and direct PALLET Credit Memos retained |
| R1/R2 | Two reasons on one SO line remain distinct in one stock RA; standalone PALLET RA at $40 and GD; combined confirmation creates two records/two RAs |
| R3 | Exact customer, yard, source SO, external/internal ID, item, units, rate, quantity and reason checks; mismatches preserve the discovered ID; manual linking and reconciliation tested |
| D1 | Parallel first attempts/retries, twelve simultaneous retries exceeding the database pool size, lost responses, local transaction rollback, empty recovery lookup, duplicate external IDs, no-Location recovery and definite rejection retry |
| Q1 | Partial/multiple/deduplicated linked PALLET credits; only observed Credit Memos release reservation; uncertain creation cannot be voided |
| U1 | Review waits for both captured policies; stale yard response rejected; result distinguishes local/pending/failed/verified RA; financial/recovery details remain private |
| N1 | Migration defaults old records to version 1 and new gates off; no production commands or order-search optimization included |

Tests live in `test/mbt/unit/return-ra-*.test.js` and
`test/mbt/integration/return-ra-workflow.test.js`. Browser assertions use the actual
rendering and confirmation functions in Chromium with fixture data. They do not
exercise camera hardware or a live mobile device. Numeric coverage above is for
server modules; UI behavior is checked separately by VM and browser tests.

## Reproduce

From the repository root, run:

```sh
bash server/tools/return-ra-gauntlet.sh
```

Uses existing Docker images `mbbs-retired-confirm-test:20260914`,
`mbbs-mbt-p1-test-e2e:latest`, and `postgres:18-alpine`; Node v20.20.2.
The runner creates disposable internal networks/databases and replaces NetSuite
and photo-storage boundaries with test fixtures. Logs, screenshots, source hashes,
coverage and mutation output are in `server/test-artifacts/return-ra-workflow/`.
`test/support/return-ra-baseline.patch` restores the task's starting code for
lint/type comparison without discarding unrelated workspace changes.

Runtime source-state fingerprint: `c59a44cee3fb95abc794d94ebbebb7b46e9c6f183962fac28c98642d6f65f042`.

## Release prerequisite still outstanding

No designated NetSuite sandbox account/test Sales Order was supplied, so no live
round trip was attempted. Keep all eight new gates off until sandbox readback
proves that this account preserves two distinct reason-coded item rows from one
SO source line in a single RA, including quantities, units and rates, and accepts
the standalone PALLET RA. Mocked REST tests cannot establish account-specific
transform behavior, custom-form requirements or permissions. The implementation
rejects a merged/mismatched readback and retains its ID for recovery.

Oracle documents the [Return Authorization REST record](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_0718011926.html)
and [standalone return authorizations](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N1305354.html).
These describe the supported record operations; they do not prove split-source-line
behavior for this account.

During implementation, the new behavioral tests first failed for the missing
workflow and UI behavior. Expanded tests also found an existing stock-line INSERT
placeholder mismatch, now fixed. A trial mutation deleting the in-memory retry
guard survived because the durable checkpoint independently blocked a duplicate;
the final mutation removes that durable marker and is killed. Exact gate catalogs,
migration counts and cache-version contracts were extended to the new release,
while retaining their strict assertions.
An additional concurrency test reproduced connection exhaustion before the
pre-transaction admission limit was added; all twelve retries then completed.

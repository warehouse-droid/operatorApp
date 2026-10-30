# Office purchase-order action and Control approvals — 2026-10-29

Tier 3: financial authority, quote changes and purchasing safeguards.
Specification: `test/repair/spec.md`, criteria 62–64.
Spec approval: not obtained (autonomous run). No dependencies, commits or schema changes.

Deployed at **14:08:19 UTC** to the existing application host. Office request
details now expose **Add purchase order** in Parts, purchase orders & usage.
An unapproved job shows the button disabled with its approval destination;
approved jobs open the local PO form with outstanding Team parts selected.
Control has a separate **Repair approvals** button for assigned-yard company
forklift/loader quotes. Receipt assignment remains separate.

## Acceptance and failure-model mapping

| Behavior / failure mode | Evidence |
| --- | --- |
| Office PO action is visible before approval and enabled after approval; requested parts, vendor, cost and ETA are saved locally | `control-po.test.js`: Office Add purchase order browser flow; existing Office purchase and job-flow browser suites |
| Control exposes only pending forklift/loader quotes in the manager's assigned yards | Pending approval API case; denied Operator, Driver, Office-only and Technician cases; queue authority mutant |
| Independent job quotes show scope, quantities, prices, taxes and totals; approve/decline directly in Control | Actual approval-panel module in a browser Control toolbar host with real repository/API; production HTML wiring assertion and live HTTP/hash checks |
| Approving one job does not change another; declining requires a reason | Two-job browser case; cross-form Approve all mutant |
| Revised quotes cannot be approved through stale submissions | Quote revision API case, superseded-quote mutant, existing audited decision/replay regressions |
| Close/reopen and refresh preserve the correct dialog and pending drafts | Immediate close/reopen browser case and dialog-close mutant |
| Multiple local POs, quantity limits, Team receipt, invoice and one NetSuite Bill remain guarded | Existing purchase, multi-job, replay, stock-conservation and property suites; early-PO mutant |
| Requester privacy and role-specific screens survive | Existing requester privacy, assignment, PWA, receipt and mixed-authority suites |
| No live financial decisions or purchases during deployment | Read-only production transaction confirmed two pending Control quotes and zero linked purchases for REP-0000002 |

## Final fresh validation

From `server`, rerun the complete captured-candidate checks with:

```sh
sudo -n python3 tools/repair-control-po-release.py validate
```

The release helper uses the repository's bounded disposable runner. Candidate
source, the scoped patch and file hashes are operational release records under
the latest-five-copy retention policy. No Git checkpoint was created; source
hashes identify the captured state independently of concurrent workspace changes.

Repair tree hash:
`5ea59cc632bc8d66811bea35004519f30ce69a8e7cbad725031f0fbcb094f465`.
Integration hash:
`9e3fe24e10cb7db2620d4a02783d051015cd2423169b6d902639a9e71d983762`.

- Normal, instrumented and reversed-order Repair runs: **143/143 passed each**.
- Related regression tests: **40/40 passed** across nine isolated files.
- Shared login/menu/notification browser checks: passed.
- Changed instrumented backend lines: **15/15 covered** (quotes 14, router 1).
- Overall instrumented statements/lines: **93.32%**; branches: **83.8%**. Complete branch coverage is not claimed. Browser assets are exercised by browser workflows rather than Node instrumentation.
- Manual mutations: **43/43 caught**, including all five new authority, superseded-quote, purchasing and dialog/form faults. Four selected existing mutants were also caught by property tests alone.
- ESLint, TypeScript, server syntax and scoped secret scan: passed.
- Existing unchanged baseline: `S11: the guarded client ships in a new atomic Driver shell generation`; the other three asset-contract checks passed. No new failures.

Tools: Node 20.20.2; ESLint 10.8.0; TypeScript 7.0.2; c8 12.0.0;
fast-check 4.9.0; Playwright 1.62.1. The dependency set is unchanged, so a new
dependency audit was not needed. Existing seeded properties cover authority,
quote payloads, rounding, replay and stock conservation. No production
credentials or data volumes were used by disposable tests.

The three new tests failed before implementation. A later browser run caught a
close event removing a newly reopened approval dialog; the handler now removes
its own dialog. A test-only lint correction changed variable declarations with
assertions intact. The final full run followed the last source edit.

## Release, cleanup and limits

Image: `mbbs-operator-app:repair-control-po-20261029`.
Image ID: `sha256:4c20b20b2514a7b8e02e6e8bdb35f63751518de7a3843cf8f51c71730ae4e11d`.
Live verification: **26 scoped file hashes**, **22 local/public HTTP checks**,
healthy application, preserved configuration and other production services.
A rollback image is retained. No migration was required.

A read-only production transaction verified that **REP-0000002-J01 version 2**
and **REP-0000002-J02 version 1** both appear in the assigned-yard Control
approval queue and remain pending. The request has zero linked purchase orders.
NetSuite posting remains disabled, as before deployment. No live quote decision,
purchase, authority change or NetSuite financial write was performed.

Browser checks use Chromium and a minimal Control toolbar host for the new panel;
they do not claim a manual authenticated session through every Control feature.
Existing shared-shell regressions and live static-file verification cover the
integration boundaries. The recorded S11 baseline remains outside this scope.

After teardown, both `docker ps` and `docker ps -a` contained only the four
production containers. No Repair test containers, disposable database volumes or
test networks remain. The outer disposable runner removed raw logs, media,
coverage and mutation copies. Only concise source evidence and operational
release/rollback records are retained.

Operational records: `deployments/repair-control-po-20261029/`:
`prepared.json`, `validation.json`, `built.json`, `deployment.json`,
`live-verification.json`, `post-deploy-audit.json` and release/rollback manifests.

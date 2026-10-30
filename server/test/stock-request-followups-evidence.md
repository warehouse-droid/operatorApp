# Stock request followups — verification evidence

Spec: [stock-request-followups-spec.md](stock-request-followups-spec.md).
Spec approval: not obtained (autonomous run). Tier 3. No new dependencies.

Reproduce from the repository with `bash docker/run-stock-request-followups-checks.sh`.
The final run is identified by `server/deployments/stock-request-followups-20261027/validation.json`:
2026-10-27T15:38:49.487Z. It records all 23 released source hashes, test/tool hashes and
exact toolchain versions. No source, test or tool drift occurred during this run.

- Relevant regression suites: 240 tests in 39 files;
  223 passed, 17 unchanged baseline failures,
  0 new failures. The baseline failures were reproduced on
  unchanged captured live source using `bash docker/run-stock-request-followups-baseline.sh`.
  Their exact names are retained in `tools/stock-request-followups-baseline.json`.
  They concern earlier Pending PO/Already Ordered expectations, notification modal
  interference, and obsolete reply selectors. No failed assertions were skipped.
- Focused reverse-order suites: 22/22 passed.
- Changed executable lines: 199/199; changed branches:
  262/273. All changed JavaScript measured.
- Syntax for 23 files, strict type checks, lint, complexity and diff secrets:
  zero new findings. Package and lockfile unchanged; dependency audit not rerun.
- Four intentional faults killed in the regression suite and independently in
  the property suite: expired rejection blocked, hardcoded one pallet, skipped
  yard completion, and SO-linked lines left pending. 8/8 executions killed.
- Generated properties cover unit conversion/rounding and transactional request
  decisions. Real HTTP/browser checks cover manual SCM actions, permissions,
  stale revisions, partial batches, concurrent completion versus PO linking,
  canonical SO rollback, subsequent SCM review, and Toronto summer/winter times
  on Tokyo/Honolulu devices. PDF fetches use a network-boundary fixture; actual
  NetSuite PDF availability is not claimed by these tests.

| Behavior | Executable checks |
| --- | --- |
| Reject expired unused approval, preserving expiry | stock-request-followups.test.js, guards, view-controls |
| Expected quantity and explicit unknown conversion | stock-request-followups.test.js, browser, property; stock-check-lines.test.js |
| Manual Stocking/Purchase and Backorder completion; no purchase/transfer | core, guards, view-controls and browser suites |
| Completed case-stage filters for Sales and SCM | Backorder manual completion core test, with and without unified status |
| SO link implies customer acceptance, with rollback | core, guards and backorder-review-flow suites |
| Inline in-app previews; Sales has no PO button | stock-request-followups-browser.test.js |
| Toronto History timestamps, independent of device/DST | followups-browser, view-controls, ui-toronto-timestamp and existing history suites |

Early runs exposed a stale fingerprint when original quantity changed, and the
Closed/Completed case-stage mismatch for yard completion. Both were reproduced
and fixed before this final run. Test fixtures were corrected to satisfy paired
PO identity constraints and the existing HTTP 202 stock-queue contract. Review-flow
assertions were explicitly updated in the append-only spec for SO acceptance.

The release is deployed as `mbbs-operator-app:stock-request-followups-20261027`.
All released hashes and application health verified; existing configuration,
database and other service containers preserved. No migration was needed.
The earlier receipt-refresh release remains present, including every server
receipt hook and unchanged receipt queue/repository modules.

Live audit: STREQ-000163 is completed; STREQ-000079 retains
its expired unused approval and now has the SCM rejection control. STREQ-000166's
existing SOA10895 link was applied as customer acceptance using the normal
transactional action with a system actor. Both materials now show accepted and
both stock-check quantities are 20 PLT. No manual yard-stock completion was
applied to a live request on the user's behalf.

Operational audits: `streq166-acceptance-audit.json`, `stock-requests-live-audit.json`,
`stock-requests-http-audit.json`, `live-verification.json` and `deployment.json`
in the release directory. Bounded disposable tests used mbbs-tests.slice and
removed containers, volumes, networks, logs and generated artifacts on completion,
failure and interruption. Both container listings and live health were verified.

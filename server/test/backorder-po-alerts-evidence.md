# Already Ordered PO progress alerts — 2026-10-27

Already Ordered backorder materials now project the current canonical PO `dispatch_ref` and show `PO number / PO reference` in Sales and SCM. An existing manually entered reference remains a display fallback; it does not create a live-reference alert. No PO, allocation, receipt or historic review data is rewritten.

The requesting Sales user receives independent unread notices when the PO reference is available and when the PO is assigned to a non-cancelled dispatch plan. Completed backorder workflows remain eligible. Planning works before a reference exists and follows native references, dispatch references, grouped pickups and split orders. Each planned line also shows the plan date.

Opening the request acknowledges only the displayed PO update identities. Reference changes and new plan/date identities can alert again; repeated reads, case-only reference changes, sync timestamps and ETA/truck changes do not repeat acknowledged notices. The existing full-receipt arrival notification remains independent. Scope follows the requester and request destination yard, including replenishment POs routed through another yard. Unknown, ambiguous, inactive, cancelled, removed and closed evidence does not produce PO progress alerts.

Validation: 32 passing integration/browser checks across seven suites, recorded in `backorder-po-alerts-evidence.json`. Checks cover blank-to-present references, planning before references, grouped/split/aliased planning, multiple POs, saved-reference fallback, durable acknowledgment, stale/invalid acknowledgment, requester/yard scope, completed requests, Sales/SCM display, escaping, mobile layout and existing arrival/review behavior. Initial schema/test-fixture assumptions were corrected before deployment. The browser lifecycle test closes each context between stages to stay within the host resource limits. Two older browser assertions were narrowed to backorder action forms, excluding the existing conversation composer.

Reproduce with the bounded disposable runner:

```sh
DISPATCH_SOURCE_SKIP_BUILD=1 \
DISPATCH_SOURCE_RUNTIME="$PWD/server/deployments/backorder-po-alerts-20261027/candidate" \
DISPATCH_SOURCE_MIGRATIONS="$PWD/server/deployments/backorder-po-alerts-20261027/candidate/migrations" \
python3 docker/retention/retention.py run --root /tmp/mbbs-backorder-po-alerts -- \
  bash docker/run-dispatch-source-tests.sh node tools/backorder-po-alerts-checks.mjs
```

A concurrent repair release changed eight unrelated files during the initial build. The release guard stopped before deployment. The candidate was rebased over that release with no overlapping files, and all nine PO progress/arrival integration and browser checks passed again.

Every run used the standard isolated Compose limits and `mbbs-tests.slice`. Teardown removed the test containers, cloned databases, networks and generated artifacts, including failed runs. Final running/all container listings showed only the four production services, with application health passing. Deployment and rollback records are retained separately under `server/deployments/backorder-po-alerts-20261027`.

Deployed at 2026-10-27T18:28:05.378985+00:00. All 1,563 runtime file hashes matched the candidate; runtime configuration and dependency containers were preserved. Read-only live verification of STREQ-000198 / POB04147 confirmed the PO reference is blank and the PO is not planned. The line and alert projections agree with that live state. No production PO/reference/plan data was fabricated for verification.

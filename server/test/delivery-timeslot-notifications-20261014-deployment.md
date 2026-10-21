# Delivery timeslot, trip and notification deployment

Deployed on October 14, 2026 at 16:51 UTC following the user's explicit “deploy”
instruction. The live image is
`mbbs-operator-app:delivery-timeslot-notifications-20261014`, image ID
`sha256:01d052597575920eee9e90090e86f6f50e7205ec1f2e0259e6a273f5d76bd112`.
The validated runtime tree SHA-256 is
`ed51838de6eb402a9c5b4ea96afd649ebe9ca231af128559c6c2e2d3475719b3`.

The release adds Dispatch counter-proposals for secured delivery timeslots,
Single/Round/Multi-stop trip entry and pricing, and shared staff OS notifications
while MBBS is open. Round-trip returns cost one truck trip; multi-stop routes
begin and end at MBBS yards. Staff refresh MBBS, click **Enable OS notifications**,
and allow the browser permission prompt to enable OS alerts, including in
background tabs.

Only the application container was restarted. The database, webhook worker and
Ollama containers retain their captured IDs, images and settings. Environment,
command, mounts and application settings are preserved. No migration or
production test request was introduced. The prior live image is retained as
`mbbs-operator-app:delivery-timeslot-notifications-20261014-rollback`, with an
image-only rollback Compose override in the deployment directory.

| Check | Actual result |
| --- | --- |
| Release scope | 11 runtime files changed; 1,372 other runtime files preserved |
| Exact candidate regression | 228 tests: 226 passed, two unchanged baseline stock failures, no skipped tests; types and lint passed |
| Mutations / properties | 8/8 selected mutations detected and restored; three relevant mutants independently detected by property tests |
| Backend coverage | 972/972 lines/statements, 128/129 functions, 645/696 branches |
| Built image / live source | Application import passed in a bounded disposable container; all 1,383 live runtime files match the validated candidate |
| Local and public HTTP | Both `/health` endpoints return 200/ok; all nine changed public assets match their SHA-256 hashes; Sales/Dispatch pages reference the new asset version |
| Notification assets | Module and dedicated worker return 200 with JavaScript content type on both origins |
| Access protection | Anonymous Sales/Dispatch delivery metadata requests return 401 on both origins |
| Cutover preflight | No active operations or idle open transactions in the checked workflows; no active Dispatch edit leases before or after restart |
| Cleanup | Compose down with volumes/orphans completed; manual image checks removed; both Docker running/all-container lists contain only the four production containers; no task test networks/volumes remain; production health passes |

The first candidate was invalidated before cutover when another live release
updated `public/mbr/customer.js` and `public/mbr/sign.html`. Neither overlapped
this feature. The release was recaptured from the new live image and the full
scoped validation rerun, preserving those customer-signing updates. Reading an
older root-owned Compose override initially required restoring the established
privileged Compose invocation; the configuration checks then passed. Live
cutover occurred only after these checks completed.

The two stock failures remain the original ETA-related browser JavaScript error
and Closed-queue filtering assertion, described in the
[feature verification](delivery-timeslot-notifications-20261014-evidence.md).
Their exact names and unchanged test-source hashes are recorded by the baseline
gate; they were neither skipped nor repaired as part of this release.

The persisted release tool is
`server/tools/delivery-timeslot-notifications-release.py` with capture, rebase,
validate, build, apply and verify phases. The standard isolated harness registers
teardown before tests and applies `mbbs-tests.slice` and bounded container limits.
Read-only deployment verification can be repeated with:

```sh
python3 server/tools/delivery-timeslot-notifications-release.py verify
```

Manifest, baseline/candidate snapshots, image/import/configuration checks,
preflight, publish log, rollback override and deployment results are in
`server/deployments/delivery-timeslot-notifications-20261014/`.
Exact release test and teardown logs are in
`server/test-artifacts/delivery-timeslot-notifications-20261014/release-final/`.
Earlier attempt logs, predeployment hashes and final production cleanup/health
checks are retained under the task artifact directory. No disposable database or
browser profile is retained.

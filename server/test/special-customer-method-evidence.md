# PO-arrival delivery choices and fulfilled-SO lock — evidence

Final specification: after PO arrival, unfulfilled Special requests allow only Pickup at inquired yard or Delivery. Fulfilled SOs remain locked. The user explicitly authorized the local pickup correction and reconciliation of SPREQ-000080. See the correction section in [the specification](special-customer-method-spec.md); the earlier proposed exception allowing fulfilled-order header edits was reverted and never deployed.

Reproduce: `sudo -n bash docker/run-special-customer-method-checks.sh gauntlet`. The runner captures current live source and applies only this task's delta. Base image `sha256:34e3be4bc749d13303a482b9b7b69585cd22db4ab0deb7d5c984a12e441b95a7` and the five candidate SHA-256 hashes are recorded in `server/deployments/special-customer-method-20261027/verified.json`. No dependencies, migrations, or commits.

Final fresh run: **104 passing tests, 2 unchanged baseline failures, zero new failures** across ten targeted files. The 25 focused tests passed again after mutation restoration. Types: 839 existing diagnostics before and 839 after, zero new; ESLint: 29 before and 29 after, zero new. Changed executable lines: **32/32**; the logistics change deletes the overbroad PO references and is covered by the inbound-PO integration case. HTML versioning is asserted and exercised by Playwright.

| Final requirement | Evidence | Result |
| --- | --- | --- |
| An arrived supplier PO does not lock unfulfilled customer fulfillment | Completed inbound PO with no SO assignment; yard-pickup/delivery round trip; preserved commercial data and plan snapshot | Pass |
| Only yard pickup and Delivery after receipt or physical arrival | 60 generated arrival/method combinations; separate receipt and driver evidence integration cases; desktop/mobile dropdown assertions | Pass |
| Vendor pickup rejected on save, retry and completion | Invalid target before journaling and arrival between claim/finalization | Pass |
| Fulfilled SO locks a stale local arrangement | Pending Billing/Fully Fulfilled/Billed UI cases and backend pre-journal rejection | Pass |
| Existing rights, revisions, recovery, alerts and pricing remain protected | Existing HTTP, fulfillment adapter, status-following and notification regressions | Pass apart from the two unchanged header-note failures below |
| Completed pickup has no dropdown | Playwright at 390px and 1440px | Pass |

Manual mutation: **3/3 killed** — allowing vendor pickup after arrival, ignoring fulfilled SO status, and skipping server arrival validation. UI suite alone kills 2/3; the integration suite detects the server-only fault. Two property tests run 60 examples each (seeds 20261027 and 20261028); file order seed 20261027. Tests run serially against fresh databases, and candidate hashes are checked after restoration.

The unchanged failures are in `special-header-note-http.test.js`: the legacy `operationally_complete=true` header-save assertion expects 409 but gets 200; the issued Note-only terminal-state assertion reports a missing rejection. These existed before this task and were matched by name, error and count. The NetSuite adjustment/fulfillment adapters were restored byte-for-byte and retain their strict unfulfilled-order restrictions.

SPREQ-000080 repair: fresh read-only NetSuite progress showed SOA10517 / line 5155457 fully fulfilled, 135.39 of 135.39 SQFT. A revision-guarded local transaction changed only the request method from Delivery to Pickup at inquired yard, recorded an audit event and ran the existing Special reconciliation. Revision 14 is Completed, operationally complete and not editable. Canonical SO/PO headers, source lines and request lines were checked unchanged. NetSuite writes: zero. Receipt: `repair-000080-result.json` in the release directory.

The shared five-minute polling job for active linked non-delivery SOs is a recommendation, not an installed schedule. Special read routes already refresh stale NetSuite status headers; Regular Stock list/detail routes read local state. A shared scheduled poll should fetch status and fulfillment progress, reconcile both request types, and retain the last verified state if NetSuite is unavailable.

The full repository suite, dependency audit and performance/version matrices were not run; no dependencies changed. Test containers, disposable databases, networks and temporary coverage/browser artifacts are removed by the bounded lifecycle runner. Exact tool versions and final release/cleanup receipts are in the release records.

Deployment completed at 2026-10-27 23:04 UTC using image `sha256:589746c2dfb783d240a7b117d4f2f41c7bf352138580ad4d5a8f2e6c943d35cf`. All five deployed source hashes match the isolated validation. App configuration and the three dependency containers are unchanged; health and versioned public assets return 200. A read-only production check confirms SPREQ-000080 remains yard pickup, Completed, operationally complete and not editable. Release and rollback overrides are retained with the operational receipt.

Final cleanup checked both running and stopped containers: this task has zero test containers, volumes or networks, and its unique test artifact directory was removed. One separately active disposable project (`mbbs-disposable-3073121`) and its run directory were left to their owning task. Production remains healthy. Superseded/raw test reports were removed after retaining the concise evidence and release validation records.

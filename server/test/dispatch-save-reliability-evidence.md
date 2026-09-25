# Dispatch save reliability evidence

Tier 3: save integrity, concurrency and recovery. The implementation spec was approved; the user subsequently clarified that 500 ms applies to responsive actions while saving asynchronously, and explicitly authorized deployment after testing.

Release gate: **PASS**. Source state: `6fbc8b89352639826a2ccab3edd15aae740bd2f2a1ce93f518edde27aa892571`.

Deployment: completed and verified.

The false-warning defect came from comparing a persisted plan with a fingerprint influenced by read-time order enrichment. All paths now fence the raw stored revision and digest. Commit-time lease checks, atomic receipts, serialized browser operations, immutable retries and generation guards protect the save. Bounded asynchronous IndexedDB retains recoverable drafts. A separate replayed split/group identity defect was fixed without treating aliases as order identities.

| Gate | Result | Evidence |
|---|---|---|
| focused | PASS | 6 mutations killed; 6 killed by properties alone |
| stress | PASS | 10000 saves; 0 races; 13.1 minutes |
| races | PASS | 667 saves; 1000 races; 2.0 minutes |
| soak | PASS | 5774 saves; 138 races; 60.0 minutes |
| history | PASS | 2558 retained states; outcomes {'rejected': 2140, 'committed_and_rolled_back': 418}; 0 unexpected failures |
| sourceHistory | PASS | 2558 retained states; 2505 simulated source updates; 2502 observed refreshes; hidden by current closed-order rules: {'NETSUITE_ORDER_CLOSED': 3} |
| sourceBrowser | PASS | chromium: maximum tested action 73.4 ms; webkit: maximum tested action 147.5 ms |
| playwright | PASS | chromium: maximum tested action 73.5 ms; webkit: maximum tested action 81.3 ms |
| journal | PASS | Chromium and WebKit: actual storage / lost-response recovery |
| snapshotBrowser | PASS | Chromium and WebKit: actual storage / lost-response recovery |
| complexity | PASS | New named helpers checked against 80-line / 24-decision budgets |
| rollback | PASS | Previous runtime reads the newly acknowledged plan; no schema changes |
| suiteHealth | PASS | Cancellation-first legacy assertion reproduced in both versions; persisted safety invariant checked in 20/20 runs |
| performance | PASS | Matched Chromium/WebKit startup, edit and save samples; all prior pairs retained |
| full | PASS | 1 baseline failing cases; 1 candidate; 0 new |
| adjacent | PASS | 12 baseline failing cases; 8 candidate; 0 new |
| static | PASS | lint 1981 → 1965; types 240 → 240; zero new diagnostics required |
| secrets | PASS | 0 findings |
| coverage | PASS | 758 changed executable lines; 0 uncovered |
| inventory | PASS | No new dependencies; package manifests match the live baseline; tool versions recorded |

Browser comparison: 3 matched round(s); all samples included. Values are baseline → candidate in milliseconds. First navigation is the mean across 16 independent launches; its paired median change must also show no increase.

| Engine | First navigation | Repeated navigation median | Edit p95 | Save p95 |
|---|---:|---:|---:|---:|
| chromium | 431.8 → 419.4 | 333.5 → 316.3 | 964.6 → 315.2 | 1119.6 → 620.7 |
| webkit | 1476.7 → 1417.4 | 1226.0 → 440.0 | 762.0 → 470.0 | 1046.9 → 702.4 |

Acceptance mapping: persisted fences → SAVE-01/02/05/13/18 and digest compatibility properties; edit ownership → SAVE-03/04/06/12/14/15 plus deterministic races; atomic retry/lifecycle → SAVE-07–11/16/17/19 and both real-browser recovery flows; newer-edit preservation → SAVE-UI-05/07–10/13/20/26/29 and the delayed-ack Playwright scenario; durable bounded recovery → SAVE-UI-11/16–18/23–24 plus real IndexedDB reload/quota/owner cases; source updates → SAVE-01/20/21 and source-browser/history simulation; performance → SAVE-UI-30–41 and matched browser samples and the 500 ms held-save action gate; stress → 10,000 HTTP saves, 1,000 race schedules, 10,000 generated action sequences and the one-hour soak.

The main project suite contains 505 isolated test files. The adjacent suite contains 62 candidate files and 55 baseline files; new behavior tests are additional candidate cases. A full-suite baseline infrastructure assertion and legacy adjacent failures remain visible. The CO cancellation test assumes exactly one successful promise, while existing behavior also allows cancellation followed by a successful save that scrubs the cancelled CO. Its unchanged assertion fails on both versions under cancellation-first scheduling; neither leaves a cancelled CO planned.

History scope: every retained captured row is checksum/round-trip verified. Replays reconstruct retained snapshots and slim command results against captured supporting data. Original command requests, complete historical source versions, and executable payloads for every audit event are unavailable. Expected current-source business rejections are classified separately from committed-and-rolled-back cases. Source-update events are explicitly simulated through the real source-reconciliation path; they are not represented as recovered chronological events.

Browser limits: save, lease, bootstrap and lifecycle requests reach a real isolated server/database. Catalog/setup/map/forecast boundaries use deterministic fixtures. The 500 ms gate covers measured actions during delayed saves; backend history latency is recorded separately. The 1,000-catalog comparison also contains pre-existing expensive rendering and does not establish that every possible planning-page action takes less than 500 ms.

Verification is reproducible with `bash server/tools/dispatch-save-gauntlet.sh release`, supplying the preserved baseline and private history corpus. It never falls back to a live database. `pr` and `full` modes support public CI without the private corpus. Release is separately gated by `python3 server/tools/dispatch-save-deploy.py check`; `prepare` builds/smokes the narrow overlay, `apply` rechecks all gates and rolls back on failed live verification. The worker and database containers are preserved. No new dependencies or commits were introduced.

Detailed machine evidence and timing samples: [evidence.json](../test-artifacts/dispatch-save-reliability/evidence.json). Approved contract and visible harness corrections: [spec](dispatch-save-reliability-spec.md).

Deployed image: `mbbs-operator-app:dispatch-save-reliability-20260917-v5`. Read-only verification: `{'readOnly': True, 'plansChecked': 114, 'fenceMismatches': []}`.

Post-deployment check at 2026-09-17T09:13:35.325639+00:00: healthy=True; restarts=0; unclassified startup errors=0. Printer-agent authentication rejections observed: 29. Printer-agent requests returned HTTP 401 for invalid or disabled credentials. The printer authentication helpers, lease route and repository match the previously deployed runtime; deployment verification confirmed unchanged environment.

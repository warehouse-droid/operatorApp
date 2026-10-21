# Special queue, yard access and SO PDF evidence

Spec approval: not obtained (autonomous run). The behavior and evidence were authored by the same agent; this is layered verification, not independent specification approval.

Deployed application and worker image: `sha256:9389031c73e0e11b3d4456b9697119f257fb715c9f87706ae0bda0110e2d614d`. Verified source manifest SHA-256: `13bf126dcb14fe95e8be3673883d1193d3e0426c82b2a6e57cee9ce998a21d52`. The user's NetSuite upload installed PDF RESTlet 3.2.2; subsequent live native SO rendering succeeded. No schema or dependency changes. Application configuration and dependency containers are unchanged. SPREQ-000006 and SPREQ-000007 business hashes were unchanged by the release; this task made no NetSuite order writes.

## Acceptance results

| Behavior | Executable evidence | Result |
| --- | --- | --- |
| Sales sees only assigned yards; SCM sees all, with intersecting yard filters | `special-workflow-queue-access.test.js`; authenticated `special-workflow-pricing-http.test.js`; live checks | Pass, including spoofed audience/authorization query parameters, empty yard access, forbidden detail/PDF access and Sales PO denial |
| Bounded batch reads preserve full case DTOs, cost privacy and closure priority | Repository integration suite; `special-workflow-queue-timing.py` | Pass; live before/after DTO hashes identical, eight queue SQL reads independent of case count |
| Accurate Dispatch planning after narrower JSON projection | Nested/split/CO/return-only integration cases; live comparison | All 2811 planned references across 114 plans identical; no expiry-based cache |
| Special first/default, explicit Regular links still work; yard labels/options | `special-workflow-queue-browser.mjs` | Sales and SCM pass at 1440px and 390px |
| Immediate card selection; no duplicate detail fetch; quiet event refresh; unsaved edits retained | Browser checks and `special-workflow-queue.test.js` | Pass, including reversed responses, coalescing, invalidated in-flight reads, offline recovery, tab switching and edits during events |
| Native SO and PO previews and existing local PDF caching | Native PDF unit/harness/HTTP suite and live service checks | SOB121380 rendered for Sales and SCM after upload; repeated SO and POB03934 PO previews are cache hits; Sales PO access returns 403 |
| Existing commercial workflow behavior | Entire Special workflow test set | 292/292 pass |

Live post-deployment queue timings: Sales 1252 ms and SCM 1163 ms for eight cases. The earlier deployed reads measured 2.2–2.7 seconds; the additional selected-case request has also been removed. These are server observations, not a network/browser latency guarantee. Three public page/module checks returned HTTP 200 with the new assets.

## Verification

Reproduce the isolated gauntlet with `bash server/tools/special-workflow-queue-check.sh`. It requires the existing isolated review runner/database and uses no production writes.

- 292/292 related tests pass. Reversed focused suite passes.
- Changed executable lines: 310/310; observed changed branches: 91/117. Uncovered branches are enumerated in `changed-lines.json`; no claim of complete branch coverage.
- Strict TypeScript check on the new queue controller; syntax checks and scoped ESLint pass. The large existing `server.js` has 27 baseline lint findings, identical before/after; zero new findings. Full-server typing was not introduced for this one-line route change.
- Three meaningful mutants killed by contract tests and separately by the property tests: stale response wins, unrelated-order matching inverted, yard filter removed.
- Native SuiteScript harness and desktop/mobile browser checks pass. Diff secret scan passes. No supply-chain audit was needed because dependencies did not change.
- Tool versions: node v20.20.2, typescript 7.0.2, eslint 10.8.0, c8 12.0.0, fast-check 4.9.0.

Initial tests reproduced the absent yard filter and N+1 reads. Browser recovery testing found a stale error message after a successful unchanged retry; it was corrected and covered. An event during an in-flight read now discards that obsolete response before applying the newer result. The initial PDF harness used an old copied script; synchronizing the isolated runner resolved that test setup issue. The public host denied Python's default user agent; the browser-style requests returned 200.

The PDF record-load failure is consistent with NetSuite's documented [workflow record lock behavior](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N2743672.html). The replacement still verifies typed, role-visible transaction identity and uses native `render.transaction`; order creation/edits/closure continue through REST Record API.

Private artifacts: `server/test-artifacts/special-workflow-review/queue-access/` (test logs, source hashes, coverage, screenshots, timing and live results). Release and rollback records: `server/test-artifacts/special-workflow-queue-access-release-20260926/`. Scoped deployment entry point: `python3 server/tools/special-workflow-queue-deploy.py prepare|apply|verify`. The live read-only script is `server/tools/special-workflow-queue-live.mjs` (run in the application container; PDF reads may fill the cache).

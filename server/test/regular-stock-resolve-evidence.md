Stocking Resolve is deployed at 2026-10-02T03:18:52.054435+00:00.

SCM can resolve an open regular Stocking request, for Transfer or Purchase, by replying with an existing PO number and ETA date. The saved reply closes the case, appears in SCM Closed and Sales Completed, and creates one unread Sales decision. The notice belongs to the requesting Sales user and clears when that user opens the reply. Retries do not add events or reappear after acknowledgement. Other unread decisions can keep the Sales badge visible; SCM's badge counts pending review work.

Only an exact, uniquely identified active PO in the local mirror is accepted, ignoring case and surrounding whitespace. The transaction stores its canonical identity, date, actor and time, preserves quantities and units, and updates the case, lines and decision event together. No PO or TO is created or updated and no NetSuite call is made. Existing transfers, handoffs and any Purchase demand block Resolve to avoid abandoning work or allowing allocation reconciliation to reopen the case.

Tier 3. The user confirmed Stocking-only scope. Spec approval: not obtained (autonomous run); independent human review of the full specification did not occur. See [spec and failure model](regular-stock-resolve-spec.md).

Final measured checks:

| Layer | Result |
| --- | --- |
| Focused HTTP, browser and unit acceptance | 14 tests; 14 passed, 0 failed, 0 skipped |
| Full affected regular/stock-request suite | 278 tests; 276 passed, 2 failed; zero new failures |
| Before-change affected baseline | 264 tests; 262 passed, 2 failed |
| Types, syntax and lint | 0 new type diagnostics; 0 new lint findings |
| Changed executable lines | 186/186 |
| Changed branches | 162/175; missing paths recorded in changed-lines.json |
| Manual mutation | 6/6 killed |
| Calendar/reference properties | 400 examples with recorded seeds; 1 calendar mutant killed by property tests alone |
| Order checks | All 3 focused files passed in the recorded shuffled order |
| Secrets and dependencies | Secret scan passed; dependencies and schema unchanged |

The pre-existing failures retained exactly are:

- `simple Delivery HTTP uses the SO memo and reuses one TO and print job (lost response: false)`
- `simple Delivery HTTP uses the SO memo and reuses one TO and print job (lost response: true)`

The six manual mutants allow invalid dates, remove replay handling, remove the commitment guard, leave case lines open, drop the Sales notification event pointer, or retain an unfinished reply when changing queues. SQL mutants were checked with real authenticated HTTP and database assertions. The property-only run covers the calendar mutant; it does not claim to verify SQL or notification behavior.

Spec mapping:

| Criterion | Executable evidence |
| --- | --- |
| 1: usable form, required reply, retention and Cancel | Browser desktop 1440px and phone 390px; Enter, native validation, language/refresh retention, unknown PO and Cancel tests |
| 2: canonical PO and hostile input validation | HTTP existing/deleted/ambiguous/missing PO, stale revision and malformed reply tests; parser unit tests and two 200-example properties |
| 3: closure and unchanged external orders | Transfer/Purchase HTTP closure, unchanged quantities/units and PO snapshot, both queues, allocation reconciliation and outbound-call trap |
| 4: one private unread decision | HTTP requester/peer/other-yard access, persistent acknowledgement and replay; browser follows the Sales badge to the saved PO/ETA and reloads |
| 5: atomic and repeatable closure | Six concurrent identical submissions, one event/revision, conflicting saved reply, stale revision and trigger-injected rollback |
| 6: safe scope and compatibility | Role guards; method, cancelled/special, handoff/TO, transfer and Purchase-demand guards; UI unsafe-state checks; full affected suite compared with baseline |

The RED run observed all 13 original acceptance tests failing on behavior before implementation; the first GREEN run passed 13/13. Static checks then found DOM/state/browser-interface diagnostics, which were corrected without weakening assertions. VM coverage and native browser Event metadata were adjusted after GREEN with assertions unchanged. Coverage then exposed the untested queue-change reset; an additional meaningful browser regression check was proven by removing that reset in a throwaway mutant. The fixture was then filtered to its own request with all assertions unchanged. The secret scanner flagged four literal dummy test-password assignments; those fixtures now generate disposable passwords without weakening the scanner. Final numbers above come from the final fresh run after all runtime edits.

Types compare existing diagnostics against the captured baseline using the same browser interface declarations, and require both new modules to have no own diagnostics. The large server is checked by syntax/lint and real authenticated HTTP. Existing application-wide type debt remains outside this change. Coverage branches identify remaining paths rather than being treated as complete proof. Cross-workflow correctness additionally relies on the existing case/purchase lock order; the concurrency test directly exercises duplicate Resolve submissions. No production request was created or closed for validation.

Reproduce every verification layer with `python3 tools/regular-stock-resolve-run.py gauntlet`. This requires the existing isolated review Docker container/database and the recorded tools: node v20.20.2, typescript 7.0.2, eslint 10.8.0, c8 12.0.0, fast-check 4.9.0, @playwright/test 1.62.1. The runner verifies the isolated database host and prefers the recorded release candidate. No new tools or dependencies were installed for this change. No Git checkpoint commits were made in the existing dirty workspace. The application-wide suite and dependency audit/license review were not repeated; the full affected suites ran and dependencies did not change.

Source identification: candidate full-tree manifest SHA-256 `c82e905a37aee9699de5e09ae4d7073223a835c05e73c2f3282885959759928c`. Per-file hashes, logs, coverage and tool versions are in [checks.json](../test-artifacts/regular-stock-resolve-20261002/checks.json). Exactly 8 runtime files are overlaid on the captured deployed app; the unrelated live stylesheet order is preserved. Release commands are `python3 tools/regular-stock-resolve-deploy.py prepare`, then the guarded `apply` when authorized. The preparation verifies the entire image source tree, configuration and startup import, and records a rollback pinned to the captured image. Publication checks active work before restarting only the app, and verifies local/public health, changed asset hashes and an unauthenticated Resolve rejection. Worker, database and Ollama configuration and identities remain guarded.

Release image: `mbbs-operator-app:regular-stock-resolve-20261002`, `sha256:42b0948a57621ed81e102d0e6dd1ba3aef10981a94ff60f249574ac168af7331`. Live release checks passed; see [release result](../deployments/regular-stock-resolve-20261002/result.json).

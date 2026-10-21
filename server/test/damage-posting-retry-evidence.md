# Damage stock posting and retained retry evidence — Tier 3

Spec approval: not obtained (autonomous run). Scope and historical reconciliation
were explicitly authorized by the user. The acceptance specification is
`test/damage-posting-retry-spec.md`.

Source tree: `13e598fc26a802105bc661d938ded91693593d48df158f95b55fb122b53129ed` (1185 files).
Released image: `sha256:3c018262023b1e34f8746ce47bb36d5741f656c741688b1cadffb151add7979f`. Only fourteen runtime files changed,
with no migrations or dependencies. Unrelated concurrent changes were retained
by overlaying this patch on the live parent and checking its hashes before release.

Re-run entry point: `python3 tools/damage-posting-retry-verify.py run` (isolated
Docker services and the captured source copies required). Artifact collection
alone uses `collect` while its test runner exists. Neither command publishes
the app or writes live stock.
Focused and mutation commands are persisted in `tools/damage-posting-retry-check.mjs`.
The full suite uses frozen before/after copies containing the same current tests
and unrelated source; only the fourteen runtime files differ. Initial/interrupted
logs remain separate from the final comparison. Node v20.20.2;
c8 12.0.0, eslint 10.8.0, typescript 7.0.2, fast-check 4.9.0, @playwright/test 1.62.1.

| Acceptance | Verification | Result |
| --- | --- | --- |
| P1/P2 | Realistic description-stripping create/append contracts, atomic REST payload and committed audit-before-write checks | pass |
| P3/P4 | Lost response, restart, parallel retry, adversarial receipt/snapshot/quantity/UOM/reason/location cases | pass |
| P5 | Isolated recovery rehearsal and live recovery receipt; retain duplicate evidence, link existing Pisa without another movement | pass |
| D1–D4 | Real Chromium reload, five large photos, failed IT retry, unknown submit, partial upload reuse, cache errors and actor/yard changes | pass |
| D5 | Actual local-status HTTP route without NetSuite reads; service worker and every offline asset fetched from the app | pass |
| C1–C3 | Read-only description handling, stock fields and additional-line receipt properties | pass |
| Existing behavior | Photo ZIP, Control editing, operator counting and priority queue contracts | pass |

| Layer | Actual final result |
| --- | --- |
| Exact candidate focused tests | 153/153 passed, 0 failed, 0 skipped |
| Reverse test order | 153/153 passed |
| Full regression | 759 identical files per run; 62 baseline / 62 final failed files; zero new file/test failures |
| Completed full-test summaries | 3949 passed, 214 failed, 1 skipped, 0 cancelled |
| Type comparison | 274 baseline / 274 final existing diagnostics; zero new |
| Lint and syntax | Zero new lint findings; twelve runtime JavaScript files parse |
| Changed executable lines | 270/270 covered; zero misses, V8/Istanbul mapping |
| Manual mutations | 8/8 plausible mutants killed; receipt, snapshot and stock-quantity mutants killed by properties alone |
| Properties | 250 snapshot/JSONB-order cases, 250 memo-replacement cases, 150 Control corruption cases, plus existing photo, naming and Control properties |
| Supply chain | No new dependencies, unchanged package files, zero secret candidates |
| Live execution | September Pisa remains 10 PC with original 9 PC and photo; October Pisa linked once; October UCARA 27.09 SQFT on exactly one line; September UCARA superseded with photo |
| Live downloads | Original image bytes and line/SKU ZIP names verified in September and October |
| Deployment | Public/local health 200, anonymous damage API 401, source/asset hashes, unchanged configuration and other services |

Live October review: 1141 ms; September:
4417 ms. Individual external-service observations are
not a latency guarantee. Local entry recovery avoids history queries entirely.

Known limits:

- The whole repository suite and type check contain existing failures; neither
  is globally green. Complete failures and diagnostics are in `comparison.json`
  and the baseline/final logs. The same 60-second test-file watchdog applies to
  both runs and records each intervention; timed-out files have no final summary.
- An earlier broad comparison used incompletely initialized test databases and
  was discarded. Its logs are retained with `uninitialized` in their names.
  The final helper completes migrations before cloning and verifies every
  migration filename, preventing the setup race found during this run.
- Changed executable lines run, but branch coverage is not complete. Browser
  behavior, HTML and cache URLs are verified through Chromium and HTTP checks.
- One candidate run hit a screenshot-capture timeout in the existing count
  browser test after its functional assertions. The unchanged test passed in
  isolation, and the full candidate and reverse-order runs passed on rerun.
  The failure is retained in `candidate-screenshot-timeout`; no assertion or
  timeout was loosened. The upload-context race was reproduced separately,
  fixed and checked by a dedicated mutation before freezing the final source.
- NetSuite description is read-only in this account. Confirmation requires the
  durable memo receipt, unchanged prior stock lines and exactly one matching
  addition. Unknown outcomes remain blocked for recheck instead of resending.
- Device storage can be unavailable or cleared. This is surfaced to the operator;
  the in-memory draft is retained and accepted reports remain on the server.
- Historical September linking preserves the user-approved manual change from
  9 PC/R2 to 10 PC/R3. The original report and photo remain unchanged.
- Dependency vulnerability/license auditing was not repeated because dependency
  files are unchanged. Private live backups are kept out of this report.
- No git commit was made in the shared dirty workspace.

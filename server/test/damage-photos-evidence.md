# Damage stock evidence — Tier 2

Spec approval: not obtained (autonomous run). The acceptance specification is
`test/damage-photos-spec.md`; this lowers confidence relative to independent spec review.

Released source tree: `9ba42d18ad81cc78a8076f0df5a27227c4c7f2b45becadfc43d094ac724e7d19` (1179 files).
Image: `sha256:e5915a166ba4bf98f72febcf45018d025f702d9a1d0972a87d36829cd4b5ead0`. Ten requested runtime files changed across two scoped releases.
The exact candidate passed after the last runtime edit. Broad tests compare the
frozen workspace baseline with the final workspace; the candidate also passed
its own focused and reverse-order runs. Tool versions: Node v20.20.2,
c8 12.0.0, eslint 10.8.0, typescript 7.0.2, fast-check 4.9.0, @playwright/test 1.62.1.

Re-run entry point: `python3 tools/damage-photos-verify.py run` (isolated Docker
fixtures and captured baseline required). Final artifact checks were run with
`python3 tools/damage-photos-verify.py collect`. Publishing is separate from tests.

| Scenario | Verification | Status |
| --- | --- | --- |
| P1/P2 | damage-photo-links.test.js: unique association, ambiguity, identity guards, unchanged database | pass |
| Z1/Z2 | damage-photo-download.test.js and damage-photos-browser.test.js: naming, originals, deduplication, unsaved draft | pass |
| Z3/R1 | damage-photos-browser.test.js: missing original, expired login, disabled empty review; existing damage/operator suites | pass |
| Z4 | damage-photo-download.test.js plus independent Python zipfile reader: exact bytes, CRCs, Unicode and limits | pass |
| Z5 | damage-photos-browser.test.js: 390-pixel viewport without horizontal scrolling | pass |
| S1/S2 | damage-photos-performance.test.js plus damage-photo-links.test.js: overlapping reads, batches of three, completeness and unit labels | pass |
| S3 | live-deployed.json: real IT00571 review and original image, unchanged saved report | pass |
| S4 | damage-photos-priority.test.js and existing NetSuite priority queue/scheduler tests: HTTP foreground context and shared limits | pass |
| Scope invariants | exact source hashes, package equality, release configuration and unchanged other services | pass |

| Layer | Persisted command | Actual final result |
| --- | --- | --- |
| Focused tests | `node tools/damage-photos-check.mjs` | 112/112 pass; 0 failed, 0 skipped |
| Suite order | Same entry point, reversed file order | 112/112 pass |
| Broad regression | `python3 tools/damage-photos-full-run.py baseline` and `final`; evidence `compare` | 756 files each; 60 baseline and 60 final failed files; 0 new file/test failures |
| Broad test counts | Recorded Node summaries | 3943 passed, 198 failed, 1 skipped, 0 cancelled; timed-out file has no completed summary |
| Types | Existing `tsc --project tsconfig.mbt.json --noEmit`; evidence `types` | 274 baseline/274 final existing diagnostics; 0 new |
| Lint and syntax | `node tools/damage-photos-static.mjs` | 0 new lint findings; 8 JavaScript files parse |
| Changed-line coverage | `node tools/damage-photos-coverage.mjs` | 174/174 changed lines covered using V8/Istanbul mapping; 0 misses |
| Manual mutation | `node tools/damage-photos-mutations.mjs` | 5/5 plausible mutants killed |
| Properties | Focused tests, fast-check | 100 photo-association, 200 hostile-filename, and 24 queue/fairness generated cases |
| Independent archive reader | `python3 tools/damage-photos-zip-check.py` | 3 archives, 9 image entries; bytes/names/CRCs pass |
| Supply chain and capability | Evidence `supply` | 0 new dependencies; package files unchanged; 0 secret candidates; existing authenticated photo endpoint |
| Live execution | `sudo -n docker exec -i -w /app mbbs-operator-app-app-1 node --input-type=module < tools/damage-photos-live-verify.mjs` | IT00571 line 1, 1 real photo, ZIP naming verified, report unchanged |
| Deployment | `python3 tools/damage-photos-deploy.py apply` | Local/public health 200; anonymous damage API 401; assets, configuration and other services verified |

The live review took 1863 ms. The original sample was about 8,072 ms.
These are individual external-service observations, not a latency guarantee.
The optimized code overlaps independent reads, bounds REST requests at three,
and retains a live unit query when saved labels are incomplete.

Known limits and honest notes:

- The full repository suite and type check have existing failures. Complete
  names and logs are in `comparison.json`, `baseline-full.log`, `final-full.log`
  and the type logs. Neither layer is reported as globally green.
- `aggregate-request-browser.test.js` hangs on the baseline. The watchdog
  marks it failed and continues. It first found the baseline hang after 493
  seconds; the final run applied the 60-second file budget and killed it at 64
  seconds. No test assertion was weakened or skipped to hide this.
- Initial isolated image selection lacked current dependencies/browser files;
  that incomplete run was discarded and retained as a setup failure log.
- A combined mainline/unit SuiteQL query took 96.2 seconds and was rejected.
  The released month-ID lookup avoids that design.
- Early directory rejection initially caused an unhandled rejection; its RED
  test now passes. Lint configuration and artifact transfer were corrected in
  the isolated harness. The expired-session test selector was corrected to the
  actual login form before the final 101-test run.
- A live read after the first release exposed long background-queue waits.
  The Control review route was missing foreground context. The HTTP RED test
  observed background priority in both transfer and unit reads; the final
  route adds the existing middleware only to the review GET. Shared queue
  limits and background progress remain covered. The live image check now
  verifies the IT00571 photo while allowing other reports to have images too.
- New helper branch coverage from c8: photo association 31/33 branches;
  ZIP helper 45/49 branches. Changed lines execute, but branch coverage is not
  complete. CSS/HTML are verified by actual browser layout and served asset
  hashes rather than JavaScript coverage.
- Dependency vulnerability/license auditing was not repeated because the
  dependency set did not change. Tests use existing recorded tool versions.
- No stock posting, report reconciliation, migration or git commit was part
  of this change. The report remains `attention` while its photo
  is attached for display. A changed or ambiguous line is deliberately left
  with its saved report.

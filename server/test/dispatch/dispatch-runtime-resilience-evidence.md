# Dispatch runtime resilience — verification evidence

Run completed: 2026-08-15 UTC

Specification: `test/dispatch/specs/dispatch-runtime-resilience.md`

Source identity:

- Repository HEAD: `f8448e5273d3feabc063d97ea65956d9d67aae4d`
- Dirty-tree source-state digest: `a77e22a736d8d48e4ad814d0bfcd6576e016ec632eccbc553520b6469fc416d7`
- No dependency was added.
- Production data and containers were not changed during this verification.

## Executed evidence

| Gate | Result |
| --- | --- |
| Focused incident, lease-property, performance, and completion tests | 33/33 passed |
| Driver lane/order harness | 96 checks passed |
| Operator camera / PO-TO Schedule harness | Passed |
| Operator return UI harness | Passed |
| Full isolated Node application suite | 307/307 files, 1,638/1,638 tests passed |
| Full legacy compatibility suite | 133/133 harnesses passed |
| Reverse-order focused repeat | 33/33 passed |
| Final directly affected fixture repeat | 9/9 passed |
| Compact Custom Order race repeat | 9/9 passed: three runs each in Chromium desktop, Chromium mobile, and WebKit mobile |
| Final full browser suite | 166/166 passed in Chromium desktop, Chromium mobile, and WebKit mobile |
| Persisted mutation set | 5/5 killed; 100%; sources restored and detectors re-passed |
| Legacy JavaScript syntax | Passed |
| TypeScript check of checked JS/MJS boundaries | Passed |
| Focused ESLint / complexity gate | Passed with zero warnings |
| Dependency-tree inspection | Completed; no dependency change |
| License policy | Passed for 383 packages; pre-existing `buffers@0.1.1` manual-review exception retained |
| Focused secret scan | Passed; zero high-confidence findings |

The final browser inventory is 166 rather than the earlier 163 because the new edit-lease and resilience regressions increased the executable suite.

## Mutation boundaries

Every injected defect was detected:

1. Dereference a missing compact-plan order.
2. Discard an assigned saved-plan order during the late global feed.
3. Permit an edit-lease token to cross plan dates.
4. Send an unsupported browser-extension request into the service-worker cache pipeline.
5. Retain an empty stale saved driver lane forever.

## Incident conclusions

- The duplicate empty Cheng lane was obsolete saved-plan ordering metadata, not a second Driver Setup row.
- Empty stale lane keys are pruned only after setup is known; any lane containing a load, stop, order, or return remains historical and visible.
- The Aug-14 plan crash is guarded when a compact stop's order is temporarily absent, and assigned compact orders survive a later incomplete global feed.
- Compact bootstrap renders before the multi-megabyte global order feed.
- A same-tab reload validates and resumes its tab-scoped edit lease; explicit View Mode still releases it.
- Non-HTTP(S) service-worker requests are ignored before cache access.

## Coverage note

Changed-line coverage was not instrumented for the monolithic legacy browser script, so no numeric changed-line coverage claim is made. The relevant branches are instead exercised by focused Node tests, 256 deterministic lease-scope examples plus malformed inputs, three-engine browser execution, the full application suites, and a persisted 5/5 mutation set.

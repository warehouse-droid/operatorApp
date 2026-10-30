# Dispatch source saves and stable notices — evidence

Spec: [dispatch-source-save-20261022.md](specs/dispatch-source-save-20261022.md).
Tier 3, concurrency and draft preservation. Spec approval: not obtained
(autonomous run). This is bounded evidence against that specification, not proof
that every possible interaction is covered.

The observed production failure was a successful save at revision 37 followed
two seconds later by an automatic source acceptance at revision 38. Cargo fields
changed; trucks and summary did not. The browser discarded the acknowledgement
while its save queue was finishing. Subsequent retries retained the old fence.

The fix verifies the original revision/digest against a contiguous source-only
archive, merges source fields without replacing local route edits, and permits
one rebuilt retry after a definitive stale response. Existing conflicted draft
journals use the same proof. Notices update their own region without replacing
the stop sequence or consuming planner layout height.

## Final fresh run

Run from the repository root:

```sh
DISPATCH_SOURCE_RUNTIME="$PWD/server/deployments/dispatch-source-save-20261022/candidate" \
DISPATCH_SOURCE_SKIP_BUILD=1 \
bash docker/run-dispatch-source-tests.sh node tools/dispatch-source-save-check.mjs all
```

Omit `DISPATCH_SOURCE_SKIP_BUILD=1` to rebuild the test image. The runner uses the
standard isolated Compose budgets and `mbbs-tests.slice`, registers teardown
before startup, and removes its unique artifact directory through retention.py.

Final run: `mbbs-source-save-1724058`, exit 0. Results:

| Layer | Result |
| --- | --- |
| Complete focused save/source suites | 101 passed, 0 failed, 0 skipped |
| Real Chromium, 1440 and 820 pixel widths | 2 passed, 0 failed |
| Reversed new frontend/property file order | 12 passed, 0 failed |
| Syntax | 9 files passed |
| Differential ESLint | 0 new findings; 1,912 inherited findings |
| Manual mutation | 6/6 killed; four by properties alone, two by frontend race tests |
| New server verifier coverage | 29/29 lines, 26/26 branches, 2/2 functions |
| Modified source-review method coverage | 25/25 instrumented lines |
| Entire existing source-review repository coverage | 301/303 lines, 153/171 branches, 16/16 functions |
| Host resource-budget checks | 6 passed |

The mutation script is `tools/dispatch-source-save-mutations.mjs`: wrong digest,
wrong archive kind, ignored route edits, overwritten local source edits,
ignored uncertain requests, and discarded save-completion acknowledgements.
The new property suite generates 1,000 source chains/drafts and repeated hostile
history variants; the existing save-reliability property suite remains included.

## Specification mapping

| Behavior | Executable evidence |
| --- | --- |
| Source acknowledgement during save completion | `frontend/dispatch-source-refresh.test.js` |
| Exact original fence and source-only history | `property/dispatch-source-refresh.property.test.js`, `integration/dispatch-source-decision.test.js` |
| Local notes, stop order, removed orders, nested children and overlapping edits | `frontend/dispatch-source-refresh.test.js`, new property suite |
| Bounded retry, ambiguous requests, late responses, navigation | new frontend suite and existing `frontend/dispatch-save-reliability.test.js` |
| Baseline/journal recovery and real HTTP save after missed acknowledgement | new frontend suite and source-decision integration suite |
| Leases, executed prefixes, idempotency, driver evidence, rollback | existing save-reliability and source-decision integration suites |
| Stable stop nodes, size, scroll and focus through notices | `frontend/dispatch-notice-stability.browser.test.mjs`, real 15-stop preview |

## Red evidence and limitations

The initial run against the old implementation had 4 failures in 19 checks,
including the missed-acknowledgement HTTP regression. Both initial browser cases
failed because notices replaced the board/stop nodes and changed layout or scroll.
The later old-journal recovery case also failed before its implementation.

Validation tooling needed corrections: the existing frontend fixture needed the
real recovery helper; a separate coverage rerun incorrectly reused database
fixtures; and the first coverage configuration applied a global threshold to
extracted frontend declarations. Assertions were not weakened. Coverage now runs
once with the suites and retains the server coverage thresholds. Frontend line
completeness is deliberately not claimed: VM extraction/padding does not support
trustworthy whole-file coverage. Its evidence is behavioral and mutation testing.

Strict static types and full changed-frontend branch coverage were not completed;
legacy Dispatch has no scoped type-check configuration. Syntax and differential
lint passed. Unrelated product suites were not run on the shared live host.
Suite-order evidence covers the new frontend/property files, not every possible
ordering of all integration suites. No migration, runtime dependency, permission
or credential changes were introduced. The release patch was inspected for
secrets and unrelated capabilities. The new recovery functions are 25 lines or
fewer. No checkpoint commit was made in the concurrently modified workspace.

Node 20.20.2; ESLint 10.8.0; Playwright 1.62.1; c8 12.0.0; espree 11.2.0;
istanbul-lib-coverage 3.2.2; v8-to-istanbul 9.3.0.

Seven-file runtime identity: SHA-256
`9260f3a863a1726f36bcaa3f63b0e1b9f70e7ce9c8af3695a8711d50908d16df`
over the sorted compact JSON file-hash map in the deployment manifest.
The release builds on the current backorder-review-flow image and preserves that
concurrent deployment. Runtime source hashes match the frozen tested candidate.

All containers, disposable storage, networks and generated output owned by this
run were removed. Both `docker ps` and `docker ps -a` were checked, and production
health passed. A separately active task's isolated project was left in its own
runner's care. Deployment/rollback records live under
`server/deployments/dispatch-source-save-20261022`; deployment-result.json records
the actual cutover, runtime hashes, served assets and live health verification.

Published at 2026-10-22 23:58:29 UTC, image
`sha256:342204042d39819083f1c320c42b1a92f137ecc098f3908720b60abb9a7cbac3`.
Local and public health returned 200; all four served assets and all seven runtime
files matched the tested hashes. Anonymous source-review access remained 401.
Production configuration and database/worker/Ollama container identities were
unchanged. The post-release cleanup check found no resources for this test
project, and the production app was healthy.

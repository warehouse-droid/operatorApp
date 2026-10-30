# Dispatch TOB search fix — 28 October 2026

Deployed at 16:31 UTC. `TOB0126` returns all ten references, `TOB01260` through
`TOB01269`, including unplanned `63`, `64`, `65`, and `66`. The reproduced
background-update and local-edit cases now render the complete results.

The missing results had a specific timing trigger: an order update or plan edit
arriving while the search was waiting caused the browser to discard the entire
response. It then stopped showing the loading state, leaving only the planned
orders already on screen. The existing queued update fetched the SO browsing
list instead of the active search. A quiet search, or an update arriving before
the search, succeeded. See the unchanged
[original reproduction](dispatch-tob-search-reproduction-20261028.md).

The fix keeps discovery of missing orders separate from changes to existing
cards. Newer order details, local assignments, retirement rules and navigation
guards still apply. The existing queued update now serves the active search.
There is no new polling timer, retry loop or additional refresh mechanism.

The database query also repeatedly scanned receiving lines and recalculated
closed-order family membership. It now calculates those intermediate results
once per query. Search eligibility, quantities and historical results retain
their existing rules. A read-only, repeatable-read comparison of the old and
new loaders produced identical complete order objects for all ten matches:
[parity record](../deployments/dispatch-tob-search-20261028/live-parity.json).

| Live measurement | Elapsed | Results |
| --- | ---: | ---: |
| Original loader, two recorded runs | 23.515–24.563 s | 10 |
| Deployed loader | 7.690 s | 10 |
| Final loader plus route ownership filter | 9.376 s | 10 |

These are measured server-side reads, not end-user network timings or a latency
guarantee. The like-for-like deployment check met the threefold improvement
target. Search still takes several seconds; the final run's largest remaining
query was the historical plan-snapshot search (8.695 s, parallel with other
queries). The correctness fix does not depend on a fast response.

The [acceptance specification](dispatch-tob-search-fix.spec.md) used the
[old-coder skill](/home/ubuntu/.codex/skills/old-coder/SKILL.md), tier 3 for
concurrent reads and edits. Spec approval: not obtained (autonomous run).
The user authorized the fix; separate review of the specification did not occur.

| Spec clauses | Verification |
| --- | --- |
| 1–2: complete results; reuse existing refresh | Ten frontend tests and six full-script Chromium scenarios; background-update case makes the original request plus the already-existing update request. |
| 3: preserve newer data and retired orders | Targeted mutation, local-edit, per-reference freshness and hydration tests; retired `TOB01263` is correctly excluded in its adversarial browser case. |
| 4: reject obsolete work; honest loading/error state | Search, scope, plan/date and away-and-back navigation cases; superseded hydration and detail verification; abort, error and empty responses. |
| 5: preserve backend semantics | Complete live-object parity; 3,600 generated old/new SO/PO/TO closed-family comparisons; existing pool, receiving, linked-PO, grouping, split and historical-search regressions. |
| 6: remove repeated scan; measure speed | Materialized receiving-line source and closed-family sets; live timing and parity records. |
| 7: scoped deployment | Five-file image overlay, verified hashes, preserved configuration/dependencies, health 200, anonymous search 401, served assets verified. |
| 8: disposable tests | Bounded standard Compose configuration and retention wrapper; teardown registered before setup; final container/storage/artifact audit. |

The final [machine-readable check report](dispatch-tob-search-fix-evidence.json)
and [browser report](dispatch-tob-search-browser-20261028.json) identify the
verified source hashes and tool versions. All results below follow the final
runtime code edit.

| Layer | Result |
| --- | --- |
| Reproduction against old implementation | 7 of 10 focused frontend tests fail; 3 already pass. |
| Final relevant regression suite | 179 tests: 173 pass, 6 unchanged baseline failures; zero new failures. Includes all 11 focused frontend/SQL tests passing. |
| Browser execution | 6/6 scenarios pass, using the actual complete Dispatch script and helpers with controlled network fixtures. |
| Static checks | Types: 3,459 existing diagnostics, zero new. Lint: 78 existing diagnostics, zero new. |
| Changed executable JavaScript lines | 64/64 covered: frontend 29, repository 9, SQL module 26. HTML asset-version changes verified through served-file checks. |
| Manual mutation checks | 6/6 plausible defects detected. Three frontend defects also fail the property test alone; the refresh-routing defect fails its unit test; two SQL defects fail the equivalence property test. |
| Test ordering and restoration | Candidate regression files run in randomized order with isolated databases; focused tests rerun after mutant restoration; final source hashes checked. |
| Dependencies and scope | No application dependencies, migrations, environment settings or production order data changed. New runtime helper and SQL construction reviewed for scope/complexity; no new external endpoint or credential handling. |

The six baseline failures concern two obsolete asset-version assertions, an
existing CO pickup source-form assertion, a checkpoint response-size bound,
and two global-derived-order cases returning null. Their names and failure
fingerprints are recorded in the check report. Existing behavioral assertions
were retained. Failure comparison normalizes only the obsolete asset-version
value in those two already-failing assertions.

During verification, a missing test fixture dependency and a pending-request
issue in the new harness were corrected. Static checking then found six new
implicit-any diagnostics; JSDoc types removed them before the final run.
The final run was clean relative to the recorded baseline. Verification covers
the 21 relevant existing test files plus two new files, not every unrelated
repository suite. Complete branch coverage and a dependency audit were not
claimed; dependency manifests were unchanged. Browser race cases use controlled
responses, while live database correctness and timings were checked separately.

Replay the complete isolated checks on this host using the preserved baseline:

```sh
sudo -n env MBBS_TOB_TEST_BASE_IMAGE=mbbs-operator-app:rollback-dispatch-search-20261028 bash docker/check-dispatch-tob-search.sh
```

The runner performs baseline comparison, tests, static checks, changed-line
coverage, mutations and browser execution, then removes its disposable stack
and raw artifacts. It requires the captured baseline image and files. No Git
commit was created; the report records every deployed file's SHA-256 instead.

The release changed only `public/dispatch.js`, `public/dispatch.html`,
`public/mbt-planning.html`, `src/dispatch-repository.js` and the new
`src/dispatch-order-pool-sql.js`. See the
[deployment result](../deployments/dispatch-tob-search-20261028/deployment-result.json)
and [final search](../deployments/dispatch-tob-search-20261028/live-search-route.json).
A subsequent return-layout deployment preserved all five verified files.
The [completion audit](../deployments/dispatch-tob-search-20261028/completion-audit.json)
confirms their live/served hashes, healthy application, only the four production
containers in both `docker ps` and `docker ps -a`, and no remaining disposable
test containers, volumes, task networks or run directories.

# Retired PO split search evidence — 2026-10-28

Spec approval: not obtained (autonomous follow-up). See
[scm-retired-po-search-spec.md](scm-retired-po-search-spec.md).

Root cause: broad Dispatch/Sales search used `$26 OR NOT EXISTS (...)`, bypassing
the cancelled-child identity filter. The cancelled L3 retained its historical
Queued schedule row and no active reconciliation target, so search displayed it
with empty content and an unreconciled indicator. The active L3-18Plt already had
valid Completed delivery evidence. The runtime fix removes that bypass from the
PO split cancellation predicate, matched by synthetic PO ID rather than reference.
No schema, order, line, allocation, schedule or history records were edited.

RED: four of 13 split-history tests failed against the unchanged live source:
cross-order retired visibility, reference reuse, HTTP search and the seeded
multiple-retirement property. The reusable-child fixture now explicitly queues
its active replacement, so the independent Hold exclusion cannot mask the result.
Reintroducing the search bypass after the fix reproduces all four failures.

GREEN: all 28 affected tests passed across:

- `scm-cancelled-split-schedule.test.js`: normal/history/exact/cross-order reads,
  reference reuse, unchanged cancellation history, and 16 seeded property cases
  exercised under both regular SCM and broad-search audiences (seed 1400761).
- `scm-schedule-search.test.js`: authenticated role/visibility behavior and real
  Chromium search for Sales and Dispatch. Native cancelled/inactive/closed POs
  remain searchable; cancelled split identities are excluded.
- `scm-po-split-schedule-remaining.test.js`: parent residual and child quantities.
- `scm-schedule-status-http.test.js`: authoritative schedule status over HTTP.

All three mutations were caught: restore the search bypass, match cancelled
children by shared reference, and hide active children along with cancelled ones.
The runtime source hash was restored after each mutation. Both changed SQL lines
were executed under c8 and validated by real PostgreSQL assertions. JavaScript
syntax and the checker ESLint pass. Node version: 20.20.2.

No dependencies or runtime capabilities were added. Full-repository tests,
global types/lint and a separate randomized suite-order run were not performed;
this change is a two-line SQL visibility predicate. This evidence covers the
listed behaviors and does not claim exhaustive application validation.

Reproduce with `sudo -n bash docker/run-scm-retired-po-search-checks.sh final`.
The runner stages only this task's delta over live source, uses standard bounded
Compose services under `mbbs-tests.slice`, registers teardown before startup and
wraps all output in its unique retention artifact directory. Containers, storage,
network, browser output, logs and coverage are removed after every run.

Deployment: image
`sha256:2d938bcdd12b1734a86036c1abcd981be9482ddfb9abd0e6672246edb7a97182`.
Only `src/dispatch-repository.js` was overlaid on the captured current image.
App configuration and database/worker/Ollama container identities were preserved;
local/public health passed and anonymous schedule access returned 401.
Rollback tag: `mbbs-operator-app:rollback-scm-retired-po-search-20261028`.
Scoped patch, tested hashes and operational records are in
`server/deployments/scm-retired-po-search-20261028/`.

Live before/after verification confirms the only removed projection is cancelled
split 332 (`PO# B03429 (L3)`). Its ledger and two saved split lines remain intact.
Split 334 (`PO#B03429 (L3-18plt)`) appears exactly once, Completed, reconciliation
`ok`, with 1771.2 SQFT and 18 pallets. All sibling projections are unchanged.
Final `docker ps` and `docker ps -a` confirm the four production containers are
running and no container from this task remains. No task network or volume
remains. A separate, actively owned `mbbs-repair-tests-4155100` run was preserved
for its own retention runner to clean up; see `cleanup-result.json`.

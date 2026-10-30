# Cross-date regroup correction — 2026-10-28

The defect is in `syncDispatchGlobalOrderGroupsFromPlan`: it skipped an
unassigned group when its stored source plan differed from the open plan, even
after the caller accepted explicit reactivation. The browser received a success
and cleared its reactivation intent. The next ordinary save then rejected the
still-retired global definition.

Live read-only evidence for GOA-10979-10980 shows retirement at 19:13:33 UTC,
explicit regroup actions at 19:27:52 and 19:28:44, and target plan 372 (October
29) saved at revision 12 with the group present. Its shared definition remained
inactive under source plan 371 (October 28). Recovery draft 21337 retains the
rejected load placement. No production data or recovery draft was modified.

## Correction and acceptance mapping

The group synchronizer now receives the caller's normalized explicit intent. It
allows an inactive group to persist before load assignment on another date,
while retaining original source-plan provenance. Active foreign groups still
ignore unassigned snapshots. Stale snapshots retain the existing retirement
validation and filtering. The change adds no schema or dependencies and uses
the existing transaction, fleet lock, and definition locks.

Spec items 1–2 map to the SO, TO and CO recreation tests plus the HTTP save
sequence. Item 3 maps to the assigned/unassigned stale-snapshot test. Item 4 maps
to active-owner protection and reference-scoped rollback. Item 5 maps to the
rollback test, both existing retirement concurrency tests, repeated saves, and
36 deterministic property cases. Item 6 maps to the HTTP command-endpoint test
and the complete affected lifecycle suites. The HTTP fixture uses the normal
test configuration's compatibility save path; both production save paths call
the corrected synchronizer. No production-data replay was performed.

## Final validation

Run from the repository root: `bash docker/run-dispatch-regroup-tests.sh`.
The machine-readable results and runtime source fingerprint are in
`dispatch-cross-plan-regroup-evidence.json`.

- New regression tests: 8 passed, including an authenticated HTTP save followed
  by an ordinary save, and 36 generated lifecycle cases.
- Existing affected suites: 20 passed; the same 2 failures appeared on the
  original behavior and candidate. These are the global-split fixture's null
  `originalOrderId` access and grouped-CO fixture's null `childOrders` access.
  No new failures were introduced.
- Mutation checks: 3/3 caught; all 3 also caught by the property test alone.
- Repeated focused run with reversed file arguments: 8 passed. Node may
  normalize file order; this is a repeatability check, not a randomized-order
  claim.
- All 7 changed executable lines were exercised. This is line coverage, not a
  claim of complete branch coverage for the 1,800-line repository module.
- ESLint, Node syntax validation, secret scan and whitespace checks passed.

The first regression run failed 5 behavioral tests; the separate HTTP run also
failed after an HTTP 200 left the group retired. Fixture corrections supplied
canonical local CO records and removed test audit/lease rows before reruns.
Assertions were preserved. Coverage initially inherited an unrelated global
95% threshold; the final runner enforces changed-line execution instead, as
specified. A shadowed test variable was renamed to satisfy lint.

The full unrelated application suite was not run. The repository type
configuration excludes this JavaScript module from checked types; syntax and
lint were run. No dependency audit was needed because dependencies did not
change. Risk tier 3; spec approval was not obtained in this autonomous run.

## Cleanup and release

All runs used the standard bounded Compose services in `mbbs-tests.slice`, with
the repository retention runner and unique temporary artifact directories.
The default artifact root was not writable, so the runner used
`/tmp/mbbs-regroup-runs`. Every run removed its containers, disposable storage,
network, coverage and logs, including failed runs. Final `docker ps` and
`docker ps -a` showed only the four production containers, and health passed.

`python3 server/tools/dispatch-regroup-release.py prepare` prepares a one-file
image over the captured live image with an app-only rollback. Deployment is a
separate action; this source correction does not apply recovery draft 21337.

The prepared image is `mbbs-operator-app:dispatch-regroup-20261028`; its matching
rollback tag is `mbbs-operator-app:dispatch-regroup-20261028-rollback`. Preparation
completed, and the resolved Compose environment and command match the live app.
The captured runtime patch contains only the seven executable-line changes
reported above. The operational manifest,
before-image, release patch and image identifiers are retained under
`server/deployments/dispatch-regroup-20261028`.

The user explicitly authorized deployment. The app was deployed on October 28
at 20:22:24 UTC using image
`sha256:712adbf0df4a7384d4e5eb729e96e3d5a2daa457444d2591897d5c010e29c86e`.
The deployed source hash matches the tested source. Health passed; configuration,
database, worker and Ollama were unchanged. No executing business operations were
present before the app-only restart. Both Docker container listings showed only
the four production containers afterward.

Read-only post-deployment checks confirm plan 372 remains at revision 12 and
recovery 21337 remains unresolved and preserved. The existing group's global
definition is still retired: deployment changes future explicit regrouping,
and does not silently restore business records or promote the recovery draft.
In the existing draft, explicitly ungroup/regroup GOA-10979-10980, put the group
back on its load, then save to apply a fresh reactivation through the corrected
path.

# SCM search and local Vendor completion — evidence

Deployed on 2026-09-10. Searching `POB03781` now returns the order in SCM Working
even with Queued selected. Vendor PO/TO/VRMA rows expose a local Complete action.
The action records the authenticated operator and timestamp, remains Completed
after refresh/reconciliation, and requires no plan, Driver job, or NetSuite update.

Specification: [scm-search-vendor-completion-spec.md](scm-search-vendor-completion-spec.md).
Spec approval was not obtained; this was an autonomous run within the user's
explicit request. No git commits or new package dependencies were made.

## Final feature verification

Reproduce from the server directory:

```sh
bash tools/scm-search-vendor-gauntlet.sh --focused
bash tools/scm-search-vendor-test.sh run npm run test:mbt
```

The first command builds the test image, migrates an isolated PostgreSQL database,
and runs all feature layers. Omitting `--focused` also runs the full MBT suite and
returns its unmodified exit status. Tests use disposable database clones, an
internal Docker network, and no production credentials. The test wrapper can
bootstrap its dependency image through the repository's `Dockerfile.test`.

Final focused run artifacts are in `test-artifacts/scm-search-vendor/`:

| Layer | Actual result | Artifact |
| --- | --- | --- |
| Service, database, authenticated HTTP, properties, Chromium | 23 tests across 4 files passed; 0 failures or skips | `focused.log` |
| Existing schedule columns, filters, remaining quantities, remarks, row refresh, closed-order handling, VRMA | 25 tests across 9 files passed | `regression.log` |
| Randomized focused file order, seed 197 | 23 tests passed | `shuffle.log` |
| Input properties | 200 authorized normalization cases and 100 unauthorized cases, seeds 197/198 | `focused.log` |
| Concurrent HTTP requests | 12 requests produced one event and 11 idempotent replays | `focused.log` |
| Changed code coverage | New service 92/92 lines and 4/4 functions; branches 40/45 (88.88%); changed query setup 5/5 statements and endpoint 15/15 statements exercised | `coverage.log`, `coverage/` |
| Manual mutations | 5/5 killed; authorization mutation also killed by the property test alone; source restored | `mutations.log` |
| ESLint | Passed with zero warnings | `lint.log` |
| TypeScript | New `@ts-check` completion service passed; legacy imported files are not claimed as newly typed | `types.log` |
| Secrets | 12 new paths and the separate release changed-line patch scan passed | `secrets.log` |
| Git whitespace | `git diff --check` passed | Gauntlet exit 0 |
| Exact release backend | 17 tests passed against the production image using disposable databases | `release-tests.log` |
| Exact release UI | 4 Chromium tests passed using release JavaScript and mocked APIs | `release-browser.log` |

The database and HTTP tests reject forged roles/methods, stale revisions including
submillisecond changes, ambiguous or missing references, cancelled/review-blocked
orders, and missing source records. An injected database failure verifies atomic
rollback. Completion preserves source order headers/quantities and existing
plans, Driver jobs, and the posting queue. Browser tests exercise the actual
schedule script, click handler, status-search override, clearing the search,
visibility rules, and rejected-request feedback. Their API boundary is mocked;
the separate HTTP tests exercise the real Express endpoint and authentication.

## Baseline comparison

Before implementation, the full MBT run had four failures. The run after the last
production-code change completed 451 files: 449 passed and two retained failures
(2,235 passing tests, 2 failures, 1 preexisting skip). Logs preserve the original
results; these tests were not skipped or relaxed:

- `P3.11: the extended mutation manifest owns every dedicated runner and the P3 gauntlet executes it`
  — two preexisting runners, `run-schedule-column-mutations.mjs` and
  `run-scm-ir-split-reference-mutations.mjs`, are absent from the existing inventory.
- `Dispatch edit popup keeps planning and CO controls left and SO instructions right`
  — the existing test expects an older Dispatch asset version.

The two original migration-inventory failures were resolved as part of registering
migration 197; the preceding migration 196 is now included in those expectations.
The new mutation runner was added to both the manifest and the explicit test
inventory. After that test-only registration, the inventory test was rerun and
confirmed to fail only for the same two older missing runners
(`baseline-inventory-confirm.log`). The disposable HTTP fixture password was also
renamed to an explicit test placeholder; the final feature gauntlet reran after
that edit. The broad MBT totals above are from before those two test-only edits;
the production implementation did not change afterward. No new regression was
observed. The broad suite is not claimed to be fully green.

## RED and corrections

Saved original UI produced two behavioral browser failures: search kept the
Queued status constraint and the Vendor Complete button was absent. Initial
repository tests failed on the active-only search and missing completion behavior.
A later regression caught receipt reconciliation outranking explicit Vendor
completion; migration 197 now places Vendor evidence ahead of reconciliation.

Setup corrections are retained in the logs: Chromium was initially absent and
was installed into the existing test browser cache; a fixture used an invalid
initial status and an assertion initially inspected raw instead of calculated
status. An initial coverage command incorrectly applied the global legacy-module
threshold to large unrelated files; the persisted command instead enforces 100%
line/function coverage on the new service and coverage of the changed regions.
The secret scanner identified the synthetic HTTP fixture password; it was renamed
with an explicit `Test` prefix and the checks reran. No assertion was removed to
make these changes pass. Existing status-filter tests now use the order column
filter for fixture scoping because global search intentionally supersedes status.

## Release and local-only verification

Release image: `mbbs-operator-app:scm-search-vendor-20260910-v1`

Digest: `sha256:2f6f0c439a30d7b5bf4b0ad2744c281116763b2f699a7ec010f3cfeea05422cc`

Release files, task-only patch, source hashes, schema backup, and scripts:
`/home/ubuntu/operatorapp-deploy-backups/scm-search-vendor-20260910/`.
This thin image extends the previously running schedule-columns image. It includes
only the search/UI/endpoint delta, completion service, and migration 197. Concurrent
unrelated workspace changes, including split lookup changes, were excluded.

Migration 197 applied transactionally with bounded lock/statement timeouts. It
adds Vendor completion evidence constraints and a view-ranking branch while
preserving the existing corrected-VRMA reference exclusions. Only the app service
was recreated; the worker and dependencies retained their existing images.

Read-only production verification returned health HTTP 200 and served the updated
asset. Local search with `search=POB03781`, `status=Queued`, and `view=scm working`
returned `POB03781`, method Vendor, calculated status Completed. External fetch was
explicitly forbidden during the repository query. At verification there were zero
`scm_vendor` completion events in production: no real order was completed by this
work. Full results are in `verification.json` and `deploy.log`.

Rollback image: `mbbs-operator-app:rollback-before-scm-search-vendor-20260910`.
An app-only rollback leaves the additive schema and any subsequently recorded
completion evidence intact; do not delete completion events to roll back code.

## Scope and limits

No external API permission changes, NetSuite writes, dependency upgrades, or new
network capabilities were introduced. Existing non-status filters, audience
restrictions, native closed-family exclusions, and split/group identity rules
remain. No dependency vulnerability audit was repeated because the release adds
no packages. No visual pixel comparison, full-suite randomized replay, or live
production completion was performed; focused Chromium behavior, seeded file-order
checks, isolated HTTP/database concurrency, and read-only live verification cover
the change. Line coverage does not prove every branch or every production data
shape; the explicit branch result and known baseline failures are reported above.

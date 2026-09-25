# Aggregate SCM release — 2026-09-25

Deployed successfully at **13:41:21 UTC** to [SCM Aggregate Requests](https://test.mbbsoperation.com/scm/stock-requests?tab=aggregate).

SCM can change Delivery / collection date in Confirm loads and Revise confirmation. The actual-report due date follows by one calendar day, and request history shows the old and new dates. The release also includes the global pending-request alert and exact Toronto submission timestamps. The original submission timestamp does not change when SCM changes the schedule.

This followed the [old-coder workflow](/home/ubuntu/.codex/skills/old-coder/SKILL.md), Tier 2 with compatibility and concurrent-save checks. Spec approval: not obtained (autonomous run); the [acceptance criteria](aggregate-confirmation-date-spec.md) were stated before implementation, but there was no separate human spec review. Confidence is limited to these tested behaviors and the recorded release scope.

Acceptance coverage:

| Spec | Evidence |
| --- | --- |
| 1: editable date, due-day preview, preserved form | Chromium confirmation-date scenario checks initial value, required/max validation, preview, focus refresh and Chinese/English changes. |
| 2: atomic saved schedule and unchanged submission data | Repository reload, authenticated HTTP and requester browser checks verify both dates, quantities and original `createdAt`. |
| 3: compatibility and late confirmation | Domain and HTTP tests confirm omission preserves dates; domain scenarios accept earlier calendar dates. |
| 4–5: date validation and calendar boundaries | Invalid-input tests cover empty/null/non-string/invalid days/year bounds; 300 seeded property cases plus explicit leap-year, year-end and DST examples verify the following due day. |
| 6: authority, retries and concurrent writes | Domain/HTTP permission and state checks, repository retry/stale-save tests, concurrent confirmations and existing transaction/audit rollback cases pass. |
| 7: audit history | Repository snapshots and the browser history line show the date change. |
| 8: regression and release preservation | Exact candidate passes all 85 Aggregate checks and 16 neighboring checks; source hashes, configuration and unchanged worker/database/other-service identities are verified. |

Final validation results:

- Workspace feature suite with coverage: **70 passed**, no failures or skips.
- All eight Aggregate test files in seeded shuffled order: **85 passed**, no failures.
- Exact release candidate: **85 Aggregate + 16 neighboring checks passed**, no failures or skips.
- Changed executable lines: **44/44 covered** (domain 15/15, repository 2/2, client 26/26, translation 1/1). Both edited server modules have 100% line/function coverage and 96.42% combined branch coverage.
- Manual mutation loader: **5/5 defects detected**—ignored selected date, two-day due offset, invalid rolled-over calendar date, broken legacy confirmation and missing persisted dates. Mutations were applied in the loader; workspace source files were not altered.
- Syntax, ESLint, domain TypeScript checks and Python release-tool compilation passed. Secret scanning passed for the 15 scoped runtime/tool files. No dependencies were added or changed.
- Real execution used isolated PostgreSQL and Chromium, including the SCM date selector, global alerts and requester workflow. The confirmation form screenshot was reviewed.

The nine new date tests first failed against the previous implementation, then passed. Lint identified a shadowed test-fixture variable; it was renamed without changing assertions. No behavior assertions were weakened.

The repository-wide cross-domain MBT suite was not rerun: the regression scope was all Aggregate tests and affected shared UI/cache contracts, tested again against the exact release candidate. No confidence is claimed for unrelated pending workspace changes; the release patch retained the live versions of those files. Dependency audits, license changes, migration rehearsal and performance benchmarks were not applicable because no dependency, schema or stated performance budget changed.

Reproduction: `bash tools/aggregate-confirmation-date-gauntlet.sh` replays static checks, feature tests/coverage, five mutations, shuffled Aggregate suites, neighboring checks and the secret scan in the existing isolated Docker test environment. Node version: **20.20.2**; runner image: `field-sales-check-2941306:latest`. Raw coverage and browser evidence are retained under `test-artifacts/aggregate-confirmation-date/raw/`.

Release:

- Image: `mbbs-operator-app:aggregate-scm-alert-date-20260925-v1`
- Image ID: `sha256:68c5f04379a0f488dc37aa93cdf483052075f7f889f6d869717021d9bb56c9dd`
- Verified source hash: `fc4380dc05723a5edcbf39f95ecca2d5c49bf140594c99732eb13c46f054fc24`
- Exactly 12 runtime files changed; the patch applied with zero fuzz. Unrelated live Operator asset versions were retained.
- Local and public health returned HTTP 200; both Aggregate pages loaded; four protected APIs still rejected anonymous access; all 10 public asset hashes and all 12 container file hashes matched the candidate.
- Read-only database verification passed, including saved schedules and the unfinished-yard index. No migration or live test request was created.
- Application configuration, webhook worker, database and other services were preserved. No active postings, fulfillments or dispatch editors were present at cutover. Startup error checks passed.
- Previous application image retained as `mbbs-operator-app:rollback-aggregate-scm-alert-date-20260925-v1`; no rollback was needed.

Release tool: [aggregate-scm-alert-date-deploy.py](../tools/aggregate-scm-alert-date-deploy.py), stages `record`, `prepare`, `build`, `check`, `apply`, `verify`. Release manifest, exact patch, baseline/candidate sources, test logs, Compose rollback override and deployment result are retained in `test-artifacts/aggregate-scm-alert-date-deployment-20260925/`. Feature evidence is in `test-artifacts/aggregate-confirmation-date/`.

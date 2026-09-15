# Operator yard access and PWA evidence

The user approved the implementation plan on 2026-09-15. This is a Tier 3 authorization change under the old-coder workflow. The approved scenarios and failure model are in [the specification](operator-yard-access-spec.md).

## Final verification

Run all layers from the repository root:

```sh
bash server/tools/operator-yard-gauntlet.sh
```

The runner uses disposable PostgreSQL databases and existing Docker images; it does not use production credentials. It reconstructs the pre-change sources using the persisted [baseline patch](support/operator-yard-baseline.patch) if the saved snapshot is absent. Every result below is from the final fresh run after the last implementation and test edit. Source hashes were checked again at completion.

| Layer | Final result |
|---|---|
| Authenticated API, policy, migration-related behavior and asset checks | 47/47 passed |
| Operator and retained Dispatch browser behavior | 35/35 passed |
| Separate browser coverage run | 21/21 passed |
| Existing pickup, receiving and fulfillment browser regressions | 72/72 passed across Chromium desktop, Chromium mobile and WebKit mobile |
| Full MBT suite, shuffled with seed 20260915 | 2340 passed, 2 pre-existing failures, 1 skipped; 465 files completed |
| TypeScript | 233 existing diagnostics; 0 new |
| ESLint, including new authorization function complexity ≤12 | 37 existing diagnostics; 0 new |
| Changed executable JavaScript lines | 483/483 covered; detailed V8 ranges retained |
| Manual mutation | 5/5 killed by focused checks, separately 5/5 killed by properties alone |
| Secret scan | 0 findings across the change and eight new tool files |
| Existing Admin authority harness | Passed against the new schema |

The two baseline failures, reproduced on the original source, are:

- `P3.12: browser specs share one worker-owned database-pool lifecycle`
- `quality non-regression: the gauntlet builds and validates the omit-dev runtime`

They are unrelated infrastructure contract failures. No assertions were disabled to accommodate them. The initial baseline run accidentally used the current migration inventory; a subsequent run with the original migrations and readiness tool verified the migration and inventory checks pass on that baseline.

Recorded tools: Node v20.20.2, fast-check 4.9.0, ESLint 10.8.0, TypeScript 7.0.2, c8 12.0.0; Playwright 1.62.1 and PostgreSQL 18 from the existing test images. No dependencies or commits were added.

Source-tree SHA-256: `5bb56fa75434d206a863e47d1c16835e9498bf0c5dbce20497b8dffcd0f32bc1`.

## Scenario coverage

| Approved behavior | Executable evidence |
|---|---|
| Independent grants, empty defaults, audit, omitted updates, live sessions and admin access | Account round-trip, create/update/revoke, invalid-input and policy property cases in `operator-yard-access.test.js`; migration-upgrade and readiness inventory tests |
| Zero/one/multiple yards, reload within a login, new login selection and Admin's four yards | Actual Operator browser entry, login/logout/reload, persisted-yard and Admin cases |
| No stale account data or unsafe yard switches | Delayed receiving response, locked return, account replacement, focus revocation, queued permission refresh, reconnect and 401/403 browser cases |
| Actual stored yard before reads or mutations | Real API tests for SO/TO/PO/CO, saved drafts, return replay, cycle counts, history, jobs, photos and instruction media; hostile query/body yard inputs |
| Groups require all child yards | Group detail/packing, saved/active/bootstrap/load/notification queues, standalone order preservation and generated grant/child-yard combinations |
| Shared consumers and saved work remain valid | Control access, shared inventory synchronization, accepted job/return status and saved-row assertions; 14 existing Dispatch browser cases |
| Available pallet balance only; quantity controls remain | Browser fixture 100 purchased −30 returned −10 reserved =60 available; historical values absent; existing quantity/confirmation/photo regressions retained |
| Delivery button sizes, filters and translations | Measured Active/Packed versus Batch/Saved widths at responsive sizes, EN/Chinese checks, and retained batch/filter behavior |
| Safe rollout | Additive migration 199, source hash match against the previously deployed files, versioned PWA assets, database backup and rollout postchecks |

Properties exercise strict grant parsing and normalization, independent assignment sets, canonical stored yards and grouped child yards with a fixed seed. The five final mutants are:

- Sales grants substitute for Operator grants
- Unassigned accounts inherit all yards
- Any assignment permits every requested yard
- Grouped records ignore an unauthorized child yard
- Record guard ignores the canonical stored yard

## Failures found and resolved

Behavioral RED runs demonstrated the original missing grant enforcement and UI differences. Later adversarial checks exposed return replay and live-feed disclosure, the posting-job field mismatch, a pending permission-refresh race, missed permission checks after reconnect, and first-child-only authorization for grouped orders. Each now has a focused regression. The pending-refresh race was reproduced with a deliberately delayed response before fixing it.

Older browser fixtures were given explicit Operator assignments and an account/session-bound saved state to comply with the approved access change. Exact asset revision and migration-count contracts were updated for the release. Fixture corrections used the existing API's nested batch response, one daily dispatch plan and actual photo minimum. Behavioral assertions were retained. A test-only signing key was changed to a generated value after the secret scanner flagged its literal. The coverage collector was corrected to measure the executable token after a closing brace rather than attributing an `else if` to the previous branch.

## Limits and rollout

The suite uses real Express requests and PostgreSQL, plus real browser execution. NetSuite and photo-worker network boundaries are simulated in focused tests; no live NetSuite transaction was posted by the gauntlet. No dependency audit was needed because the dependency set did not change. Detailed V8 branch ranges are retained, but the enforced coverage metric is changed executable lines. A production-size database restore was not performed; the completed private backup was read through `pg_restore` without connecting to a database. Rollback retains the additive column and returns both services to the prior image.

Non-admin Operator assignments start empty. An administrator must assign Operator yards in the account editor; Sales/Control assignments are separate. Admin retains yards 1, 28, 15 and 26. Yard 195 is not added to the Operator PWA. The release is based on the deployed Dispatch/SOV image, preserving those prior fixes.

Deployment results are recorded after rollout in `test-artifacts/operator-yard-access/deploy-postcheck.json`, alongside health, migration and image logs. Rollout and rollback configurations are retained in `docker/backups/operator-yard-access-20260915/`.

### Completed rollout

Both services are deployed on `mbbs-operator-app:operator-yards-20260915-v1`. Migration `199_operator_yard_access.sql` applied successfully. The app is healthy, the webhook worker is running, and both have zero restarts. All 21 deployed runtime file hashes match the verified source. Operator, Admin, Control, Dispatch and service-worker assets returned HTTP 200.

The live permission check verified 20 accounts: 3 administrators retain all four yards; 17 non-admin accounts have no Operator assignment; 0 have an explicit assignment. No grants were copied. Database backups are mode 0600; the final archive was fully read by `pg_restore` without database writes.

The rollout command initially rejected an unsupported Compose `run --no-build` flag before running a migration. Removing that flag allowed the existing validated image to be used; the migration and rollout then passed all postchecks. The deployment script records the failing line and restores the previous app/worker image if a post-switch check fails.

The full suite's one skipped case is the existing migration-175 cross-charge cutover test. It requires the opt-in `MBT_CROSS_CHARGE_MIGRATION_CUTOVER_TEST=1`, which the standard full-suite environment does not set. It is not included in the passing-test count; migration 199 upgrade/idempotency checks ran successfully.

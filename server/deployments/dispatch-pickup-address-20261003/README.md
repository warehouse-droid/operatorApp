# Pickup address release — 3 October 2026

Deployed at 07:20 UTC to https://test.mbbsoperation.com. The image is
`mbbs-operator-app:dispatch-pickup-address-20261003`, SHA-256 `f528e87e207f174c000338c2bad3a91cd9038cc82b7551cab4230803e4ccb137`.
It extends the current BOSS reject/close release and changes only Dispatch JS,
its cache version, pickup visit matching, and SCM pickup reconciliation.
The worker, database schema, credentials, configuration and all later features
were preserved. Local and public health, exact public asset hashes, protected
BOSS/audit endpoints, SMTP readiness and read-only approval history passed.
No test email or live order/plan mutation was used for this release.

Fresh candidate verification: 26 focused tests including real Chromium, 140
BOSS/login/reset tests and 27 reordered checks passed. Five plausible manual
mutants were killed; 28/28 changed executable lines were covered. The captured
baseline reproduces the pickup bug. The adjacent suite passed 58/60 both before
and after, retaining RP-08's obsolete asset expectation and RP-05's active
travel assertion. Both legacy pickup/load harnesses also fail identically in
this test environment. Lint retained 1,323 diagnostics and TypeScript 183
normalized unique diagnostics, with no new diagnostics. Assertions were not
weakened. See validation.json for exact results and source hashes.

The acceptance mapping remains in ../../test/dispatch-pickup-address-evidence.md.
Spec approval: original autonomous implementation; explicit user approval to
deploy, commit and push this fix on codex/dockerVer. The original September 28
blocked release was superseded; its old image was never deployed.

From a clean checkout of this production snapshot, with Docker and the recorded
mbbs-regular-v2:e2e and postgres:18-alpine test images available, run:

    python3 tools/pickup-release-verify.py

This reconstructs the four-file baseline using workspace.patch, runs isolated
fixtures with external writes disabled, and regenerates coverage/evidence.
Detailed run logs remain under ignored test-artifacts/dispatch-pickup-release-20261003/.
Tool versions are recorded in toolchain.json. There are no production dependency
changes or migrations in this pickup release. Dependency audit was not repeated
for the unchanged production dependency set. The full unrelated application
suite was not rerun; affected dispatch/SCM and BOSS/login flows were checked.
Address equivalence is normalization, not geocoding. Public verification does
not exercise a live order write. Prepared rollback pins the previous image;
a real rollback was unnecessary after healthy cutover.

# Transfer dependency date context and completed unlink — Tier 3 evidence

Status: final gate passed; deployed and verified on September 8 at 15:57 UTC.
Spec approval: not obtained (autonomous run). The specification did not receive
independent review; the evidence demonstrates the stated constraints, not
absolute correctness.
Spec: `test/dispatch-transfer-completed-unlink-spec.md`.
Entry point: `bash server/tools/transfer-unlink-gauntlet.sh` from repository root.

## Root cause confirmed against production, read-only

GOB-118670-118675-119387 is assigned to September 8 plan 313, revision 19 at
inspection. TOB00957 is indexed in confirmed September 1 plan 265, Li Load 5.
Its Driver drop completed at `2026-09-01T22:35:58.248Z`; its mirrored NetSuite
fulfillment/receiving statuses still read not fulfilled/not received.

The first dependency validation receives the plan date. Inside
`saveDispatchPlanSnapshot`, a second validation follows sanitization of a new
object that contained ID/orders/trucks but omitted planDate. Consequently
`priorPlannedTransferRefs` returned an empty set. Read-only reproduction using
the same live plan returned no conflicts with its date, and the exact reported
"requires TOB00957 to complete earlier or finish before its pickup" warning
without it. The baseline integration test reproduced the failure in that exact
second validation, not a mocked validator.

The separate unlink preview considered any started OR completed Driver job an
execution blocker. Repository cancellation additionally rejected completed
dependency statuses/quantity progress. The fix recognizes authoritative receipt
or completed drop evidence, exempts only that finished transfer from unlink
guards, retains target/lease/revision/offline guards, and cancels the relationship
without changing execution rows. Group ownership is now checked for completed
links too. Removed relationship projections cannot reappear after refresh.

## Scope and reproducibility

The Dockerfile layers four repository/policy/service files and two exact edits
to the deployed plan repository onto the September 5 production image. No public
assets, packages, migrations, environment settings, or unrelated planner-V2
draft changes ship. The plan-patch builder asserts each anchor occurs once.
The gauntlet freezes runtime files from the candidate image and compares the
excluded V2 file and all public assets byte-for-byte with baseline.

Fresh captures are under ignored `test-artifacts/transfer-unlink/`. The incident
capture is mode 0600 and is deliberately not committed; reproducing the actual
historical-data checks requires that private capture or authorized read access
to recapture it. Capture tools are persisted, use read-only repeatable-read
transactions, and do not issue production writes. Generic history capture uses
salted pseudonyms and excludes names/addresses/photos. The incident rehearsal
copies only this dependency's source rows and affected GOB load snapshots into
an isolated database, then rolls every rehearsal back.

## Acceptance mapping

| Constraint | Executed check |
|---|---|
| Prior-day TO survives both validations | `transfer-completed-unlink.test.js`: preflight/full/incremental save |
| Later, same-day, cancelled-plan and stale flags cannot bypass timing | `transfer-completed-unlink.property.test.js`: date-order properties; existing order-dependency rollback harness covers same-day load/Driver/TO sequence |
| Receipt, completed Driver drop and completed dependency allow unlink | Integration tests exercise the real preview, command, save, audit and receipt repositories |
| Pickup-only, active transfer, started target and mode change stay blocked | Integration negatives and exhaustive database completion properties |
| Ownership, Operator work, closed target, stale revision/signature, lease and terminal target plan | Named integration guards; existing preview/policy tests cover offline evidence |
| Preserve history, remove stale link projection | Exact before/after execution-row checks, idempotent command retry, reload checks, five captured GOB load replays |
| Rollback and concurrency | Injected validation failure after real relationship/plan writes; 32 concurrent cancellations with one audit |
| Existing CO cargo behavior | CO cargo preservation, repair and frontend tests retained in focused gate |

## Honest failures and limits

- Initial RED run reproduced the date-loss save failure and all three completed
  unlink failures. A new completed-group ownership test subsequently exposed and
  caught an ownership exemption, which was corrected before release.
- Rehearsal setup initially omitted test fleet/lease records and valid Operator
  role arrays. Fixtures were corrected without relaxing safety expectations.
- Cargo oracle refinement is explicit in the spec: zero cached allocation fields
  may be absent after refresh, but must remain zero; all other cargo fields are
  compared exactly.
- The first type-check extractor stopped at the closing destructured parameter
  brace. It now extracts the whole shipped pure policy; legacy graph type
  checking remains unclaimed.
- The first mutation attempt could not write to a read-only mount. Disposable
  per-file writable overlays fixed the harness. A later property-only survivor
  showed that the random sample omitted completed-pickup-only evidence. All 16
  Boolean completion combinations are now explicit examples; assertions and
  implementation were not weakened.
- Four unrelated checks fail on the current live baseline: three undeployed
  incremental PO-draft tests and the old Driver-order harness's September 3
  asset-token assertion. They are rerun unchanged on baseline and candidate,
  with exact failure-name comparison and zero new failures required. They are
  not reported as passed. The main baseline suite passes 2,198 tests.
- Generic seven-day replay is a snapshot/event/route compatibility check, not
  exact transactional network-event playback. The targeted replay exercises
  the actual save and unlink workflows for the affected load, not every other
  order/load from each production snapshot.
- No browser/UI layout or real offline-device session was exercised; assets do
  not change. Existing API/policy tests and real repository workflows cover the
  server change. No live stress traffic or production unlink is performed.
- No new dependencies or capability expansion; dependency audit/license changes
  are not applicable. No benchmark/SLA or whole-legacy-file branch coverage claim.

## Final fresh results

All numbers below come from the unchanged final run:
`test-artifacts/transfer-unlink/final-JexWgx`.
Earlier failed/aborted trial artifacts remain separate and are not substituted.

| Layer | Final result / persisted command |
|---|---|
| Main regression | `npm test`: 440 files, 2,198 tests passed, zero failures |
| Focused regression / real repository workflows | `run-co-cargo-tests.mjs ordered` with the gauntlet's explicit list: 16 files, 75 tests passed |
| Suite health | Same 75 checks passed in shuffled file order, seed 74537455 |
| Stress | 32 concurrent completed-TO cancellations: one write/audit, 31 idempotent replies; history unchanged |
| Property tests | 1,000 pure-policy cases; 64 database completion cases with all 16 Boolean combinations explicitly included; 24 date-order cases with explicit boundary examples |
| Changed-line coverage | `check-transfer-unlink-coverage.mjs`: 66/66 changed runtime lines executed; per-file counts 2, 47, 5, 10, 2 |
| Mutation | `run-transfer-unlink-mutations.mjs`: 5/5 killed by full tests and 5/5 killed by property-only tests; restoration hashes checked |
| Syntax/types/lint | All scoped syntax commands, extracted new-policy type check, and configured lint passed with zero errors/warnings; legacy graph type checking is not claimed |
| Secrets | `scan-diff-secrets.mjs`: 29 paths and changed-line diff checked, zero high-confidence findings |
| Existing failures | `check-transfer-unlink-baseline.mjs`: exact same four known failures on baseline and candidate; zero new failures |
| Seven-day event replay | September 1 15:20Z → September 8 15:20Z (168 hours, eight partial Toronto calendar dates): 3,732 event comparisons, zero projection mismatches |
| Pickup/history compatibility | 228 plan states, 1,207 late-order injections; zero validation failures, executed-prefix violations or Driver-scope failures |
| Actual incident workflow replay | Five affected GOB load snapshots (revisions 15–19): each full save and completed-TO unlink succeeded, two completed Driver records retained |

Historical replay has 40 explicit evidence gaps and 11 pre-existing strict source
conflicts; supported compatibility assertions all passed without mutating legacy
routes. No captured split-PO direct-ship or grouped-PO-link interactions exist;
those historical scenarios are unverified, not invented or marked covered.

Toolchain: Node 20.20.2, c8 12.0.0, ESLint 10.8.0, TypeScript 7.0.2,
fast-check 4.9.0. No packages or lockfiles were changed for this task.
Git base: `bfa00f4f674da517d06e82439f0d7af8d27c392f` plus preserved dirty worktree.
Frozen runtime source SHA-256:
`1290161b2c33ba4935ab22844f673c512bbad9bb16d5ca59f737b14887acd92d`.
Tested and deployed image:
`sha256:799b4140d6d4d1db5f7c37cdf4f2b289eff47105d675edabe3cbedc0a6f7ea4c`.

## Deployment verification

Only app and webhook-worker were recreated, using the exact tested image.
Compose differed only in their image names; environment comparisons matched
both previous live containers. App healthy, worker running, zero restarts;
`/health` and `/dispatch.js` returned HTTP 200. Startup error-pattern scans found
zero matches. Database start time remains `2026-08-14T13:14:47.59677958Z`.

Read-only post-deploy checks: plan 313 remains September 8 revision 19, no
dependency timing conflicts; dependency 219 remains active, with completed
transfer unlink permitted. Preview's sole remaining blocker is the existing
edit lease, not completed Driver activity. No lease was bypassed and no live
unlink or plan save was performed by this task.

Whole-row fingerprints before/after deployment match: two TOB00957 Driver job
rows `c129ab2e7ef2d15199f4cee4169b77c4`, and two dependency-line rows
`081da5de44e04857c8f28d2860615d56` (MD5 used only for equality checks).
The task's isolated test databases/networks were removed; reports, private
captures, frozen sources and rollback image remain available.

Deployment and rollback instructions:
`/home/ubuntu/operatorapp-deploy-backups/transfer-unlink-20260908.VS3CC5/RELEASE.md`.

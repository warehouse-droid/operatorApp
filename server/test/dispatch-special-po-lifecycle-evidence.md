# Special PO direct-pickup lifecycle evidence

Spec: [dispatch-special-po-lifecycle-spec.md](dispatch-special-po-lifecycle-spec.md).
Spec approval: not obtained (autonomous run). Tier 3 database lifecycle fix.

Status: deployed and verified in production at 2026-09-25T21:52:36.958623+00:00. The user saved
and closed the Dispatch editor before cutover; all preflight work queues were idle.

## Incident and change

LOINC-035925 / POB03921 (PO 1012343) is fully linked to GOA-9261-9263.
The material allocation is 1063.81 SQFT with zero allocated physical counts;
the PO displays 11 pallets. The previous coverage check counted those display
pallets as independent freight. Driver pickup completed at 18:12:40 UTC and
delivery at 19:25:43.188760 UTC on September 25, 2026, but SCM remained Queued.

Special PO route projections now reduce display quantities in proportion to
native Sales Qty. Database coverage uses native quantities for special items,
retaining physical-only protection when native quantity is unknown. The
existing Driver completion projection can therefore finish the linked PO.
Canonical Driver proof now also blocks duplicate planning under the displayed
PO reference and original NetSuite number, and restricts the PO card.

Migration 213 recovers missing special-PO completions from completed Driver SO
proof. Preview found 12 POs, including LOINC-035925; ten have every original
native quantity linked. The other two have already-received residual lines
(12 EACH PALLET on 3022007227 and two 1-EACH special fee lines on #263489).
Every candidate has zero outstanding native quantity. Receipt, allocation,
Driver and plan history remains retained; no NetSuite operation is issued.

## Acceptance evidence

| Spec | Executable evidence |
| --- | --- |
| Full/partial special native routing and immutable source | New unit and property lifecycle tests, plus existing route residual suites |
| Ordinary stock, inactive/unrelated links and unknown native quantity | New unit adversarial cases and existing ordinary-stock conservation properties |
| Planned then Completed, requiring every SO drop | New integration lifecycle tests with two SOs and a group target |
| Pickup and partial links cannot complete | New integration pickup, first-drop and partial-quantity cases |
| PO card and both aliases reject duplicate planning | New integration completion projection and server guard assertions |
| Historical repair retains timestamp and source history; replay safe | New integration migration test restores old predicate, records old Driver evidence, applies repair twice, compares history snapshots |
| Deployment and backward compatibility | Exact candidate and previous app/worker images booted on isolated migrated DB; migration run twice |

RED: the original implementation failed seven of ten new tests with actual
assertion/property failures. The first green run exposed a further server guard
gap; it and the missing card restriction were reproduced before correction.
The ten new tests now pass.

## Final verification

- Full repository suite: 3268 tests; 3241 passed,
  26 existing failures, 1 skipped, zero cancelled.
  All 26 failures reproduced in 19 files on captured production source
  (72 baseline tests: 46 pass / 26 fail). The stock-return fixture cache was
  explicitly aged to match its expiration during the long full run.
- Related complete suites: 123 tests; 121 pass / two existing failures.
  Shuffled order (seed 35925): identical 121 pass / two failures.
  Both failures reproduced on production: legacy Driver grouping harness
  assertion and stale Dispatch asset-version expectation.
- Mutation: seven of seven plausible mutants killed; four of four applicable
  mutants also killed by the property suite alone. Three DB/projection mutants
  are integration-only. Restored unmutated sources pass again.
- Generated native quantity cases: 1,000, fixed seed 35925; existing ordinary
  route properties add 1,000 generated cases.
- Changed JavaScript coverage: 28 / 28 changed non-comment lines executed.
  Route projection: 286/286 lines,
  21/21 functions,
  173/185 branches.
  SQL is exercised against PostgreSQL, without SQL branch instrumentation.
- Static checks: zero new lint/type diagnostics. Existing source diagnostics:
  16 lint entries and
  282 type-output lines.
  Test-only curly-brace formatting was corrected without changing assertions.
- Secret scan passed for the four runtime changes. No dependencies added;
  dependency/license audit skipped because package sets are unchanged.
- Runtime smoke: candidate app health 200 and worker started; previous images
  also booted against the migrated DB. No external writes; internal Docker
  network. Shared Operator/background priority coordination remained valid.

## Reproduction and release identity

`bash tools/dispatch-special-po-gauntlet.sh` repeats the full, related, randomized,
mutation, coverage, static and baseline comparison layers. It uses the prepared
source/baseline snapshot and the installed Docker test images. Preparation/build:
`python3 tools/dispatch-special-po-deploy.py prepare` then `build` on a new
release directory. Smoke: `python3 tools/dispatch-special-po-smoke.py`.

Node 20.20.2 test image `field-sales-check-2941306:latest`; Postgres 18 Alpine.
Existing tool versions: fast-check 4.9.0, c8 12.0.0, ESLint 10.8.0,
TypeScript 7.0.2. No new Git commit; existing dirty application work preserved.

- Runtime source hash: `91ace6a56adacbf9088e0bbbb718322f3652ce4a33c9850468eaae4ca8079ac4`.
- Candidate: `mbbs-operator-app:special-po-lifecycle-20260925-v1` / `sha256:6e3a452941d54a17b618ceff160e14cfa1b2e2fa49ac71a399be4caa5177dba6`.
- 1,079 runtime files verified in the built image; exactly four runtime changes.
- Previous production image: `sha256:1570a06d52cc4cd591f598034933fcc1bfe452d6e7bf22d4b68fe7e43c4d3613`.
- Fresh database backup: 397291072 bytes; 3522 validated TOC entries.
  SHA-256 `7b4b7d4234a4968e7c872d6c83809a4b5a750f0295d04ed19c7a47bf4ed9bd23`.
- Raw logs and manifests: `server/test-artifacts/dispatch-special-po-*`.

Known limits: broad legacy tests are not all green; zero new failures was the
release gate. No SQL branch-coverage instrument or live NetSuite write was used.
The production read-only probe verified the affected card, schedule, residual
and duplicate-planning guard immediately after deployment.

## Production result

Both app and webhook worker run the candidate image, with zero restarts and
1,079 verified runtime files each. Local and public health checks return 200.
Migration 213 recovered 12 PO completions from existing Driver evidence.
LOINC-035925 now reads Completed, has no residual route, and its card is
restricted from planning. Both LOINC-035925 and POB03921 are rejected by the
server duplicate-planning guard. Completion is September 25, 2026 at
19:25:43.188760 UTC, matching the real Driver drop record.

The database backup was refreshed after the waiting period. Configuration and
dependency containers were preserved. No rollback was needed.

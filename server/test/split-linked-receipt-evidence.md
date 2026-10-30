# Grouped split receipt fix — 2026-10-29

Spec: `test/split-linked-receipt-spec.md`. Tier 3. Spec approval: not obtained (autonomous run). The user explicitly authorized the POB04054 IR repair.

Migration `324_grouped_split_allocation_execution.sql` SHA-256: `07f01b6d54bf66f3b9611966544746fc9709fa936066089c95df810726d1681f`.
Recovery script SHA-256: `242c0580e0c22264cb5cd0c12a5a187293a4f88d1b67e9a0c3c9e3163ffaaca1`.

Reproduce the receipt gauntlet with `bash server/tools/split-linked-receipt-test.sh` from the repository root. It uses the bounded disposable Compose runner, removes its cloned databases, and removes containers, volumes, networks and generated artifacts even on failure. Node v20.20.2; existing repository dependencies only.

Observed results:
- RED: the new positive regression failed with no execution events, instead of the expected pickup/delivery pair of 27. The unchanged assertion passed after the migration.
- Baseline receipt suite: 275 tests, 274 passed, 1 failed.
- Candidate and reversed file order: each 293 tests, 292 passed, the same 1 failure. All 18 new tests passed; zero new failures.
- Existing failure in both versions: `the pallet follow-up creates a distinct IR draft and omits the already completed NetSuite line`. No unrelated assertion or source change was made to hide this failure.
- Four intentional SQL mutants were killed by the property test alone: omitted group identity, omitted exact line identity, inflated child quantity allowance, and disabled split matching.
- Property test: 20 generated quantity/sibling combinations, each exercised as valid, wrong group, wrong line and insufficient quantity. Exact quantities remain unchanged and siblings are not consumed.
- ESLint: zero findings in the new JavaScript test/check/recovery files; Node syntax checks passed. Python release script parsed successfully. No new dependency or credentials added. Scoped whitespace check passed.

Acceptance mapping:
- Exact S1 quantity, S2 unchanged, normal receipt admission: `grouped split records exactly S1 allocation and admits its receipt without S2` plus the generated property.
- Group, child, parent reference and numeric ID, line, item, quantity, malformed JSON, route, stop, retained order evidence, cancellation and aggregate allocation guards: thirteen named mismatch cases.
- Pickup location and incomplete job guards: `wrong pickup place or incomplete pickup cannot establish split delivery evidence`.
- No implicit backfill, transactional migration/recovery rollback, immutable completed jobs and repeated replay: `bounded historical replay adds only missing evidence and rolls back atomically`.
- Concurrent replay/claim uniqueness: twelve concurrent replay transactions followed by twelve concurrent receipt admissions, leaving one event pair, one receipt job and one immutable allocation owner. Existing partial receipt concurrency tests also ran.
- Existing ordinary receipt, reopen, cancellation and durable finalization behavior: the existing partial posting suites and full receipt regression selection in `partial-linked-posting-suites.mjs`.

Coverage limitations: SQL branches were exercised through real PostgreSQL scenarios; PL/pgSQL line coverage instrumentation and a SQL type/lint extension were not installed. PostgreSQL compiled and executed the migration. No application JavaScript runtime changed. This was the complete selected receipt regression suite, not the entire application test suite. No latency budget was specified or benchmark claimed. No supply-chain audit was needed because dependencies did not change.

Intermediate harness issues: a missing test callback terminator was corrected before the gauntlet; the first read-only operational inspection revealed that the live source exposes `quantity`, while synthetic sources also expose `orderedQuantity`. The recovery assertion was corrected to use the same fallback as the production receipt builder, then successfully checked against all nine live lines. Neither issue modified production evidence or created an IR.

Production outcome:
- Applied the database function migration atomically with a prior-function hash guard, lock timeout and saved rollback definition. No application restart or unrelated source release.
- Replayed only existing pickup 7399 and delivery 7403. Added the missing event pair for allocation 450, 27 PALLET units. Existing events 242–257 were unchanged.
- Admitted all nine existing active allocations 450–458 through the normal receipt pipeline; verified exact payload and nine claims before commit.
- Command/job `f86557ae-d56a-41a6-b327-cd4980ed1860` completed successfully.
- NetSuite IR **IR15340**, internal ID **1100681**, created from PO **1064064 / POB04054**. Verified all nine exact item/quantity/line identities in the real receipt. The app reports `receipt_status=received` and the same IR ID. A separate final NetSuite header read returned status F, advanced from status B before recovery.
- Before/after hashes for both completed driver jobs, every PO allocation, the S1/S2 definitions, the materialized S2 sales order and the sixteen pre-existing execution events matched. The two S2 pallets were untouched.
- Rollback and operational audit: `server/artifacts/pob04054-ir-20261029/`. Once the IR has posted, do not erase receipt evidence or rerun an unguarded transform; the recovery command recognizes its existing durable job.
- Final `docker ps` and `docker ps -a` showed only the four production containers. All four task test projects had zero containers, volumes and networks. The runner deleted generated test artifacts. Production `/health` returned `{"ok":true,"app":"MBBS Yard Server"}`.

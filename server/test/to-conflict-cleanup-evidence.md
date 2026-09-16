# Authoritative NetSuite TO conflict cleanup — 2026-09-15

## Scope and authorization

The user authorized resolving the previously skipped TO conflicts by respecting NetSuite, following the earlier instruction to dry run, test in an isolated container and apply. This follow-up selects the 26 TOs held for Receiving synchronization exceptions or an unsafe packed line. It keeps the other seven exclusions: six records in cancelled source families and one ambiguous local reference.

Spec approval: **not obtained (autonomous run)**. Live application is explicitly authorized; the separate executable spec was not reviewed by the user. Confidence is limited to the recorded acceptance criteria and checks.

- [Acceptance criteria and visible status-scope clarification](to-conflict-cleanup-spec.md)
- Workflow: [old-coder](/home/ubuntu/.codex/skills/old-coder/SKILL.md), Tier 3, scaled to a one-time local data correction.

All 26 have current NetSuite **G / Received** proof, read using SELECT-only SuiteQL. The 406 canonical source/destination lines have exact identities. The follow-up refreshes cached NetSuite status and line quantities for all 26, while preserving physical fulfillment/receipt timestamps and IDs. Driver/manual/direct completion continues to block replanning.

## Dry run and exact rehearsal

Manifest SHA-256: `ec4aa0f440043df7c823fd2abb6af1bc36a082c8ad0eb7f028b0a0ea1df7ba57`.

| Result | Count |
| --- | ---: |
| TOs corrected to Loaded and Received | 26 |
| Local completion; replanning remains blocked | 19 |
| NetSuite-only completion; planning remains allowed | 7 |
| Existing line updates | 504 |
| Missing canonical lines inserted | 2 |
| Quantity corrections | 4 |
| Inactive lines reactivated | 22 |
| Active duplicate mirror lines retired | 2 |
| New completion events | 0 |

The projected header changes are 16 Operator statuses, 16 yard statuses, 23 Receiving statuses and 14 cached NetSuite statuses/labels. Every target ends Loaded and Received, including targets already in one of those states.

| Receiving line | Before | NetSuite result |
| --- | ---: | ---: |
| TOB00956 — Alliance Supersand Grey | 1,120 EACH | **840 EACH** |
| TOB00965 — UNI-SIES-COP383-CEL-GN | 16 PC | 13 PC |
| TOB00975 — BC-AZ70S-RDM-NIP | 499.26 SQFT | 308.06 SQFT |
| TOB00975 — PALLET | 36 EACH | 34 EACH |

TOB00982 receives the missing outbound and Receiving lines for UNI-WIN60S-1530-SAFARI, quantity 218. Existing historical rows are retained. Current canonical lines replace stale accounting mirrors without adding duplicate cargo.

The isolated rehearsal copied all **922 TO headers and 6,649 lines**, reproduced the manifest exactly, tested transaction rollback, applied the expected 26 corrections and repeated with zero changes. All 19 local completions remained blocked; all seven NetSuite-only completions remained planable. Corrected orders disappeared from active Operator Delivery and pending Receiving feeds.

## Acceptance criteria mapped to evidence

| Spec scenario | Evidence | Status |
| --- | --- | --- |
| 1–2: Exact NetSuite authority and TOB00956 quantity | SELECT-only proof; concrete 840 EACH unit fixture; exact captured-data rehearsal | Pass |
| 3: Stage identity, mirror rows and preserved history | Canonical mirror and missing-line unit tests; atomic stage-isolation integration test; whole-state rehearsal comparisons | Pass |
| 4: Receipt requires G/Received; invalid proof and local holds rejected | F/G property tests; invalid status/identity/quantity tests; cancelled-state rejection; existing TO eligibility tests | Pass |
| 5 and clarification: Refresh cached status, retain local replanning block | Missing-line/local Driver integration test; 19 blocked and seven eligible in rehearsal | Pass |
| 6: Manifest, rollback, stale state and repeat | Four new database tests and exact production-data rehearsal | Pass |
| 7: Preserve unrelated operational evidence | In-transaction assertions over every TO header/line and protected Driver, receipt, posting, dependency, CO, plan, schedule and reconciliation state | Pass in rehearsal and live apply |
| 8: Actual projections and today's work | Read-only live verification described below | Pass |

## Validation results

- **52 focused tests in 11 files passed**, including 11 new tests. The files run in shuffled order with seed `20260915`, each with an isolated database.
- Three new properties run 240, 200 and 100 examples respectively: exact quantities/stage isolation/idempotence, mirror-row deduplication and rejection of partial NetSuite status.
- Five plausible mutants were killed by the full unit suite and independently by the property-only suite: **10/10 checks**.
- Both new core correction modules have **271/271 covered lines**, 100% statements/functions and **155/162 covered branches (95.67%)**. The seven uncovered branches concern missing unit/metadata, sole-alias fallback, optional receipt progress and a completion-only summary case. These branches are not claimed fully verified. Operational wrapper scripts are syntax-checked and exercised, not included in this core coverage percentage.
- Final static check: **12 JavaScript maintenance files**, zero syntax/lint findings, repository complexity limit 12 and depth limit 4. The Python collector compiles and the shell entry point passes `bash -n`.
- Secret scan: **16 paths**, no high-confidence findings. No dependencies were added or changed; dependency audit/license review was not rerun. Existing pinned tooling: Node 20.20.2, npm 10.8.2, fast-check 4.9.0, c8 12.0.0, ESLint 10.8.0 and TypeScript 7.0.2.
- Final type check has **233 existing diagnostics and zero new diagnostics**. The repository does not strongly type-check the new JavaScript maintenance modules; this result is a regression check, not full static type assurance.
- The final 136-file Dispatch run has **614 passed tests and the same 10 pre-existing failed tests across six files**, with zero new failures. The final 480-file application suite has **2,441 passed tests and the same two pre-existing failures**, with zero new failures. Exact failing names and comparisons are recorded in `evidence.json`.

Initial RED runs recorded assertion failures for the no-op projection and database stubs. A later explicit spec clarification changed the local-completion cached-status assertion from B to G; it failed before implementation and passed afterward. One provisional full Dispatch run used an older tool snapshot while this test was changing; that extra failure is excluded only because the fresh frozen-source run passes it. Two lint complexity findings were fixed without changing behavioral assertions.

No application runtime or UI files are deployed by this follow-up. Browser interaction tests from the earlier TO release remain applicable; no new browser run is claimed. Live operational checks are read-only. Posting/physical delivery writes remain covered by the earlier isolated TO HTTP lifecycle tests. Lock contention with arbitrary concurrent production writers was not separately fault-injected; stale before-images, changed cancellation state, rollback and protected-state assertions are tested.

## Reproduction and backups

Entry point from the repository root: `bash server/tools/to-conflict-gauntlet.sh`. It runs isolated focused/static/mutation/rehearsal/coverage checks, complete Dispatch and MBT suites, type comparison, secret scanning and the evidence collector. It never applies production changes. The guarded captured-data rehearsal requires fresh proof; a later replay must refresh/review its input rather than bypass the production freshness assertion.

Machine-readable evidence and exact logs are under `server/test-artifacts/to-conflict-cleanup-20260915/`. `python3 server/tools/to-conflict-evidence.py` checks final results against the recorded baseline and persists source hashes. Core source hashes are also embedded in the manifest and rechecked before live writes.

The isolated runtime is captured under `docker/backups/to-conflict-cleanup-20260915/runtime/`, from image `mbbs-operator-app:split-inbound-completion-20260915-v2`, image ID `sha256:f88721e506ea19ac24d47d0d5a21930236b9d32a421e4c21bde97450934e9240`. Concurrent workspace changes are excluded by that frozen runtime and test snapshot.

Backup: `docker/backups/to-conflict-cleanup-20260915/before-conflict-cleanup.dump`, SHA-256 `8513ecbc8603951bcaf5c22898df63a563dea44d1c1021524db4eba59b866303`. Newer exact before-images are in `production/before.json` and `production/manifest.json`. The CLI's `rollback` mode rehearses a transaction rollback; it is not an inverse cleanup command.

## Live result

Applied successfully at **2026-09-15 19:37:13 UTC**. The exact reviewed manifest corrected **26 TOs, updated 504 existing lines and inserted two canonical lines**, with no new completion events. All protected-state assertions passed inside the transaction. There were no NetSuite writes and no application deployment.

Read-only verification at **19:37:53 UTC** confirms all 26 are Loaded and Received, 19 local completions remain blocked from replanning, and seven NetSuite-only completions are planable. Repeating reconciliation proposes **zero order or line changes**. Actual Operator Delivery details for all 26 have zero warnings. Receiving detail shows Received for 25; TOB00984 is outside the existing Receiving worklist, while its stored Receiving status is Received. Completed targets are absent from active Delivery and pending Receiving feeds.

**TOB00956** now shows **840 EACH** for Alliance Supersand Grey, Loaded in Operator and Received in Receiving. Dispatch shows Complete and correctly blocks replanning because local delivery evidence exists. Its stale deleted-line conflict is cleared.

Today's Toronto plan **327** is confirmed and currently contains **22 loads**. All **five Driver routes / 69 jobs**, **24 SO details** and **four TO details** read successfully. No Operator warnings or cleanup-related blockers were found. TOB01070 remains Packed / Not Received, TOB01091 remains Open / Not Received, and both remain unrestricted for planning. TOB01086 and TOB01090 remain Loaded and locally complete, with replanning blocked; TOB01090 is Received and TOB01086 is outside the existing Receiving worklist. These ongoing orders were not part of this 26-order correction.

The seven remaining exclusions are `TOB00784`, `TOB00784-S1`, `TOB00784-S2`, `TOB00906`, `TOB00906-S1`, `TOB00906-S2` (cancelled source families), and `TOB00025` (ambiguous local reference). They were preserved by the transaction.

- [Per-order applied results](to-conflict-cleanup-results-20260915.csv)
- Apply/read-back artifacts: `production/apply-result.json`, `verification.json`, `runtime-verification.json`, `today-read.json` and `today-transfers.json` under the artifact directory.

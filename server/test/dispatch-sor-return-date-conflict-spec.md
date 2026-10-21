# SOR return date conflicts

Spec approval: not obtained (autonomous run). The reported planner defect authorizes this correction; this spec is available for review after the run.

Tier 3: the change protects persisted dispatch plans. Failure modes are a false conflict preventing a save, a missing duplicate guard allowing two routes for one return, and an incorrect alias reserving a delivery when only its return is scheduled. HTTP tests check both save protocols, database projections, rejection recovery, and unchanged earlier routes. Existing split and save tests protect genuine split ownership and revision guards.

Acceptance criteria:

1. Given SOR00221 assigned on October 8 and its open CUSTOM return linked by parentOrderRef, assigning SOR00221-Return on October 14 succeeds in both classic and V2 saves. The October 8 route is unchanged.
2. Assigning a return reserves its own reference only. It does not create a split_parent_alias for the delivery. CUSTOM type, customOrder=true, and sourceTable=dispatch_custom_orders each identify custom work, including legacy originalOrderId links and split-delivery returns.
3. A second assignment of the same return on another date is rejected and saved for recovery without changing the active plan.
4. Genuine splits keep their parent aliases. Whole-parent and exact-split conflicts remain blocked; sibling splits remain independent. Unassigned orders and return-only loads do not reserve work.
5. Delivery readiness, quantity snapshots, driver execution, API response formats, and existing edit leases are unchanged. Existing SOR lifecycle, concurrency, and planner suites verify those boundaries.

Setup: use the existing isolated Compose configuration with mbbs-tests.slice and its bounded services. Capture only application source, public assets, and migrations from the active image; use synthetic test orders and disposable databases. Reuse installed Node, ESLint, TypeScript, c8, and fast-check. Add no dependencies, migrations, or commits. Add regression tests and a reproducible verification/deployment entry point. Keep logs; remove all test containers, volumes, and networks in finally blocks. Release only the two planner files over the captured active image with a rollback image and configuration verification. Preserve operational plans and recovery drafts.

Verification refinement: the full baseline hangs in the pre-existing Aggregate browser delayed-request test. Apply the repository's existing 90-second per-file deadline from tools/stock-check-regressions.mjs, without changing test assertions or disabling files. Preserve timeout evidence and classify those files as unverified. Compare candidate failures and timeouts with the baseline; any newly failing or newly timed-out file requires investigation. Run the focused save, split, and SOR regressions without this full-suite deadline.

Scope refinement: run the complete Dispatch component suite (all six groups) against both captured baseline and candidate. The broader MBT application baseline was interrupted after unrelated Aggregate and bin-planning browser hangs; retain its logs as an incomplete, unverified attempt. Do not claim that the whole MBT application suite passed or completed. Dispatch's complete component suite, the focused SOR/save tests, and static/coverage/mutation checks are the release gates for this planner correction.

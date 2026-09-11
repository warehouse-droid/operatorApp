# Transfer dependency save context and completed unlink — Tier 3

Spec approval: not obtained (autonomous run, user requested fix/test/replay/deploy).
No new packages, migrations, commits, or automatic production unlink. Use the
existing Node 20 Docker toolchain and an isolated, disposable PostgreSQL database.
Preserve the dirty worktree; release only scoped changes atop the current image.
Add regression/property tests, replay capture/check scripts, a reproducible
gauntlet and evidence report. Retain source hashes and rollback image.

## Failure model and acceptance criteria

1. Lost date during full save: a TO assigned on September 1 must satisfy a
   September 8 SO/group dependency, including the second validation after
   sanitization. Full snapshot save and incremental command both succeed;
   order cargo and stops remain intact. Reproduce on the deployed baseline.
2. Fail-open scheduling: an absent, later, cancelled-plan, or incorrectly
   ordered same-day TO must still block. Read-only validation and save must
   agree; no reliance on stale NetSuite planned flags. Date input cannot
   override the stored owning plan date.
3. Completed manual unlink: allow unlink_to when authoritative receipt evidence
   or a completed Driver drop proves the transfer is finished, even if packing,
   receipt, dependency progress or historical completed Driver jobs remain.
   Completion of only the pickup is insufficient. Active transfer work still
   blocks. Unstarted links remain unlinkable; mode changes and new links retain
   their existing execution guards.
4. Scope safety: the exemption applies to the completed transfer only. Started
   target SO work, target Driver activity, stale revisions/signatures, a foreign
   lease, pending offline evidence and terminal target plans still block.
5. Historical integrity: unlink changes relationship status to cancelled, not
   line quantities, completed stop/job records, transfer orders, receipt data,
   or the earlier plan. Cancelled dependency projections must not reappear
   after refresh. Transaction failures roll back; repeated/concurrent unlink is
   idempotent with one audit entry.
6. Stress/property and seven-day replay: test boundary dates, timing, completion
   and non-completion, duplicate requests, preserved evidence and rollback.
   Replay fresh production history read-only/offline plus targeted actual save
   and unlink workflows in isolation. Record capture gaps and supported limits;
   generic snapshot replay is not an exact network-event reenactment.

## Gates

Baseline and final full regression suite; focused database/API tests in cloned
databases; shuffled repeat; changed-line coverage; syntax/types/lint/secrets;
3–5 real manual mutants and property-only run; real execution; seven-day replay.
Deploy app and worker only after pass, preserve DB and existing live relationship,
verify health and read-only incident checks. No browser/layout changes planned.

## Visible refinement — historical cargo oracle

The captured incident has five cached zero-valued `poAllocated*` item fields.
Relationship refresh deliberately removes obsolete projections. The historical
replay therefore asserts all five allocations remain numerically zero, and exact
deep equality for every remaining cargo field. It must not require a stale zero
projection to remain physically present. No quantity, unit, weight, pallet, item
identity, or nonzero allocation tolerance is introduced. This is an explicit
oracle correction discovered during the first real-data rehearsal, not a
production change or an unreported weakened assertion.

## Baseline findings — outside this release

The current live source passes the 2,198-test main suite. Wider dispatch checks
also reveal three already-failing incremental PO-draft tests (full/partial/
cancelled allocations) and one old harness expecting the September 3 browser
asset token despite the deployed September 5 asset. These were rerun unchanged
against both baseline and candidate. Keep their assertions and the unrelated
undeployed V2 draft untouched. The gauntlet must explicitly reproduce the exact
same four failures on both builds and reject any additional failure; they are
reported as existing failures, never passed tests. All new acceptance tests and
all supported replay checks must pass. This follows the skill's zero-NEW-failure
baseline rule, not a waiver for a regression introduced by this change.

# Split PO operational-status evidence precedence — evidence

Date: 2026-08-27

Original deployment state: not deployed. The 2026-09-01 addendum below records
the later authorized deployment and targeted production recalculation.

## Diagnosis

- `3022069120`: saved local schedule status was `Completed`; a later ambiguous
  same-yard receipt redistribution supplied only inferred partial quantity and
  attempted to regress the terminal child.
- `SN1397956`: actively planned, with no exact child receipt or Driver
  completion; inferred family quantity incorrectly promoted it to
  `Partially Done`.
- `TOB00960`: has a completed Driver pickup record, but no universal order
  completion event or completed destination/linked SO evidence. Pickup is not
  final completion, so this witness remains a negative sequence guard.

## RED evidence

The unit witness suite was written before implementation and failed because
`applySplitTargetEvidencePrecedence` did not exist. The rollback-only database
case then reproduced both invalid transitions before the precedence rule was
applied.

## Implementation evidence

- The evidence policy is isolated in
  `src/scm-split-status-evidence-precedence.js`.
- Reconciliation retains inferred quantities but requires exact/pinned
  evidence before inferred partial progress may become operational status.
- `Completed` is monotonic against later inferred redistribution, while real
  lifecycle conflicts and unrelated reviews remain fail-closed.
- Schedule projection now places every universal local completion event ahead
  of reconciliation review; this is not limited to `driver_job` evidence.
- A completed pickup alone is intentionally not converted into a universal
  order completion event.

## GREEN evidence

- Focused policy suite: 14/14 passed, including 1,300 randomized property runs
  and five adversarial cases.
- Final PostgreSQL split/reconciliation integration pass: 10/10 passed.
- Final focused frontend/unit/property/adversarial neighbor pass: 45/45 passed.
- Authoritative schedule integration: 2/2 passed.
- Schedule concurrency integration: 6/6 passed.
- Schedule HTTP stale-write integration: 1/1 passed.
- Clean-database delayed-refresh candidate integration: 2/2 passed.
- Reconciliation pure harness and reconciliation repository/database harness:
  passed.
- Policy coverage: 100% statements, 100% functions, 100% lines, 97.29%
  branches (required branch gate: 90%).
- Mutation score: 8/8 killed (100%); source hash restored afterward.
- Strict ESLint: passed.
- `tsc -p tsconfig.mbt.json --noEmit`: passed.
- Focused changed-line secret scan: passed with no findings.
- `git diff --check`: passed.

## Repair boundary

After an explicitly authorized deployment, a targeted reconciliation replay
for source families `POB03535` and `POB03658` can apply the corrected
projection idempotently. No blanket production reconciliation and no forced
completion of `TOB00960` is authorized by this evidence.

## 2026-09-01 deployment and live replay addendum

- Inferred prior `Completed` and `Partially Done` states now fall back to an
  operational scheduling state when exact/pinned/Driver completion evidence is
  absent: `Planned` only with a real active assignment, otherwise `Queued`.
- Authoritative completion remains terminal and monotonic; genuine review,
  cancellation, and closure behavior is unchanged.
- The final evidence gate passed status coverage at 100% statements/functions/
  lines and 97.29% branches, with 10/10 mutants killed. The combined allocation
  gate also passed 11/11 mutants, lint, typecheck, secret scans, and source-state
  restoration.
- Release `mbbs-operator-app:split-po-queued-20260901T215140Z` was deployed to
  app and webhook worker in 2.20 seconds. The database was not restarted and
  Driver PWA asset hashes were unchanged.
- POB03535 was recalculated twice in separate committed transactions. Both
  passes produced the same child result for `3022143273`: received `0`,
  remaining `2323.2`, `Queued`, reconciliation `ok`, not blocked, no active
  assignment, and zero open review cases.
- The persisted raw schedule observation remains `Partially Done` for audit
  history; both the SCM UI and Dispatch projection consume the authoritative
  `calculatedStatus`, which is `Queued`.

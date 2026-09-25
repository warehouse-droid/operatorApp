# CO execution identity and historical completion repair

User authorization: fix GOM-6531-6537 and the recurring CO completion bug.
Spec approval: not obtained (autonomous run). Tier 3: completion evidence controls
planning and can feed fulfillment. Preserve unrelated workspace changes. Use
existing Node, PostgreSQL, Docker, ESLint, TypeScript, c8 and fast-check tooling;
add no dependency and make no commits. Add a forward-compatible SQL migration,
focused executable tests, repair/deployment tools and an evidence report. Deploy
only this change over the running image after testing and rollback rehearsal.

## Acceptance criteria

1. A physical CO created from grouped SOs keeps its own CO reference in pickup,
   drop-off, detail scopes and retained driver jobs. A wrapper grouping physical
   COs expands to those CO children. Ordinary SO/PO/TO groups still expand normally.
2. Mixed physical visits preserve each stop's execution identity: completing a
   CO alongside a TO completes the transfer legs without completing source SOs.
   Job/stop/load IDs, photos, times, quantities and routing remain intact.
3. A stale/offline job containing source SO references is normalized at the database
   boundary only when its exact saved plan/load/stop, physical local CO, source
   membership and recorded destination prove the transfer identity. Ambiguous or
   unmatched historical records are reported rather than guessed from a prefix.
4. A CO reference never produces SO/PO/TO completion evidence, even when retained
   job details contain an obsolete SO type. Correct CO completion updates its
   existing local/canonical lifecycle and satisfies the transit prerequisite.
5. Repair confirmed historical cases with an immutable correction audit containing
   original references/details and exact plan evidence. Keep original completion
   events, photos, completion times and independent customer-delivery evidence.
   Only the erroneous driver-derived events cease to count for planning,
   completion projection, shortage and auto-fulfillment eligibility.
6. SOM06531 and SOM06537 become eligible for customer-delivery planning, and
   CO-GOM-6531-6537 becomes completed. Genuine customer delivery, manual completion,
   cancellation and closed-order protections remain effective in other cases.
7. Repeated repair and stale retries create no duplicate audit or completion.
   Repair rollback restores all mutable state and removes new audit rows atomically.
   Concurrent retries converge to one correct identity. No NetSuite writes occur.
8. Audit all detectable instances of the same defect; repair proven cases and
   report ambiguous ones. Do not reverse posted financial transactions or invent
   missing operational evidence.

## Failure model and verification

- Wrong order reopened: exact stop/CO/source/destination checks, adversarial
  mismatches, independent customer completion and generated group cases.
- Repeat/offline recurrence: production-shaped route tests and real PostgreSQL
  stale insert/update/retry tests, including grouped and consolidated visits.
- Partial repair or races: transactional rollback rehearsal, immutable ledger
  assertions, concurrent retries and idempotence checks.
- Downstream stale completion: test actual planning guards, canonical completion
  reader and auto-fulfillment eligibility against corrected evidence.
- Legacy data or deployment mismatch: read-only live audit, source-image overlay,
  baseline comparison, migration replay and post-deploy eligibility checks.
- Preserve history: before/after protected-field and original-event comparisons.

Record RED evidence, full-suite baseline and zero-new-failure comparison, static
checks, changed-line coverage, manual mutants (including property-only results),
randomized focused tests, source hashes, secret/dependency checks, live audit,
repair and deployment verification in reproducible repository tools.

Test-fixture correction: the schema allows only one plan per date, including
across focused test files sharing a disposable database. Allocate distinct plan
dates. The pre-existing immutable-row trigger reports "append-only; ... is not
permitted"; assert that exact rejection rather than an invented error wording.
Neither adjustment changes an acceptance behavior.

Shortage API clarification: its existing contract hides an open shortage when
the SO is dispatch-completed, including the `all` filter. The regression must
assert no candidate before repair and a five-unit candidate afterward, with
the stored five-unit quantity preserved; it must not expect a hidden row to be
returned with a completion flag.

Concurrent workspace isolation: an unrelated field-sales import/dependency was
added during verification. Freeze the already recorded seven-file CO patch over
the pre-task source snapshot, copy this task's tests/tools, and run final checks
from that tree. Keep other workspace edits intact. Candidate app/worker images
already contain only the scoped CO patch over each running service's own image.

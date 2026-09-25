# Operator Inventory acceptance specification

Approved in conversation: implement the proposed Damage Stock / Count Sheets plan.
Tier 3: inventory mutations, exclusive claims, retries and authorization.

## Setup and invariants

Use existing Node, PostgreSQL, Playwright, fast-check, c8, ESLint and TypeScript
tooling in isolated Docker containers; no new dependencies or checkpoint commits.
Preserve the current working tree's unrelated changes. Add an isolated test runner,
tests, additive migration, and reproducible gauntlet/evidence files. Record baseline
test failures before changes and require zero new regression failures.

## Named acceptance scenarios

- D1: 3445's active Damage child is 10; other yards resolve their own child. No
  missing/ambiguous/inactive/wrong-parent destination may post.
- D2: a report requires an inventory SKU, positive quantity, R1–R5 reason and
  at least one newly uploaded photo owned by its actor. Reused report IDs with
  different payloads, reused photos, negative/invalid quantities are rejected.
- D3: PLT/LYR/SEC/PCS convert using delivery factors; absence of factors uses
  the actual sales UOM ID, including Yard sales versus Ton stock.
- D4: monthly key is yard plus Toronto acceptance month. Memo is
  `3445 2026 Sep Damage`; retries across midnight retain their original month.
- D5: append to the existing monthly transfer, preserving all prior/manual lines;
  repeated SKU reports create separate lines. Concurrent reports create one
  monthly transfer. Identical retries create no additional report or line.
- D6: lost acknowledgments/crashes reconcile a stable report marker before any
  subsequent write; unknown outcomes never blindly append again. Definitive
  errors remain visible/retryable; ambiguous monthly matches block posting.
- D7: monthly review includes historic NetSuite lines, parses legacy memo month
  formats, deduplicates linked reports and honestly shows absent photos.
- D8: autocomplete + 70/30 camera/quantity entry, 40/60 monthly review; reason,
  photo, quantity and server errors retain the operator's work.
- C1: manager selects a permitted yard and distinct explicit SKUs. Only available
  sheets may be edited; submitted sheets are immutable and never adjust stock.
- C2: two concurrent Take actions have exactly one owner. Other operators cannot
  read count details, save or submit. Owner can resume the saved attempt.
- C3: 9 of 10 confirmed SKUs cannot submit; confirming zero for the tenth can.
  Unassigned SKUs cannot be injected; system quantities are hidden from operators.
- C4: reset archives previous counts, creates a new ownership generation and
  releases the sheet; stale saves/submissions fail. Cancel prevents further work.
- C5: count review shows confirmed count, system snapshot, variance, owner and
  attempt history, scoped to the manager's assigned yards.
- K1: 12 × 9 = 108 in PLT; 12 + 3 × 2 = 18; unit is unchanged. Clear,
  Backspace, chained operations, decimal arithmetic, invalid/incomplete/negative
  results and unit switching behave consistently without eval.
- K2: current panel width and digit pad remain; + − × = occupy one additional
  row. Cycle counts and count sheets share the calculator behavior.
- A1: every list/detail/mutation/photo read enforces session, role and yard scope.
- R1: existing cycle counts, delivery preparation, camera/photo authorization,
  control navigation and PWA assets retain their behavior.

## Failure model and evidence

Duplicate stock movement: SQL race tests + service lost-acknowledgment tests.
Lost or overwritten lines: adapter contract tests + concurrent worker tests.
Unauthorized yard/claim/photo: hostile HTTP and repository tests.
Incorrect quantity: arithmetic/conversion examples + fast-check properties.
Reset corruption: competing reset/save tests with attempt and revision fences.
Broken layout: real Playwright execution at tablet/mobile dimensions.
Migration damage: disposable database upgrade/rollback rehearsal.
Silent failures: persisted status/error/audit assertions.

Gauntlet: focused tests, browser smoke, full baseline comparison, static checks,
coverage, plausible mutants, randomized suite order, diff/secret checks and source
hash. Record exact results and any unverified layers in the evidence report.
Production NetSuite inspection is read-only; write rehearsal requires a sandbox.

Implementation clarification: the prior Aggregate navigation browser test explicitly
required Damage and Count Sheet to remain disabled. That obsolete expectation is
replaced with enabled-and-opens assertions, as required by this approved task;
the existing Cycle Count and Aggregate navigation assertions remain in place.

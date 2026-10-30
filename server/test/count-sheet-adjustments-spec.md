# Count sheet adjustments and recounts

User-authorized behavior (2026-10-21): VAR = Actual on hand − Counted + Adjusting.
Implementation proceeds autonomously; separate spec approval was not requested.
Tier 3 because resetting discards saved counts and must fence concurrent writes.

- A1: Every review row has an Adjusting numeric input immediately before Var;
  the review omits item descriptions. Inputs support signed quantities with six
  decimal places. 76.7 actual, 63.95 counted, and -2.75 adjusting produces 10.
  Var updates on every input event; Save adjustments persists all changed rows.
  Uncounted/cancelled rows cannot save adjustments. Unknown actual stock shows —.
- A2: Adjustments persist across reloads and operator re-confirmation; original
  counted quantities and inventory snapshots stay intact. Stock is never posted.
  Managers may edit counted rows in in-progress/submitted sheets at their yards;
  operators never receive adjustments/system quantities in blind count responses.
- A3: Invalid, nonfinite, excessive (>1e12 absolute), nonnumeric and >6-decimal
  adjustments, duplicate/unassigned rows, and stale revisions fail atomically.
- R1: Reset an in-progress sheet or re-open a submitted/cancelled sheet, after a
  confirmation describing deletion. Delete ALL saved count rows for that sheet
  (including archived attempts/adjustments). Retain sheet ID/title/yard/SKUs and
  operational activity history, clear owner/submitted_at, increment attempt and
  revision, and make the sheet available for an operator to take and recount.
- R2: Reset/re-open must not touch another sheet or inventory. Stale saves,
  submissions, adjustment saves and duplicate re-opens fail. Competing reset/save
  operations have only one winner; failure rolls back both deletion and state.
- M1: Migration adds adjusting=0 without changing counted quantities/snapshots,
  updates existing known comparisons to the new sign, and can be rolled back.
  Regular cycle-count variance is outside this change and keeps its behavior.

Setup: use existing Node, PostgreSQL, Playwright, fast-check, ESLint, TypeScript
and c8 dependencies; no dependency or git commit changes. Add focused database,
HTTP/browser tests, mutation loader and a reproducible bounded disposable runner.
The runner uses docker-compose.mbt-test.yml limits and mbbs-tests.slice, registers
teardown first, stores all generated data under MBBS_TEST_ARTIFACT_DIR, removes
containers/volumes/networks and verifies production health after each run.

Failure checks: arithmetic properties and browser input events for sign/precision;
real SQL concurrency, stale requests and rollback for data loss; real HTTP for
role/yard boundaries; migration rehearsal for existing data; full inventory
regression tests plus static checks, coverage and plausible mutants. Evidence
records repository-wide checks or explicit scope limits without claiming proof.

Existing count-sheet regression assertions are updated from counted-minus-actual
to actual-minus-counted, and reset now expects no archived counts, per the user.
Cycle-count assertions stay unchanged. Historical evidence documents describe
their original releases and are not rewritten.

## Formula correction — 2026-10-21

The user's later correction supersedes the arithmetic in A1 and M1 above:
**VAR = Counted − Actual on hand + Adjusting**. For 63.95 counted, 76.7 actual,
and -2.75 adjusting, VAR is -15.5. Positive adjusting still increases VAR.
Apply the same formula to immediate browser previews, stored confirmations,
adjustment saves, reconstruction and existing known comparisons. Migration 303
must preserve signed adjustments, counted quantities, snapshots and unknown
comparisons, and be idempotent. Applied migration 302 remains historical.
Reset/re-open behavior and cycle-count behavior remain covered by regressions.
The user's deployment authorization applies to this correction.

# Count sheet adjustments and recount evidence — 2026-10-21

Deployed on 2026-10-21 at 22:48 UTC after the user explicitly requested deployment.
The migration preserved all 49 existing count rows; no count sheet was reset.
Spec: [count-sheet-adjustments-spec.md](count-sheet-adjustments-spec.md).
Spec approval: not obtained (autonomous run); the user explicitly confirmed
`VAR = Actual on hand − Counted + Adjusting` during implementation.

Run from the repository root:

```sh
bash server/tools/count-sheet-adjustments-isolated.sh
```

The final fresh run after the last implementation edit passed:

| Check | Result |
| --- | --- |
| Full inventory/count-sheet regression selection, real HTTP and Chromium | 108 passed, 0 failed, 0 skipped |
| Changed executable lines, including merged browser coverage | 72/72 covered |
| Deliberate bugs caught | 5/5: wrong sign, retained counts, missing revision guard, retained submitted timestamp, lost adjustment on re-confirmation |
| Arithmetic property alone against the sign mutation | Mutation caught; 30 generated signed-decimal examples in the normal run |
| Reordered focused database/browser suite | 16 passed, 0 failed |
| Scoped ESLint, syntax, helper TypeScript, secret scan | All passed |
| Migration rehearsal and transactional rollback | Passed with existing count/snapshot preservation |
| Container, database, volume, network and artifact teardown | Passed; only the four production containers remain; application health passed |

Coverage by changed file: adjustment validator 16/16; repository 22/22;
reconstruction 2/2; router 1/1; Control browser 31/31. Across the four instrumented
server modules, line coverage was 278/279 (99.64%), branch coverage 154/174 (88.5%).
The new adjustment validator had 100% line and branch coverage.

Acceptance mapping:

- A1: `each row has Adjusting…` browser test covers column order, removed
  description, immediate signed/decimal/blank previews, persistence and layout
  at 1280, 768 and 390 pixels; generated-decimal SQL properties check arithmetic.
- A2: `signed adjustments persist…` and `adjustment survives comparison
  reconstruction…` cover re-confirmation, submitted review, blind operator
  responses, unchanged physical counts, stock and snapshots.
- A3: `invalid batches…`, `real HTTP requires…`, and the failed-save browser
  scenario cover invalid fields, duplicate/unassigned/uncounted rows, failed
  saves, role/yard boundaries and stale revisions.
- R1: three database and three browser scenarios cover reset/reopen for
  in-progress/submitted/cancelled sheets, cancelled confirmation, all historical
  count deletion, cleared ownership/timestamps and a successful fresh recount.
- R2: competing adjustment/reopen and existing reset/save tests, stale operator
  save/submit tests, other-sheet preservation and transaction rollback.
- M1: migration upgrade/rollback test; existing Cycle Count regressions retain
  their prior formula and passed.

Initial database RED: all 11 new database/HTTP tests failed against the old
implementation. Browser RED exposed the missing column and inputs; its old
confirmation scenario was interrupted after a test dialog assertion prevented
closing the dialog. The dialog harness was corrected without weakening its
assertion. Runner startup option/working-directory issues and lint violations
were corrected before the final passing run. Every interrupted run was torn down.

Scope limits: the unrelated 1,077-file MBT suite and whole-project type check
were not run; validation covers the full existing inventory feature selection
and the new validator's type graph. No dependency versions changed, so a new
supply-chain audit was not run. No NetSuite write or live count reset was exercised.
The authorized production deployment and its read-only checks are recorded below. Activity/audit events intentionally remain after a
reset; the saved count rows and adjustments are discarded. Tests do not establish
absolute correctness outside the specified behaviors.

Tools: Node v20.20.2, Playwright 1.62.1, fast-check 4.9.0, c8 12.0.0,
ESLint 10.8.0, TypeScript 7.0.2. Existing locked dependencies and browser downloads
were installed only in the disposable run directory and deleted afterward.
Source identity (ordered runtime/test file hashes printed by the runner):
`61807bd16c2145a67b14c6c846af935fdb3c8edd14c441bd25b0885c30383aa8`.
No git checkpoint commits were made. Generated logs/coverage/screenshots and
all synthetic database contents were removed; this document is the retained evidence.

## Authorized deployment

The built release image passed the same 108 tests, 72/72 changed executable
lines, five deliberate-bug checks, and the 16-test reordered run. All 1,435
runtime file hashes matched the captured candidate, and all nine changed files
matched the previously tested workspace. The live package script differences
were preserved; the package lock and dependency versions are unchanged.

- Image: `mbbs-operator-app:count-sheet-adjustments-20261021`.
- Image ID: `sha256:3ed9cf32e4a8e9d458fed93b1dee7e5d7e305ac8fb9fcea8cde163a711e111ea`.
- Migration 302 applied once; adjusting column present; zero incorrect stored
  variances using actual on hand minus counted plus adjusting.
- Count quantities/snapshots, all 49 rows, sheet headers, assignments and activity
  events matched their pre-migration fingerprints. Schema and count-sheet backups
  are retained with the operational deployment records.
- Local and public `/health` and `/control/count-sheets` returned 200. All four
  changed public asset hashes matched; unauthenticated adjustment/reset/reopen
  requests returned 401. Runtime settings and the three dependent containers
  were preserved. The application is healthy.
- The disposable test environment, downloads and logs were removed. Both
  `docker ps` and `docker ps -a` contain only the four production containers.
- Rollback image: `mbbs-operator-app:count-sheet-adjustments-20261021-rollback`.
  Deployment rollback preserves the additive adjustment column and any accepted
  business data, and restores the previous application's variance convention.

Operational records: `server/deployments/count-sheet-adjustments-20261021/`.
Repeat live read-only verification from the repository root with:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 server/tools/count-sheet-adjustments-release.py verify
```

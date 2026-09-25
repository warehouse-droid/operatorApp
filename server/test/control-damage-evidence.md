# Control damage transfer editor — 23 September 2026

The Control damage page reviews the monthly NetSuite IT with yard/month filters,
linked photographs and saved-report errors. Managers can edit SKU, quantity,
item UOM and R1–R5 reason, add lines and remove lines. A required note and durable
before/after history accompany each adjustment. Saves update the same IT and
are displayed as confirmed only after read-back reconciliation.

The [specification](control-damage-spec.md) includes the user's clarification:
use the item's UOM rather than request the NetSuite Units list. The live probe
confirmed SKU 5020 returns unit 486 / SQFT using existing Item access. No new
NetSuite permission or production dependency is required. An existing line's
current unit is retained when it differs from the item's configured defaults.
The earlier candidate's Units-list GET received 403; that lookup was removed.

Tier 3 verification was used because the change affects inventory, authorization,
concurrency and removal of transaction lines. Additional spec approval was not
obtained (autonomous run under the user's implementation authorization).

| Requirement / failure mode | Evidence |
| --- | --- |
| Yard/role authorization, current transfer identity, valid SKU/unit | CH1, CS2, CN1–CN3, CS10; live item-only read probe |
| Keyed edit, append and complete-list replacement without losing other lines | CD1–CD4, CD6, CH2, CS1, CS4; Oracle contracts linked in the spec |
| Durable/idempotent saves and unknown-write reconciliation | CS1, CS3–CS6, CB2, CB4; immutable UUID and before/after records |
| Same lock as operator posting and unresolved-write fencing | CS7–CS8; six concurrent submissions and five posting workers |
| Bin/lot assignment preservation and worker restart | CS9; actual application startup and scheduled worker execution |
| Current NetSuite values, original evidence and removed/missing lines | CR1–CR5; photographs and report records retained |
| Review, add/edit/remove, notes, month filter, 40/60 layout | CB1; real Chromium execution and editor screenshot |
| Cancel/undo, browser Back preserves draft, unit retention | CB3, CB6 |
| Management reconciliation of a saved report | CH2, CB5; actor audit asserted |
| Existing Damage, Count Sheets and calculator | 47 existing focused feature tests, including 108 PLT and unchanged 360px counting panel |

Final focused run: **80 tests passed, zero failures** against the exact release
source files. Candidate tests use the repository's test-only npm scripts and
existing tool image; production package files are not replaced. All **616 changed
JavaScript lines** were executed, including browser coverage. Only service-worker
cache/asset version strings are treated as data and verified by release hashes.
The five new backend modules have **310/310 lines**, **32/32 functions**, and
**221/241 branches (91.70%)** covered. Large pre-existing modules are evaluated
on changed lines, not their global percentages.

Five manual mutants were killed: stale-version acceptance, incorrect replacement,
unsafe unknown-write retry, using a different monthly lock, and dropping the
replacement query parameter. Two applicable domain mutants were also killed by
the property suite alone. The 200 seeded property cases cover identity, untouched
lines, stale writes and mixed edits; service/network invariants are covered by
fault-injection and database concurrency tests. All six new test files passed in
reverse order. The migration rollback rehearsal preserved two saved adjustments
and the existing reports, including a deliberately inserted retention fixture.

Lint and syntax checks passed. The existing strict inventory-domain check passed;
project type checking retained 174 baseline diagnostics with zero new diagnostics.
Secret scanning passed. No dependency was added, so dependency/license re-audit
was not applicable. New functions were reviewed for bounded loops (100 changes,
1,000 transfer lines), explicit validation and separation of planning from I/O.
The isolated startup also emitted the existing Smart SCM missing-test-config log;
health/authentication and the damage workers passed without new worker errors.

Full repository regression: **3,080 tests; 3,055 passed, 24 pre-existing failures and one skipped; zero new failure names**. All 577 files completed. Production source hashes were unchanged throughout this final run; an earlier run before the item-UOM change is retained separately.
Deployed at **2026-09-23T22:03:19.239367+00:00** as `sha256:d641d21e147d5be02462393427bf40c99097f4eb9f752a5ecc79456b9e399176`. All **1029** production source/asset/migration hashes were verified; runtime settings and other services were preserved. Local/public health and the Control route returned 200; anonymous Control API access returned 401; all nine changed public assets matched their release hashes. The first cutover attempt stopped when an operator posting became active, then completed after it returned to idle. The original pre-migration schema and migration metadata backups were retained.

Reproduce focused verification with `bash tools/control-damage-gauntlet.sh --focused`
and the full workspace comparison with `bash tools/control-damage-full.sh`.
Set `INVENTORY_SOURCE_ROOT` to the release's `candidate` directory to verify the
exact overlay. Source hashes and Node/tool versions are in
`test-artifacts/control-damage/sources.json`. Release preparation, build,
validation, apply and verification are implemented in `tools/control-damage-deploy.py`.
The additive migration is retained if application rollback is needed.

Known limits: a NetSuite user can still change the record in the short interval
between the final read and PATCH; the documented API contract does not establish
a supported conditional-write mechanism. App writers are serialized. Item,
quantity and UOM edits on lines with bin/lot assignments require the corresponding
assignment work in NetSuite. At least one line must remain on an IT. No live stock
movement was used to demonstrate the new editor.

The original approved retry and subsequent user-requested local removal are
recorded separately in [the damage correction evidence](damage-description-fix-evidence.md).
The original report is absent locally and from IT00551; its private cleanup backup
is retained outside the application. The Control release does not resend it.

Release and rollback metadata: `/home/ubuntu/operatorapp-deploy-backups/control-damage-20260923-v1`.

Post-deployment live read confirmed **IT00551, one transfer line**, item UOM **SQFT (486)**, and the original report absent from both local storage and the Control review. This verification made zero NetSuite record writes. The receipt is `read-only-candidate-probe.json` in the release directory.

# Repair quote auto-approval settings — 2026-10-29

Released 2026-10-29T21:55:54Z to the existing Repair application.
Image: `mbbs-operator-app:repair-quote-auto-approval-20261029` (`sha256:f282520ff9d58b064277fbd888cc0714285a9dc24298c3cfd96aac9972dad8ef`).
All 61 released source hashes and 44 live HTTP checks passed.
Application configuration and the other production services were preserved.
No database migration, production dependency change or Git commit was required.

Scope: criteria 76–80 in `spec.md`. Separate human spec approval was not obtained
in this authorized autonomous run. This evidence establishes the recorded
constraints, not completeness of the business specification.

Three independent Admin switches are in Repair → Settings → Quote auto-approval:
trucks, forklifts/loaders, and external customers. Office can view saved values.
All default off. External ownership takes precedence over physical type; other
unconfirmed types remain manual. Policy applies when issuing initial, additional
or revised quotes, never retroactively to existing decisions.

| Constraint | Evidence |
| --- | --- |
| Category and authority | Real PostgreSQL/repository/HTTP tests cover defaults, strict known boolean flags, Admin-only writes, stale settings, unchanged pricing/mappings/posting flags, and before/after actor audit. Seeded 32-case properties cover independent flags and company/equipment combinations. |
| Whole quote and replay | Initial/additional/revised quotes accept every line together. Durable replay prevents duplicate decisions, jobs, audit or notifications. Existing pending/rejected/approved quotes remain unchanged on toggles. |
| Concurrent settings | A separate real PostgreSQL transaction holds a settings update; quote issuance waits and records its committed policy revision. A missing-lock fault fails the intended assertion. |
| Attribution and safeguards | Automatic decider and issuing actor are recorded separately; labels never claim customer acceptance. Inspection, verified equipment, Start Job, all-job receipt rules and manual financial gates remain required. Old customer links are revoked on revision. |
| Office UI and PDF | Browser checks persist all independent switches as Admin, then verify Office read-only access in a fresh document. Quote editor/preview/history and rendered PDF identify Auto-approved quotes. |

Frozen-candidate results: **186/186 tests in each of three runs** (normal,
coverage, reversed order); **37/37 changed backend executable lines covered**;
**80 distinct fault executions caught**, including all **10 new policy faults**.
Collected line coverage was 96.23%, branch coverage 84.18%, function coverage
93.86%. Browser JS/CSS/HTML is exercised through real browser flows and excluded
from the Node changed-line report. Lint, domain types, server syntax and secret
scan passed. The affected regression set passed 40 tests across nine files;
three shared-shell files passed. The sole pre-existing asset-contract failure
remains narrowly accepted: `S11: the guarded client ships in a new atomic Driver
shell generation`; the other three checks in that file pass.

Repair source graph SHA-256: `e47137d6ad03a27d8ddda50631823d13fad8526d9125c25edccdeb2e540b495d`.
Shared integration SHA-256: `29d9bf57f66e0e53ad7b3b1528fc185924b0ca84278277949587cce7515f33be`.
Atomic Repair asset generation: `20261029-quote-policy`.
Exact hashes, validation summaries and rollback records are in
`deployments/repair-quote-auto-approval-20261029/`.

Red evidence: all ten initial policy checks failed against the unchanged
implementation. Two added multiline/concurrency checks initially passed the
implementation; targeted faults prove their sensitivity. Browser harness fixes
removed a hard-coded Admin token reset and explicitly reloaded after changing
role instead of relying on hash navigation. Assertions were retained. An
accidental duplicate run was stopped and fully removed. An unrelated Operator
release superseded the first full candidate; it was stopped, rebased without
conflict and the complete final gauntlet rerun on the current base.

Live read-only audit at 2026-10-29T21:56:21.928Z: all three settings remain off;
no policy changes or automatic decisions were introduced during deployment.
`REP-0000002` remains completed with receipt pending; J02 remains wholly rejected
and completed jobs remain hidden from Team. Both NetSuite posting gates remain
false and existing inspection/work-update intents remain at attempt 0.
**No live financial document was created or posted.**

Reproduce with `tools/repair-quote-policy-release.py validate`, which uses the
standard bounded disposable runner and `tools/repair-quote-policy-checks.mjs`.
Rebuild the existing `docker/Dockerfile.repair-pdf-test` image for PDF extraction.
Poppler 22.12.0-2+deb12u3 is test-only; its task image was removed after validation.
Tools: Node 20.20.2, ESLint 10.8.0, TypeScript 7.0.2, c8 12.0.0,
fast-check 4.9.0, Playwright 1.62.1. No new dependency was added.

Cleanup: both running/stopped container lists were checked; no Repair test
container, disposable volume or unused network remains. Every task artifact
directory, raw log, PDF, coverage report and mutant copy was removed, including
cancelled runs. The unrelated active SCM test project observed during the final
check was left intact. Only source evidence and deployment/rollback audit
records remain for this task.

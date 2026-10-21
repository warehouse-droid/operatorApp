# MBR model rental rate defaults

Spec approval: not obtained (autonomous run). The user authorized adding these
defaults and allowing sales to override contract prices, then explicitly required
unlisted models to have null prices. No dependencies, installs or commits.

1. MBR Setup has editable daily, weekly and monthly CAD rates per model, separate
   from individual equipment units. Initial dollar rates are:

   | Model | Daily | Weekly | Monthly |
   | --- | ---: | ---: | ---: |
   | ER620H | 280 | 1250 | 3300 |
   | ER627H | 330 | 1300 | 3750 |
   | ER636H Cab (the existing ER636H model) | 370 | 1450 | 4000 |
   | ER655H | 450 | 1500 | 4500 |
   | ER680H | 680 | 2200 | 6200 |
   | STR1000H | 250 | 1000 | 3000 |
   | ATL1000 | 250 | 1000 | 3000 |
   | TV1100H | 450 | 1500 | 3400 |
   | S1932E | 150 | 285 | 590 |
   | S2632E | 160 | 350 | 730 |
   | S4046E | 230 | 650 | 1490 |

2. AX18 and any newly added unpriced model have null rates. Setup may clear any
   individual rate; zero is distinct from null. Invalid, negative, overprecision,
   oversized or non-string money values are rejected without a partial write.
3. Choosing or changing a contract model copies its configured rates into editable
   daily/weekly/monthly fields and clears the old serial number. Choosing an
   unpriced model or clearing the model clears all three rates. Serial selection
   and unrelated edits leave the entered rates unchanged.
4. Sales may replace or clear copied rates before saving or afterward. Saving,
   reopening, previewing, renewing or downloading an existing contract retains
   its own rates; Setup changes never reprice saved or signed contracts. Explicit
   contract nulls remain null even when the model has a configured default.
5. Only MBR Sales and Admin may read/edit model defaults. Customer links, other
   roles and unauthenticated requests cannot access them. Stale and simultaneous
   Setup edits return a conflict rather than silently overwriting a change.
6. A transactional additive migration seeds only model defaults, leaving equipment,
   contract snapshots, signature records and PDFs intact. Rehearse rollback in a
   disposable database. Release only this delta over the then-current live image,
   validate that exact candidate and retain operational rollback artifacts.
7. Use the standard isolated Compose stack with mbbs-tests.slice, init, explicit
   memory/swap, PID, CPU and tmpfs limits, and disposable-test labels. Register
   teardown before startup; remove this task's containers, databases and networks
   on every exit, verify docker ps/ps -a and production health. Preserve logs.

Tier 3 failure model: wrong cents/model mapping (full table and browser checks);
null becoming zero or stale prices following another model (property and browser
checks); contract overrides lost on reload/Setup edit (HTTP/browser/PDF checks);
hostile price or lost concurrent edits (validation, role and concurrent HTTP
checks); partial migration (transaction rollback rehearsal); unrelated live
changes overwritten (narrow three-way merge, hashes, candidate checks and rollback).

Setup plan: reuse the existing Node test, fast-check, TypeScript, ESLint, c8 and
Playwright toolchain. Add rate tests, one migration and narrow release/validation
scripts. Run the complete MBR suite, focused mutation checks, browser checks and
lint/types; keep artifacts under test-artifacts/mbr-rates. No broad host tests or
unrelated code changes are needed for this independent module.

Validation note: a concurrent burst of other test stacks stalled an existing
WebKit equipment run. The task's stack was stopped and removed, retaining its
passed-layer logs. Validation subprocess deadlines now use SIGKILL so application
shutdown hooks cannot defeat the timeout; the stack still tears down in finally.
Another task deployed during validation, so the release is rebased onto that
new live image and the complete candidate checks are repeated. No price assertions
or resource limits are relaxed.

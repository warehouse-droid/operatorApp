# Operator return enhancements — validation evidence

Deployed to production after the user's explicit authorization. The additive
notification-table migration succeeded, all 15 live source hashes match the
validated candidate, and application health and HTTP checks passed. Application
configuration and the other production services were preserved. The exact time,
image identity, and migration result are recorded in
`server/deployments/return-enhancements-20261028/deployment.json`.

Tier 3; spec approval: not obtained (autonomous run). The user requested these
behaviors directly. No dependencies, commits, branch changes, live CMs, or customer
messages were created during development.

The exact merged candidate is identified by the SHA-256 of its sorted source hash
manifest: `04debc87363edf5d7824cff139fb262c083e3f67a8d5bf45c640625e312b9679`.
The 15 individual hashes and final results are in the operational release record
`server/deployments/return-enhancements-20261028/validation.json`.
The release preserves the captured live application, including unrelated changes
in the shared server, NetSuite adapter, and operator page.

| Requirement | Executable evidence |
| --- | --- |
| Optional stock/combined plates | E1 integration and UI cases; updated prior plate regression with successful posting and replay assertions |
| Quantity/label minimum 15px | Chromium at 390px and 1024px, default and deliberately small preferences: minimum observed 16px/15px |
| Missing stock photos block submission and show toast | E3 server and UI cases; real button interaction asserts no API call; normal and per-row quality evidence |
| Shared fresh NetSuite pallet report | E4 and existing saved-search admission/concurrency tests; no historical aggregate or unnecessary credit identity query |
| Automatic SMS/email after verified CM | E5 stock/pallet/combined, phone preference/email fallback, no contact, failed configuration, bounded retry, uncertain delivery, historical/RA/local exclusions, rollback, cancellation, concurrent and superseded workers |
| Adjacent good-condition fees | E6 generated rounding cases, exact adjacency/sign, immutable retry terms, and hostile readback/accounting-adjustment cases |
| R1–R5 fee-free child locations | E7 posts reasons 5–9 at children 9/39/42 for yards 1/28/26; rejects an unverified child rather than substituting the parent |
| Stock CM otherRefNum | E8 verifies the authoritative SO number and rejects changed readback |
| Operator account first in both memos | E9 for stock/pallet; forged input account ignored; readback verification |
| Source SO custom rate and sales units | E10 exact six-decimal price, Custom price level (-1), client overrides ignored, fee based on source value, and changed-rate readback rejected |

Final fresh run: `sudo -n bash server/tools/run-return-enhancements-candidate.sh`.
This registers teardown before creating its standard bounded Compose environment,
uses the retention runner's unique artifact directory and removes disposable output.
The candidate is prepared with
`sudo -n python3 server/tools/return-enhancements-release.py prepare`.

- Acceptance: **33/33 passed**; affected regressions: **227/227 passed**; no skips.
- Acceptance files also passed individually in reverse order: 22 + 3 + 8 tests.
- ESLint: zero errors/warnings on new domain/UI/test/tool modules; syntax checks
  passed on every released JavaScript file. Scoped domain type checks passed
  against explicit declarations of existing I/O boundaries.
- Coverage across five core return modules: **780/790 lines (98.73%)**,
  **492/543 branches (90.60%)**, **65/65 functions (100%)**. New accounting,
  automatic notification, and CM modules each have 100% line coverage.
- **6/6 manual mutants killed**, each by a behavioral assertion: fee sign, parent
  quality location, custom pricing omitted, uncertain delivery retried, photo
  admission bypass, and historical pallet calculation substituted for the report.
  The fee sign mutant was also killed by the generated fee property alone.
- Four real Chromium layout/interaction cases passed. Existing integration tests
  exercise actual local HTTP handlers; provider and NetSuite network boundaries
  use synthetic fixtures.
- Secret scan passed for all 15 release files and three acceptance files; no
  dependency changes. Node v20.20.2; TypeScript 7.0.2; ESLint 10.8.0; c8 12.0.0;
  fast-check 4.9.0; Playwright 1.62.1.

Baseline: the original 216 return tests passed. Initial RED: 14/16 new cases
failed; the two pre-existing photo/report behaviors were later proven meaningful
by the corresponding killed mutants. Custom-price and saved-preference defects
were separately reproduced before correction. The first expanded fixture needed
notification-row teardown; legacy unversioned intents needed their original
verification rules retained. A historical fixture was corrected to seed its
intent before admission rather than bypass the immutable-intent trigger.
Coverage initially failed the existing 90% branch threshold; added accounting
adjustment cases verify that adjustments cannot hide or change declared fees.
No thresholds were reduced.

Limits: coverage numbers describe the five core modules, not every changed line
in the large shared HTTP/NetSuite files or browser VM. The latter are covered by
integration/browser behavior and source review, without a claimed coverage
percentage. The unrelated whole-application suite and full-project type baseline
were outside this validation boundary. No live NetSuite write, real message send,
or production rollback rehearsal was performed. The migration adds an empty
outbox without backfilling historical returns; existing delivery reservations
prevent automatic repetition of uncertain sends.

Every task-owned test container, disposable database, volume, network, and run
artifact was removed on both successful and failed runs. Both Docker container
listings and production health were checked after teardown. The retained release
image, captured live source, source delta, and concise validation record are
operational release/rollback records.

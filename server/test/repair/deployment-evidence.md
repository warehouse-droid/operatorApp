# Repair production deployment — 2026-10-27

Deployed at 14:41:24 UTC to <https://test.mbbsoperation.com/repair/>.
The user explicitly requested deployment. The existing approved acceptance
specification is [spec.md](spec.md); no application behavior was added to that
specification during this release. The Tier 3 validation workflow was reused.

## Release scope and state

- Image: `mbbs-operator-app:repair-module-20261027`.
- Image ID: `sha256:e9ae7f98d49669f3e07c6cac0ea2816bf6a95f9c7184cc58f5c366fb887afc1d`.
- Base: `mbbs-operator-app:regular-stock-quantity-20261027`.
- Exactly 45 application/migration files changed over the captured live image.
  Unrelated workspace changes, including pending Estimate PDF work, were
  excluded. Recent Operator assets were preserved with a new Repair cache key.
- Migration `310_repair.sql` applied in one transaction with lock and statement
  timeouts. The affected existing `operators` and `schema_migrations` tables
  were backed up; the dump's restore listing was verified before migration.
- `REPAIR_ENABLED=true`; `REPAIR_NETSUITE_POSTING_ENABLED=false`; the database
  Admin posting switch remains false. No NetSuite records were created.
- The app is healthy. The database, webhook worker, Ollama and other app
  configuration were preserved. Rollback uses the previous app image and retains
  the additive Repair schema and any new business history.

The release procedure, scoped merge, source guards, backup, deployment and
verification are in `tools/repair-module-release.py`. Operational records and
rollback configuration are under `deployments/repair-module-20261027/`.
Run validation with:

```sh
python3 server/tools/repair-module-release.py validate
```

The candidate runtime is mounted read-only into the repository's bounded
`docker/run-repair-tests.sh --source` runner. All temporary output is managed by
the retention runner's unique `MBBS_TEST_ARTIFACT_DIR`. The dependency lockfile
matches production; there were no new dependencies.

## Final candidate validation

| Layer | Result |
| --- | --- |
| Repair acceptance, including HTTP/browser/race/migration cases | 49 passed |
| Existing affected regression files | 40 passed across 9 files |
| ESLint, checkJs, server syntax, scoped secret scan | Passed |
| Coverage rerun | 49 passed; 87.31% statements/lines, 73.78% branches, 83.22% functions |
| Manual mutations | 5/5 killed |
| Financial mutations against properties alone | 2/2 killed |
| Reversed test-file argument order | 49 passed |
| Existing Driver asset contract | 3 passed; 1 exact previously documented baseline failure |

The accepted baseline failure remains
`S11: the guarded client ships in a new atomic Driver shell generation`; it
hardcodes obsolete asset identifiers. No assertion was changed or skipped.
No successful full-repository suite or full changed-line coverage is claimed.
The original implementation evidence documents the baseline and remaining
coverage boundaries in [evidence.md](evidence.md).

New Repair source/migration hash:
`8730650644fd366d73ef0b6d3eb1f7fe3f892fcd7dc7b5da91bb8aa5b364d030`.
Shared integration hash:
`6a5e50061e26d499771422c8812b1b4339f45bf67b3c26930563a19011b2a8ae`.
Tool versions and individual file hashes are retained in `validation.json` and
`prepared.json` in the release directory.

## Live verification and cleanup

All 45 deployed file hashes matched the tested candidate. Eighteen local/public
HTTP checks verified health, Workshop, Office, public quote shell, availability,
unauthenticated access denial and invalid quote denial. Repair JavaScript/CSS
asset hashes were also checked through both origins. No Repair runtime errors
were present in the post-deployment log check.

Compose teardown removed test containers, volumes and networks. The temporary
artifact directory, logs, browser output, coverage and mutation copies were
removed. Both `docker ps` and `docker ps -a` showed only the four production
containers, with production health passing. The cleanup audit is retained;
only source evidence and operational release/rollback records remain.

## Initial equipment setup

Read-only NetSuite checks found 120 Vehicle Masters, including 37 with the MBT
billing customer and 39 with the MBR customer. There were no duplicate truck
matches. The existing active MBBS customer is `12361`, distinct from the
adjustment customer; no current Vehicle Master uses that customer.

The optional local catalog import and MBBS customer mapping were not applied.
Automatic approval review rejected that initialization because it changes
production data beyond the deployment request. User approval was requested.
The deployment itself is complete. NetSuite posting, new Vehicle Master
creation and live financial validation remain gated.


## Portal and equipment follow-up — 2026-10-27 16:31 UTC

The user requested separate department, Office and Repair Team screens, a
focused Operator/Driver requester view, tablet/phone PWA operation, record and
parts search, and live equipment reads plus new master creation in NetSuite.
The later equipment request also authorized populating the local search cache.
The previously proposed bootstrap was superseded; its MBBS alias customer
12361 was not the Vehicle Master owner. The authoritative owner is customer
7143, **000033 Mr Bin Building Supply LTD.**, verified from the master references.

Release `mbbs-operator-app:repair-portal-20261027` was deployed at 16:31:28 UTC,
image `sha256:f527200e82f67f7b0d484ba487066079e7c187cc12ec9a9fe6934b91bfac7bec`.
Its 71 scoped files were merged over the live
`mbbs-operator-app:stock-request-followups-20261027` image. All hashes matched;
configuration and the other three production services were preserved. Migration
313 adds standalone-machine uniqueness and fills only a blank Building Supply
mapping. The affected Repair tables/settings and migration ledger were backed
up, their restore listing verified, and the migration applied transactionally.

The release includes shared Repair sidebar navigation with fresh cache keys,
`/repair` as the department board, `/repair/office`, and an installable
`/repair/workshop` PWA. Operator and Driver embed only the dedicated requester
screen, retaining completed workshop jobs until receipt. Office searches repair
and purchase records (including records without attachments), has parts/SKU
search, and uses the Equipment screen to search/add equipment. Master reads
refresh automatically and match unique linked vehicles/machines while preserving
local request identity. New vehicle and machine actions write their respective
NetSuite master type, persist retry intent, verify remote identity, and audit
successful creation. Financial posting gates remain false.

Final validation against the exact candidate: 67 acceptance tests passed,
including tablet/phone workflows, browser equipment lookup/creation, lost-response
and concurrent retries, actual NetSuite write-boundary gating, and migration
rollback. ESLint, checkJs, syntax and secret scanning passed. Coverage rerun and
reverse test-file order each passed all 67 tests; coverage was 89.15% statements/
lines, 77.01% branches and 85.88% functions. All five manual mutations and both
financial property mutations were killed. All 40 affected existing regressions
passed. The exact pre-existing S11 Driver asset contract failure remains
unchanged; no full-repository success is claimed.

Eight portal acceptance cases and seven equipment-master cases were observed RED
before implementation. Final validation also caught two test-fixture issues:
the mocked NetSuite boundary needed direct access enabled for its fake endpoint,
and a browser width assertion needed `window.innerWidth`. Neither correction
weakened behavioral assertions. The earlier portal coverage run exposed a real
photo-save/form-refresh race; forms now remain inert until save and refresh end.

Source hash (including migration 313):
`22a59cb21705bcf4515449866ed019721e076da5c1c26b23e6b93630717e7475`.
Shared integration hash:
`d030a11b48e74cbd2879b34e2d48760f07ecc69fbfd91211a0f12fc46d1f026f`.
Detailed concise operational audits are in
`deployments/repair-portal-20261027/`.

Live read-only NetSuite queries verified 120 Vehicle Masters and 42 Machine
Masters. The deployed directory now represents all of them as 123 searchable
equipment records (linked records share an entry): MBBS 24, MBT 37, MBR 42,
external 20. Machine-code search passed; Operator sees its 24 Building Supply
records and Driver its 37 trucking records. No NetSuite records were created
for deployment verification. Master POST responses were exercised through
isolated boundary fixtures against the verified live field schema; actual
production POST permissions and physical phone camera/install prompts were
not exercised with dummy business records.

Every Repair test run removed its containers, volumes, networks and generated
logs, coverage, browser output and mutation copies through the retention runner.
Production equipment cache changes and operational/rollback records are retained.

Final live checks verified all 71 container file hashes, 16 public/local page
checks, six public JavaScript/CSS hashes, and six unauthenticated API denials.
Both `docker ps` and `docker ps -a` contained only the four production containers
after teardown; no disposable test volumes or networks remained. Production
health passed. An unrelated concurrent source-save test finished its own teardown
before this final host audit.

A subsequent concurrent `damage-reason-zh-20261027` deployment preserved all
Repair sources and all but two full scoped-file hashes. Its intended changes
were Operator HTML and service-worker assets; the Repair requester cache keys,
embed helper and matching Operator script reference were explicitly reverified.
The shared sidebar source and every HTML consumer outside Operator remained
unchanged. Current live health and Repair public asset hashes still pass.

## Operator-style Repair Team workbench — 2026-10-27 18:24 UTC

The user requested a clean Operator-style PWA with only Jobs and Parts, a 30/70
tablet job list/detail layout, phone navigation, job notes/photos/completion,
job-linked parts requirements, stock search and purchase-request progress.
Specification items 25–28 record that scope. The existing equipment/type
correction remains in a collapsed job section. Office purchasing and approval
rules, receipt behavior and financial posting gates are unchanged.

Release `mbbs-operator-app:repair-team-workbench-20261027` was deployed at
18:24:15 UTC, image
`sha256:3050c02248ba8aab69d9c240f06cefbe0e1d9f452f32d60d55db863685a0ec92`.
Exactly eight files were merged over the captured live
`mbbs-operator-app:partial-linked-posting-20261027` image. No migration or
dependency change was needed. Application configuration and the other three
production services were preserved. The release verified all eight live file
hashes and 20 public/local HTTP checks. Rollback and concise operational audits
are retained in `deployments/repair-team-workbench-20261027/`.

The Team route now loads a separate client with Operator styling and two tabs,
including for staff with additional Office/Admin roles. Tablets display job
cards at 30% and details at 70%; phones open a selected job with a back action.
Notes and selected photos survive tab/job changes and upload failures within
the open page. Photo upload completes before the completion action; the page
stays inert through mutation and refresh. Parts search matches names/SKUs and
shows stock alongside job-linked purchase requirements and their status.
Technicians can read this queue and raise requirements, while actual purchase
entry remains Office-only. Physical camera/install prompts and offline writes
are outside the automated verification; writes require connectivity.

Five new browser/HTTP acceptance cases were observed RED before implementation.
The final exact candidate passed all 72 Repair tests, all 40 affected existing
regressions, ESLint, checkJs, syntax and the scoped secret scan. Coverage and
reverse-file-order runs each passed all 72 tests. Coverage was 89.15% statements/
lines, 77.34% branches and 86.50% functions, measuring imported Repair backend
and shared domain code rather than browser JavaScript or full changed-line
coverage. The exact pre-existing S11 Driver asset-contract failure remains;
no full-repository success is claimed.

All three new Team mutations were killed by their intended acceptance tests:
reversed panel proportions, missing completion-photo enforcement and lost
drafts on tab changes. The five existing manual mutations and two financial
property mutations were also killed. A tablet screenshot was visually reviewed
inside the bounded disposable run and removed afterward.

Existing browser tests were adapted to the requested Start job / Work notes /
Take photos controls, preserving their business assertions. Regression checks
caught the initially missing technician equipment correction and a work-note
accessibility problem; both were fixed before the final run. An earlier run
against the unrelated changing workspace stopped during migration 315 because
of a UUID/text foreign-key mismatch. The final candidate used captured live
migrations through 314; migration 315 is neither changed nor deployed here.

Final source hash:
`5981739e306164eb5112aecad9578d639f1d6f25433f028f90ba2fcec471b544`.
Shared integration hash:
`325f2d290ee0f736264fea5af511712a8c00e8d02bd725147eac0c267075a4f2`.
Tool versions remain Node 20.20.2, ESLint 10.8.0, TypeScript 7.0.2, c8 12.0.0,
fast-check 4.9.0 and Playwright 1.62.1.

All test attempts used the bounded disposable Repair runner and registered
teardown. Containers, disposable database volumes, networks, logs, screenshots,
coverage and mutation copies were removed, including after failed runs. The
retention wrapper removed each unique artifact directory. Production data and
release/rollback audit records are retained.

The final 18:25:01 UTC audit verified six public asset hashes, three protected
API denials and all eight live container file hashes. Production health passed.
Both `docker ps` and `docker ps -a` showed only the four production containers;
no disposable test volumes or networks remained. The default artifact run
directory was empty, and no task preview, coverage or mutation artifacts remain.


## Merged office portal and notification layout — 2026-10-27

The user requested merging `/repair` and `/repair/office` into one regular web
portal and fixing notification positions. `/repair` now includes all existing
office tools, with one portal entry in Repair navigation. Office login lands
there. The old Office URL redirects while preserving its query; selected-job
fragments survive through the browser. Only the Team route adds the Repair PWA
manifest and standalone metadata. Existing purchasing, approval, equipment and
requester permissions are unchanged.

The notification problem had two causes: the portal did not provide the shared
widgets' `.topbar-actions` host, and view changes replaced the header. The header
now survives content updates, alerts start after it exists, and all badges share
one wrapping group with consistent ordering and readable colors. Repair unread
counts survive view changes, and its updates screen remains selected during
refresh. The existing alert menus and personal preferences continue to work.

Deployed at `2026-10-27T19:32:00Z` as
`mbbs-operator-app:repair-office-merge-20261027`, image
`sha256:91b07266e4e25a2a128d82f6993c8e7744c0ba0e6163254cc052710dbe10a9a6`. Nine scoped files were changed. No migration,
dependency, business-data or financial-setting change was required. Application
configuration and the other three production services were preserved.

The deployment guard stopped an initial build because
`regular-stock-add-items-20261027` had replaced the captured
`backorder-po-alerts-20261027` image. The previously validated Repair delta was
pinned and rebased onto the new live image, preserving all eight concurrent
stock-item files. Only `src/server.js` changed among the candidate file hashes;
its Repair delta remained the alias redirect. Full validation was repeated on
that exact combined candidate before building and deploying. Concise release,
rebase and rollback audits are in `deployments/repair-office-merge-20261027/`.

Final validation: all 76 Repair tests and all 40 existing affected regressions
passed. The additional staff-login, menu-order/sidebar and OS-notification
browser suites also passed. ESLint, checkJs, syntax and scoped secret scanning
passed. Coverage and reverse-file-order runs each passed all 76 tests; existing
five domain/migration mutations, two financial property mutations and three Team
mutations were killed. Coverage was 89.15% statements/lines, 77.43% branches and
86.50% functions for imported Repair backend/shared-domain code, excluding
browser JavaScript coverage. The exact known S11 Driver asset-contract baseline
failure remains; this is not a claim of full-repository success.

Four new browser cases exercise real shared notification widgets at 1440, 820
and 390 pixels, stable node identity, group bounds, view/refresh persistence,
notification menus, count clearing, no office manifest, and old selected-job
links. The desktop preview was visually reviewed and removed afterward. Early
fixture corrections accounted for headless notification permission being denied,
job numbers appearing in their record label rather than heading, and the
separate main-module and Repair-page navigation groups. The existing cross-role
approval test now reloads after changing its fixture account: Office and
Department share a URL, so its old navigation no longer created a new document.
All original business and approval assertions were retained. Native OS
permission prompts were not tested on physical devices.

Final Repair source hash:
`fdeb045b1027a705216551a6c56e993e42c857d346a302cbc2e45910da6fb5e5`.
Final shared integration hash:
`9e17f3b95a3d16b51d0db2ba889a894f19444192c75bb4378a08cdb25a3ed05f`.

Live verification passed all nine container file hashes and 20 public/local
route checks, including the Office redirect with a query. The final audit at
`2026-10-27T19:34:53.770259+00:00` also verified eight public asset hashes, two application
HTML bodies and three unauthenticated API denials. Public HTML comparison removes
only the existing Cloudflare analytics beacon; local source hashes match exactly.
Production health passed. Both `docker ps` and `docker ps -a` contained only the
four production containers. No disposable test volumes/networks, run directories,
preview images, logs, coverage or mutation copies remain. All attempts used the
bounded disposable runner with registered teardown, including failed attempts.


## Request / repair-job hierarchy — validation notes (2026-10-27)

Specification approval: not obtained (autonomous run); requirements 31–44 in
`spec.md` record the user's evolving decisions. This is Tier 3 validation for
approvals, stock, financial aggregation and schema migration. No dependencies
or Git commits were added. The repair-only release uses the captured live image
and preserves concurrent Dispatch changes.

Behavior evidence mapping: intake registration and lost-response replay are in
`job-flow-browser.test.js` / `job-flow.test.js`; grouped details, inline quote
editing, usage correction, local PO/ETA and tablet/phone layout are in the same
files. `quote-scopes.test.js` checks independent jobs and approvals, unresolved
issues, concurrent additional-quote replay, issue dismissal, parent completion,
one aggregate posting, public-link isolation and declined-work holds.
`request-rollup.test.js` verifies aggregated requester progress and receipt after
multiple jobs. `migration.test.js` rehearses legacy backfill and transaction
rollback without losing request IDs, histories, quantities or NetSuite links.
Existing repository, directory, HTTP, runtime, NetSuite, requester, Team and
notification suites continue to enforce the earlier invariants.

Failures resolved during development included the independent parts-status UI
wait, request/job number fixture changes, preserving the child action revision
in requester views, and the Team change handler interfering with a subsequent
save tap. Tests also wait for Start job to finish before typing into the busy
PWA. The migration fixture now serializes JSON explicitly. Original business and
role assertions were retained. A redundant local PO permission-guard mutant was
replaced by a real central-role-classification defect, because the independent
Office guard correctly continued to reject the original mutant. One disposable
run failed when its shell runner was edited during execution; teardown completed
and subsequent runs used the finished runner.

Two tablet screenshots were visually inspected (request/job hierarchy and local
PO/usage section); all preview images were removed with their disposable run.
Physical device camera/permission prompts and real NetSuite writes are outside
this validation. Existing live Repair posting was disabled at preflight and is
preserved. The adapter boundary tests verify aggregate request identity and
inspection charge/credit; they do not claim a live financial posting test.

The final equipment-correction regression additionally covers reopening affected
completed children when approval routing changes, preparing replacement quotes
after supersession, and retaining exactly one inspection posting. Its two RED
failures were the completed child remaining closed and the missing replacement
quote control. Both were fixed before its GREEN run.

Final fresh run: `sudo -n python3 tools/repair-flow-release.py validate` from
`server/`, which runs `node tools/repair-flow-checks.mjs` through the bounded
disposable runner. All **97 Repair tests passed**, including the coverage and
reverse-file-order runs (97/97 each). ESLint, shared-domain checkJs, server syntax
and scoped secret scanning passed. All 40 affected regression cases and three
Office/shared-shell suites passed. The exact existing S11 Driver shell-generation
contract failure remains the only accepted baseline failure; this is not a claim
that the entire repository suite passes.

Changed executable backend/shared-domain coverage: **317/317 lines**.
Imported backend/shared-domain coverage was 91.97% statements/lines, 81.42%
branches and 87.62% functions. Browser JS/CSS/HTML and SQL are covered by browser
and migration scenarios, not this Node instrumentation. **17/17 chosen defects
were rejected**: five domain/migration, three Team and nine flow mutations.
The inspection-credit, rounding and stock-correction defects were also rejected
by property tests alone. Final browser checks explicitly wait for aria-busy to
clear before synthetic typing; all original focus and filtering assertions remain.

Recorded tools: Node 20.20.2; ESLint 10.8.0; TypeScript 7.0.2; c8 12.0.0;
fast-check 4.9.0; Playwright 1.62.1. Repair source hash:
`91833c0825bd2d6cb0596d647e6775b30aa0441e46fb327b3092ebd6b0c17f37`. Shared integration hash:
`82848f672e95fd2b79828440a641d58c76c9d645f1f9642aa44e8f466c1c1a93`.

Deployed `mbbs-operator-app:repair-job-flow-20261027` at `2026-10-27T21:33:34Z` over
`mbbs-operator-app:dispatch-pending-approval-20261027`. Only 32 scoped files were
published. The application was drained before the Repair backup and transactional
migrations 316–318; database, webhook worker and Ollama were preserved. Backup
checksums, migration hashes and deployment records are retained under
`deployments/repair-job-flow-20261027/`.

Live verification: all 32 container hashes, 20 public/local route checks and
15 changed public JS/CSS hashes passed. At `2026-10-27T21:34:38.367501+00:00`, the existing request,
one quote, two work entries and two attachments were preserved and linked to its
initial job. All three migration ledger entries exist. Application health passed.
The existing disabled Repair posting gate was preserved. At `2026-10-27T21:35:13.454543+00:00`,
both Docker running/all-container inventories contained only the four production
containers; no Repair disposable volumes, networks, run artifacts, screenshots,
coverage reports or mutation copies remained.


## October 28 — requester pages and one receipt per request

Deployed `mbbs-operator-app:repair-requester-page-20261028` at `2026-10-28T15:03:20Z`. Image:
`sha256:1019d55e092e0dc3289207dcacbe2a93bb5c8e81950d700ad9fd1bbc77992873`. The 35 scoped files were applied over the captured live release;
configuration and the database, webhook worker and Ollama service were preserved.
No schema migration was required. Rollback data and operational audit records are
retained under `deployments/repair-requester-page-20261028`.

Spec approval: not obtained (autonomous run). User receipt and reassignment
clarifications are recorded in criteria 45–50 of `spec.md`. No dependencies,
commits or production test records were added.

| Acceptance criteria | Executed evidence |
| --- | --- |
| 45: separate requester page; own requests; safe mixed roles | `requester-page.test.js`: actual Operator tablet and Driver phone Personal History, button navigation, no embedded Repair iframe or horizontal overflow; own ongoing requests; delegated detail/evidence denial; mixed-authority requester context; ownership property |
| 46/48: Control and Dispatch reassign receipt | `assignment-receipt.test.js`: role/type boundaries, active Operator/Driver selection, stale revision, replay and audit; Control widget search/save; delegated handover view without full-request access |
| 47: rental and external completion | `assignment-receipt.test.js`: rental closure and existing rental compatibility; internal receipt retained; expiring/rotated customer links, token binding, origin denial, photographed acceptance/rejection and replay; real customer phone flow from Repair Team's generated link |
| 49: one parent receipt after every job | `assignment-receipt.test.js`: company forklifts/trucks, rental and external multi-job requests; no early receipt/link/closure; exactly one receipt event and parent handover; repeat acceptance rejected |
| 50: missing master equipment type | `assignment-receipt.test.js`: confirmed request classification makes the imported machine assignable in Control and excludes it from Dispatch |
| Existing financial, parts, quote and privacy invariants | Full Repair suite, shared-shell regressions, affected Driver/Dispatch regressions and mutation checks |

Final fresh validation command, from `server`:

```sh
sudo -n python3 tools/repair-requester-release.py validate
```

The entry point runs `tools/repair-requester-checks.mjs` through the bounded,
disposable Repair runner in `mbbs-tests.slice`.

| Layer | Result |
| --- | --- |
| Repair tests, coverage run, reversed file order | 115/115 passed in each of three runs |
| Lint, shared-domain types, server syntax, secret scan | Passed |
| Changed backend/shared-domain executable lines | 114/114 covered; no missing lines |
| Overall instrumented Repair coverage | 92.80% lines; 82.81% branches; this includes older code |
| Mutations | 22/22 killed: 5 domain/migration, 3 Team, 9 job/parts flow, 5 requester/receipt |
| Property-only mutation checks | Four selected mutants killed independently by their property suites |
| Affected regressions | 40/40 passed across nine suites |
| Shared login/menu/notification regressions | Passed |
| Real execution | Operator tablet, Driver phone, Repair Team, Control assignment widget and customer phone handover; real HTTP and disposable PostgreSQL/media |
| Supply chain / complexity | No dependency changes; new assignment, link and handover functions follow existing module boundaries. Dependency/license audit skipped because dependency files were unchanged |
| Live checks | 28 HTTP page/access checks; all 35 deployed source hashes verified; healthy app; preserved configuration and other services |
| Cleanup | Both `docker ps` and `docker ps -a` showed only the four production containers; no Repair test volumes/networks; disposable logs, media, coverage and mutation copies removed |

The unchanged legacy asset contract retains its previously recorded failure:
`S11: the guarded client ships in a new atomic Driver shell generation`.
Its other three assertions passed; there were no new failures.

Repair source hash: `52fdf5b132766b7b521e89cf9b75d660ff0e45cccdac0030ad72b068fabf42ed`. Shared integration hash:
`86a59da8ac30fa82b7ee8ef8ab82eecfbd3c8b1504d9f2f400f79167519fc0f0`. Tool versions: Node 20.20.2, ESLint 10.8.0,
TypeScript 7.0.2, c8 12.0.0, fast-check 4.9.0, Playwright 1.62.1.
The complete per-file manifest and concise check results are in `validation.json`.

Failures found and resolved: requester delegation exposure and embedded layout;
missing customer receipt/rental rules; a rejected-receipt retry acknowledgment;
missing classified machines in assignment lists. Test setup retained every
behavioral assertion while updating the office module's cache URL, matching the
public test origin to its real port and replacing colliding random fixture IDs
with database-sequence identities. Teardown now permits up to 30 seconds for the
shared app to recover from another authorized deployment, after removing tests.

Two initial deployment attempts automatically rolled back during public-edge
verification. The app's source and local checks passed. Cloudflare injects an
analytics script into public HTML and rejects Python's default API user agent.
Verification now strips only that exact telemetry script before checking HTML
hashes and uses a browser user agent for every request. The same tested image
then passed all local/public checks and was deployed successfully.

These checks cover the specified boundaries; autonomous specification/testing
has no independent human review. No live customer receipt or NetSuite write was
performed for verification.

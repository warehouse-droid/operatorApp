# IF/IR quantity candidate and persistent wait diagnostics — evidence

Date: 2026-10-21. Spec approval: not obtained (autonomous run).
The user's explicit rollout constraint is honored: the candidate app has not
been deployed, the new quantity flow is off, and activation awaits the user's
confirmation that the replacement NetSuite script is ready. The existing
IF/IR RESTlet remains enabled. No production transaction was created for tests.

Tier 3 checks apply to the posted-quantity and routing changes. The independent,
read-only collector has bounded operational tests and real service execution.

## Final validation

Reproduce both suites with `bash docker/ifir-diagnostics/verify.sh`. Its two
commands were run after the final implementation/test edits:

| Layer | Result |
| --- | --- |
| Posting contracts and affected regression suites | **286/286 passed**, zero failures |
| Reverse file order | **286/286 passed**, zero failures |
| Coverage run | **286/286 passed**; **137/137 changed executable lines** covered across nine compared files |
| Standalone SuiteScript type check | Passed, zero diagnostics |
| App type comparison | 8,546 baseline and 8,546 current diagnostic occurrences; **zero new occurrences**, compared as multisets |
| Targeted lint and complexity | 153 baseline and 152 current diagnostic occurrences; **zero new occurrences** |
| Syntax and whitespace | All nine JS files passed `node --check`; task-file `git diff --check` and runner `bash -n` passed |
| Posting mutations | **6/6 killed**: no correction, widened tolerance, wrong-unit tolerance, omitted remaining guard, ignored release hold, omitted fallback correction |
| Quantity properties alone | Killed all **4/4 quantity mutants**; gate/fallback mutants survived this narrower suite and were killed by their dedicated contracts |
| Collector tests | **9/9 passed**, repeat passed; includes real ingest/report CLI execution |
| Collector mutations | **4/4 killed**: double-counting intervals, retaining secrets, duplicate replay, unbounded log buffering |
| Collector properties alone | Killed the interval mutant; parser/persistence/buffer mutants require their dedicated tests |
| Collector instrumentation | Stdlib trace recorded **146 executed lines in-process**. It does not aggregate CLI subprocess coverage or claim complete daemon branch coverage |
| Secrets/dependencies | Selected JS sources passed the existing secret scanner; no dependency or lockfile changes |
| Operational service | `operatorapp-ifir-timings.service` active, zero restarts at validation; actual Docker events retained and reported |

The coverage comparison uses the deployed app files, except `netsuite.js`
preserves unrelated pending workspace changes and subtracts the new client
setting. The standalone RESTlet comparison uses its committed version, so its
63 changed executable lines also include the pre-existing charge-readback fix.
The baseline regression run therefore had one expected failure:
`charge classification is reread after save instead of reusing pre-save metadata`.
The current candidate passes that test. The repository's pre-existing broad
type/lint findings are not presented as a clean whole-application check.

Tools: Node v20.20.2, fast-check 4.9.0, TypeScript 7.0.2, ESLint 10.8.0,
c8 12.0.0, Python test runtime 3.12.15. Dependency installation used the
repository's existing lockfile with lifecycle scripts disabled.

Posting source-tree SHA-256:
`f5aacd8e5a77679d09bb62b325b1b4bc81aef8f4b1aa3fd14e0577563f5792ee`.
This hashes the compact sorted JSON mapping from paths in
`docker/ifir-diagnostics/changed.json` to each corresponding server file's
SHA-256. The gauntlet verifies those files did not change during execution.

Upload candidate `server/netsuite-ifir-posting-restlet.js` SHA-256:
`8e57f568faa4a96f9bdde146cc426916e67c20c94d565eecb8a2fce622cf5749`.

Collector `docker/ifir-diagnostics/timings.py` SHA-256:
`9cfb876aae9a44f6c3bdff4b73f640801b6897b1b6ae0c84afdb3e142beef1e3`.

## Acceptance mapping

| Spec behavior | Executable evidence |
| --- | --- |
| 70.6200001 → 70.62, actual number and fields, all four transform pairs | `ifir-quantity-correction.test.js`: four named `quantity policy KIND:TYPE` contracts |
| Partial quantities, strict 0.01 boundary, positive remaining/unit evidence | Same file: partial/boundary/unit contracts and two seeded properties, 100 generated cases each |
| Idempotent external-ID retry and honest saved evidence | Same file's replay/readback assertions; `ifir-posting-restlet.test.js` save-race/readback tests and `ifir-posting-client.test.js` uncertain-response tests |
| Acknowledgement and final verifier still required | `ifir-quantity-rollout.test.js`: explicit rollout, missing acknowledgement and workflow-change contracts |
| User's release hold and existing request shape | Same file: default-off, actual app entrypoint and both-gates contracts |
| Reduced redundant reads, durable fallback after gate changes | Same file: explicit deferral and native fallback contracts; existing `operator-posting-rounding-sources.test.js` remains green |
| Private, allowlisted, bounded logging | `test_timings.py`: secret/query removal, malformed input and bounded-reader tests; real file modes checked |
| Restart/replay and container replacement | Same file: SQLite reopen/replay and reader replacement/termination tests |
| Nested/parallel intervals, missing coverage and interval bounds | Same file: nested, overlap and 100 seeded interval cases |
| Usable report without remote writes | Same file: real stdin ingest, duplicate replay, UTC window, JSON and text CLI tests; real service read-only observation |

## Red runs and fixes

Before implementation, seven of nine quantity tests failed; the two negative
tests already passed because the older script rejected the new request field.
Their new quantity/unit protections were subsequently validated by killed
mutants. All six initial app rollout contracts failed before their integration
was added. All six initial collector contracts failed against explicit stubs.
Later regression/property additions passed and were checked by the mutation
suites described above.

Setup failures were corrected without changing the behavior assertions: the
default test image was absent, the available browser image lacked dev tools,
and one test imported a non-exported config builder. The runner now uses an
existing image plus disposable locked tooling, and the test uses the exported
config. Missing baseline migrations were mounted. A new complexity finding was
fixed by extracting the unit guard. The first coverage run identified an
untested real app entrypoint setting; a meaningful default-off entrypoint
contract now verifies it. Test-container ownership initially prevented removal
of two disposable directories; both were explicitly removed and the runner
now executes as the workspace UID/GID. Final automatic teardown succeeded.

## Operational state and limits

The collector started at **2026-10-21 16:54:02 UTC**. It writes only to the
private operational store under
`/home/ubuntu/operatorapp-operations/ifir-timings`; that evidence is retained.
The service is limited to 10% CPU, 128 MiB and 32 tasks. The directory is 0700
and its database is 0600. The live app was explicitly checked to report
`existingIfirRestletEnabled: true` and `newQuantityFlowEnabled: false`.

All IF/IR test containers, test networks and temporary dependencies, copies,
logs and coverage were removed. Both `docker ps` and `docker ps -a` were
checked, and production health passed. No disposable database was started for
this task. Other tasks' concurrent test projects were not modified.

Skipped: live NetSuite posting/activation (explicit user hold); unrelated
application/browser/database suites (affected posting suites were run);
dependency/license audits (no dependency changes); complete collector daemon
branch coverage (stdlib in-process trace plus subprocess/service execution
provides partial coverage, not a 100% claim).

The fixture suite does not prove account-specific SuiteScript sourcing of
`quantityremaining` or unit conversion during transforms. Verify those after
the user's script upload and readiness confirmation. The collector cannot
recover detailed events from containers destroyed before it began collecting,
and it reports completed spans only. Observed elapsed time may include
background photo work; overlapping stage/queue/HTTP totals must not be added.

## Authorized activation — 2026-10-21

The user confirmed "ok, the script is updated". The rollout completed at
17:22:24 UTC (13:22:24 Toronto). Image
`sha256:a4257977d53e293552edadd0b1a9571c99ce600559c39586b0ad5a052bf3672c`
layers only the eight quantity-policy modules on the live sales-delivery-load
release. Unrelated pending workspace edits to `netsuite.js` were excluded.
All 1,433 runtime file hashes matched the candidate; its tree hash is
`20d414426dd84f09df79a6746549d0d2fa6ce1c226cf954e270cb0c7ac4ca107`.
The only environment change is
`NETSUITE_IFIR_POSTING_QUANTITY_POLICY_ENABLED=true`. The existing Admin gate
and the effective quantity policy were both verified enabled.

Exact-candidate checks: 286/286 posting tests passed, including reversed order
and coverage runs; 136/136 executable changed lines covered relative to the
current deployed baseline and committed RESTlet baseline. All six deliberate
mutants were killed. RESTlet typecheck passed; application diagnostics were
8,545 before and after, with zero new occurrences; lint was 153 before and 152
after, with zero new occurrences. The previously documented standalone
RESTlet baseline charge-readback failure remained isolated to the baseline.
The built image also passed a server import in a disposable container.

The uploaded RESTlet advertised `sqft_remaining_v1`. Eight live probes
validated transform evidence without saving: SO→IF, PO→IR and TO→IF accepted
an extra 0.0000001 SQFT and rejected an excess of 0.01; TO→IR accepted exact
remaining EACH and rejected 0.01 excess. Every request included a nonexistent
selected line that must fail before `saveOnce`. Responses confirmed no save
attempt, no ambiguity and no transaction ID. The first TO probe used the
visible source line and stopped before save; the final probes used the app's
existing authoritative physical-leg resolver. No app mapping change was needed.
No open SQFT transfer receipt was available, so TO receipt SQFT tolerance is
covered by the fixture; live receipt field sourcing was validated with EACH.

After activation, verified existing external IDs were replayed through the
deployed client: SO→IF `IF158970`, PO→IR `IR15223`, TO→IF `IF158891`, and TO→IR
`IR15191`. All returned `outcome: existing`, the requested policy, matching
IDs/numbers and saved fields accepted by the production verifier. No business
transaction was created by rollout validation. Actual new posting latency
requires subsequent business activity; these replays are not a speed comparison.

There were no executing posting/driver/stock/SCM operations or idle open DB
transactions at cutover. Health passed and the database, webhook worker and
Ollama containers were unchanged. At 17:23:41 UTC the collector had zero
restarts, was attached to the replacement app container, and retained 180
timing events. Both Docker container listings contained only the four
production containers; the disposable test project and its network were
removed. The retention runner removed temporary dependencies, copies, logs
and coverage. No test database was started.

Concise operational evidence, release configuration, source manifest and
rollback configuration are retained in
`server/deployments/ifir-quantity-policy-20261021`. The rollback override
restores the preceding image and disables the new quantity flag. The earlier
hold-state paragraphs above describe the preceding preparation run; this
activation record supersedes that state.

## SOB123167 unit-reader repair — 2026-10-21

Spec approval: not obtained (autonomous bug-fix run). The production reader
returned no unit for SOB123167 because REST supplied `units: "854"` without a
display label. The same source line's SuiteQL unit was 854/SQFT, conversion 1,
remaining 204.6. Earlier tests supplied a display label or an already-normalized
source; existing-transaction RESTlet replays did not exercise this pre-post
reader. The new regression uses the raw response shape and the actual guard.

`operator-posting-rounding-unit-evidence.test.js` maps the repair contract to
nine named cases: SOB123167 acceptance with exactly two reads; object unit
reference and native conversion; conflicting labels; conflicting IDs; missing
or non-SQFT labels; existing REST-label fallback; real-reader/native-fallback
integration; matching-shape property; and conflicting-evidence property. Each
property executes 100 seeded examples. The RED run passed 2 existing behaviors
and failed 7 cases, including the exact reported error. Targeted mutations
also demonstrated that the two initially-passing regression tests can fail.

The final candidate passed 295/295 affected posting tests, reverse ordering
and coverage. All 36 changed executable reader lines were covered. All 12
deliberate mutants were killed, including six unit-evidence mutants. Three of
those six were also killed by the property tests alone; query projection,
REST-only fallback, and the missing-evidence guard were caught by concrete
regressions, not by those properties. RESTlet typecheck passed. Application
diagnostics were 8,545 before and after, with no new occurrences; lint was 153
before and 151 after, with no new occurrences. An initial lint failure on the
reader map's complexity of 13 was resolved by extracting unchanged eligibility
logic; tests were unchanged. The final server image passed import and all
1,433 runtime hashes matched. No dependencies changed; the scanner found no
secrets. Unrelated browser/database suites and dependency/license audits were
skipped because only this existing reader changed.

Reproduce with the normal `docker/ifir-diagnostics/check.sh` entry point. For
the exact release, set `IFIR_TEST_SERVER_ROOT` to the release's `candidate`,
`IFIR_TEST_BASELINE_ROOT` to `before`, and `IFIR_TEST_RELEASE_DIR` to
`server/deployments/ifir-sqft-unit-evidence-20261021` (absolute paths). The same
directory retains the concise test and deployment receipts. Tool versions
remain Node 20.20.2, fast-check 4.9.0, TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0.

The one-file overlay deployed at **18:09:07 UTC / 14:09:07 Toronto**. Image:
`sha256:1acb964d2853777f277c4179d8fa684f2b8a7d798228464817e3ec484f3694be`.
Candidate tree:
`1c69d68266588bf24c61159f1f4961a3c3f770bcedb6f1ac95bbadad44098826`.
Only `src/netsuite.js` changed; all environment settings, the active quantity
policy, other services and the uploaded RESTlet were preserved. Preflight
initially waited for an idle open DB transaction; it cleared before restart.

At 18:09:31 UTC, the deployed reader and both deferred/native fallback guards
accepted the actual saved failed requests for SOB123167 (204.6 SQFT remaining)
and SOB123163 (4 SQFT remaining). These checks were read-only and left the
saved payloads intact. No failed business command was retried and no IF/IR was
created by validation. The app is healthy, the collector followed the new
container, and the disposable test containers/networks and temporary runs were
removed. Operational proof is `live-reader-check.json` in the release folder.

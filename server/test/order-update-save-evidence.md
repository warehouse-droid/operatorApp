# Dispatch saves during order updates

Verification status: complete with the user's accepted performance exception
of September 18, 2026. The implementation and all functional checks are complete.
The original failed timing measurements remain recorded below. The subsequently
authorized deployment completed at 02:40:56 UTC on September 18, 2026; see the
[deployment record](order-update-save-deployment.md) for the exact package and
post-deployment checks.

## Scope and cause

The user authorized implementing the existing fix plan and explicitly required
regressions for grouped orders, split orders, CO, linked TO, linked PO, address
changes, and address overrides. The [executable specification](order-update-save-spec.md)
records that scope. Spec approval: not obtained (autonomous run); the user's
implementation instruction authorized the work, but the executable document
was not separately reviewed before implementation.
Tier 3 was selected because concurrent writes can lose dispatch work.

The recorded incident involved September 18 plan 330. Command 2246 saved
revision 63 at 21:48:08.350 UTC on September 17. Driver completion requested
billed-family cleanup for SOA07539 across two dates. History 17722 and 17723
show that cleanup removed two unused split snapshots while leaving the ten
trucks and their stops unchanged. Nevertheless, the cleanup advanced the
edited plan to revision 64. The next move sent revision 63 and received 409
(audit 2151016). Its digest exactly matches the archived revision 63.

The revision fence was correctly detecting a database change. The defect was
that background order maintenance could change an actively edited snapshot,
while its notification referred to the Driver job's other date. Delayed browser
refresh and recovery reads could also overwrite newer acknowledgement state.
Refreshing fetched the new revision, explaining why re-editing appeared to fix it.

## Implementation

Migration 205 adds a durable per-plan maintenance queue. Source order status and
Driver evidence remain live. Snapshot maintenance respects date edit leases,
joins the next valid autosave transaction, or drains after lease release/expiry
and application restart. Actual changed plan dates receive notifications after
commit. Generation checks prevent old workers from discarding newer work.

The queue covers sales-family cleanup, unsplit retirement, PO reference changes,
and CO identity repair. PO renames preserve request order, including a second
source rename before the first has reached its snapshot. Applied PO/unsplit
corrections remain available throughout the edit session so later buffered
edits cannot resurrect old references; unchanged saves remain unchanged.

Edit Mode verifies a fresh snapshot after acquiring its lease. Refresh and draft
recovery results are ignored if newer edits, acknowledgements or date changes
overtake them. A recovery warning clears only when its exact draft was saved.
Existing revision/digest fences, idempotent retries, Driver execution guards,
pickup/dependency validation, Undo/Redo and draft recovery remain in place.

## Specification mapping

| Behavior | Executable evidence |
|---|---|
| Incident fence; move plus cleanup; classic and V2 retry | `test/dispatch/integration/order-update-save.test.js` |
| Cross-date writes, release, expiry, restart, no-op maintenance | Save/lifecycle suites; `tools/order-update-save-startup.mjs` |
| Durable intent, newer generations, rollback, retries, acquisition race | `test/dispatch/integration/order-update-lifecycle.test.js` |
| Driver-completed prefix survives unrelated movement | Lifecycle/writer/property suites and existing Dispatch execution tests |
| Group orders and split orders; active global definitions | `order-update-actions.test.js`, first two cases |
| CO cargo quantities and physical placement | `order-update-actions.test.js`, CO case |
| Linked TO and linked PO, atomic acknowledgement plus subsequent move | `order-update-actions.test.js`, dependency cases |
| Split address change preserves sibling address | `order-update-actions.test.js`, address-change case |
| PO address override and clearing preserve vendor pickup | `order-update-actions.test.js`, override case |
| Other automatic writers, chained renames, buffered stale identities | `test/dispatch/integration/order-update-writers.test.js` |
| Late refresh/recovery, fresh lease snapshot, exact draft acknowledgement | `test/dispatch/frontend/order-update-save.test.js` |
| Real rapid edits, delayed and lost acknowledgements, autosave, Undo | `tools/order-update-save-browser.mjs`, Chromium and WebKit |
| Coalescing, ordering, protected execution, repeated buffered edits | `test/dispatch/property/order-update-save.test.js` |
| Additive migration and old-runtime read/forward recovery | Migration integration suite; `tools/order-update-save-rollback.mjs` |

## Reproduction and boundaries

From the repository root, run:

```sh
sudo -n bash server/tools/order-update-save-performance-followup.sh --full
```

It reconstructs the pre-task runtime from the persisted task patch and recorded
hashes, runs disposable PostgreSQL databases on internal Docker networks, and
compares named failures and static diagnostics against that baseline. The
workspace was already dirty; no existing changes were reverted and no commit
was made. The final source/test/tool inventory and image IDs are written under
`server/test-artifacts/order-update-save/`.

The command retains the original strict timing gate and can exit nonzero for
the documented differences. The user's acceptance applies to this measured
implementation; it is not an automatic waiver for future runs or changes.

No dependency was added. Package and lockfile hashes are checked against the
pre-task copies. New runtime capabilities are database queue reads/writes,
an application timer, existing after-commit events, and one same-origin snapshot
read on entering Edit Mode. There is no new external service or subprocess in
the application path. Test tools use Docker/Node/Playwright already present.

The optional private incident capture is SELECT-only and is not committed.
Its replay verifies actual archived order/truck structures and the original
fence in isolation. Historical source eligibility and the failed full request
are unavailable, so it is not described as a complete historical HTTP replay.
The always-run minimized incident fixture exercises real HTTP saves.

Rollback keeps migration 205 and its queue. The prior runtime can read the new
acknowledged plan, and rolling forward resumes pending work. The old runtime
does not provide the new cleanup coordination guarantee. Production rollout
must apply the migration before app/worker replacement and refresh the Dispatch
asset version. The initial verification performed no production deployment or
production plan write. The subsequently authorized deployment applied migration
205 and passed the separate package and live checks linked above.

## Development failures retained as evidence

Initial RED runs reproduced the active-lease revision change, stale browser
refresh/recovery races, missing durable intent, unchanged saves leaving cleanup
queued, reversed PO rename ordering, and buffered edits reviving old identities.
The broader suite also caught a removed snapshot-row lock and migration
inventory assertions; these were corrected without removing their checks.
The incident replay initially lacked split-family relationships and compared
new cleanup metadata with its historical timestamp; the fixture and explicit
replay scope now account for that missing source history.

## Frozen-source verification

Source/test/tool hash used for the verification run, before the documentation
amendment recording the user's performance acceptance:
`e343633b6f462cd905673c3b7473b39c8dee3650878d3bcecab25626f02a7f3a`.
Node: `v20.20.2`. Exact Docker image IDs are recorded in `images.txt`.
Runtime, schema, test assertions and verification tools remain unchanged since
that run. Only the specification/evidence documentation and acceptance records
were updated after the user's response; functional tests were not rerun for
these documentation changes.

| Layer | Result and artifact |
|---|---|
| Focused regressions | 50/50 pass across six files; `focused-coverage.log` |
| Generated properties | 190 cases across four properties; fixed seeds 20260917–20260920 |
| Mutation | 7/7 killed by the focused suite and independently 7/7 by properties alone; `checks.json` |
| Suite order | All 50 pass again in reversed file order; `focused-reversed.log` |
| Full application suite | Both versions fail the same 4/523 files; zero new named failures; `full-comparison.json` |
| Other Dispatch tests | Both versions fail the same 31/206 files; zero new named failures; `adjacent-comparison.json` |
| Static checks | Lint diagnostics 2296 → 2295; type diagnostics 243 → 243; zero new diagnostics; `static-comparison.json` |
| Syntax | All nine changed runtime JavaScript files pass `node --check` |
| Changed-line execution | 369/369 executable changed lines across nine runtime files; `changed-line-coverage.json` |
| Complexity | All 17 new named helpers within the 80-line/24-decision budget; largest 28 lines, highest 8 decisions; `complexity.json` |
| Secrets/dependencies | Zero scan findings; package/lockfile hashes unchanged; `secrets.json`, baseline hash verification |
| Actual startup | Starts the real server and drains persisted work to revision 64; `startup.json` |
| Migration/rollback | Upgrade/idempotency tests pass; prior runtime reads the acknowledged save, pending work survives rollback and drains on forward resume; `rollback.json` |
| Recorded incident | Original revision-63 digest matches; 46 → 44 archived orders with all ten trucks preserved; isolated replay succeeds; `incident-replay.json` |
| Chromium/WebKit | Rapid edits, delayed response, lost-response retry and Undo continuity pass; all save responses 200; maximum action feedback 69.4/208.6 ms; `browser.json` |
| Matched performance | All six matched pairs retained; original timing failures explicitly accepted by the user for this fix; `performance-comparison.json`, `performance-acceptance.json` |

The initial performance comparison remains in `performance-three-pairs.json`.
It measured Chromium first navigation +15.0 ms and repeated navigation +2.0 ms;
WebKit first navigation +45.3 ms and edit p95 +20.0 ms. Both save p95 values
remained within the existing 20% budget. These observations are not a passing
performance result. The follow-up balances execution order and retains every
sample; it changes neither the benchmark assertions nor their tolerances.
The combined six-pair result still fails the original gate:

| Measurement | Chromium baseline → candidate (ms) | WebKit baseline → candidate (ms) |
|---|---|---|
| First navigation mean | 410.6 → 428.1 | 1407.3 → 1445.5 |
| Repeated navigation median | 316.8 → 313.5 | 450.5 → 445.0 |
| Edit p95 | 306.7 → 306.2 | 451.0 → 466.0 |
| Save p95 | 623.7 → 642.5 | 738.5 → 715.1 |

The user responded, **“Accept and document these measured differences”**, on
September 18, 2026. The accepted differences are Chromium first-navigation
mean +17.55 ms, WebKit first-navigation mean +38.17 ms, and WebKit edit p95
+15.00 ms. This resolves the remaining verification condition for this fix.
The benchmark still reports `passed: false`; no result or threshold was changed
to manufacture a pass. The acceptance record binds the decision to the measured
source and the full six-pair report. No broader performance waiver is implied.

Each engine/version has six first-navigation samples, 42 repeated navigations
and 480 edits. The gate permits no increase in first navigation, repeated
navigation or edit p95; save p95 permits 20%. The first-navigation paired
deltas change sign across runs, but this alone does not establish that the
remaining measured difference is noise. A diagnostic profiler is separate from
the benchmark and does not replace or relax its result.

The follow-up launcher and diagnostic profiler were added after the frozen run
began, separately from the original inventory. All 48 original source, test and
tool hashes were rechecked after the six pairs and again before recording user
acceptance. The specification then received the append-only acceptance amendment
above. `verification-status.json` and `final-run-complete.json` record completion
with the accepted exception; `verification-before-acceptance.json` preserves the
previous failed status. The supplemental tools' syntax checks pass and the
repeated secret scan has zero findings (`supplemental-checks.log`).

The diagnostic profile (`profile-baseline.json`, `profile-candidate.json`) records
three navigations per engine, function durations and order counts. Rendering
accounts for roughly 97% of measured edit time when the 1,020-order list is loaded
in both versions. Both diagnostic runs also show the first WebKit edits occurring
before the background catalog has loaded (20 orders), demonstrating a readiness
variable in the benchmark. This is a limit of the measurements, not grounds for
discarding them or declaring the unchanged performance gate passed. No application
optimization was made without an identified cause.

The four full-suite baseline failures are the shared browser-fixture contract,
an existing Operator asset-version assertion, and module-load failures in
`local-load-performance.test.js` and `operator-background-photos.test.js`.
The Dispatch baseline includes existing assertion failures and browser tests
whose dependencies are absent from the unit-test image. The dedicated new
browser scenarios use the Playwright image and pass in both engines. The JSON
comparison reports retain every failing name and count; neither broad suite is
represented as entirely green.

Coverage records V8 branches, but the gate above measures changed executable
lines rather than claiming complete branch coverage. This run repeats focused
files in reverse order; it does not claim randomized execution of every legacy
test. No dependency audit/install was needed because dependencies did not change.
A complete historical source/request replay was not performed. The later
deployment and its separate package verification are recorded above; no synthetic
production-plan writes were used for testing.

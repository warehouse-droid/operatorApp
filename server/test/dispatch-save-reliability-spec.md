# Dispatch save reliability — approved implementation, 2026-09-17

The user approved the proposed five-part plan and added a strict requirement:
the enhancement must not reduce planning-page responsiveness or increase page
loading time. Tier 3 (save integrity, leases, concurrency). Spec approval obtained.

## Acceptance contract

1. Revision/digest fences describe persisted plan state, never read-time source
   enrichment. Bootstrap, classic/V2 saves, checkpoints and lifecycle reads agree.
   Fresh source data is still reconciled and validated before committing.
2. Actual persisted changes, including same-revision out-of-band writes, still
   reject stale requests. Never waive digest checks or adopt a newer fence blindly.
3. One editor per date: acquire, ownership, expiry, release and save commit are
   serialized. View Mode and a former owner cannot mutate. Same-owner overlapping
   requests retain revision and idempotency protection.
4. Autosave, Save, Undo/Redo, confirmation and date/lease transitions coordinate
   pending generations. A late response cannot replace newer edits or another date.
   Normal Save does not force-overwrite. Uncertain retries retain request identity.
5. Unsaved changes survive recoverable errors; pending changes have bounded,
   asynchronous IndexedDB recovery, separate from the full order catalog. Failed
   persistence is visible. Existing invalid-draft recovery remains unapplied.
6. Error messages identify lease, revision, persisted content, or business failures;
   background data refresh must not be attributed to another screen. A rejected
   fingerprint is not resubmitted indefinitely.
7. All retained Dispatch history is captured read-only with a manifest and replay
   classification (exact, reconstructed, gap). No historical/active production
   plans are rewritten. Missing/pruned requests cannot count as exact passes.
8. Stress gate: 10,000 real HTTP saves, 1,000 deterministic race schedules,
   10,000 generated action sequences, and a 60-minute soak; one editor per date
   across 1/5/20 dates with viewers and injected delays/duplicates/lost responses.
9. Zero lost acknowledged edits, duplicate commits, partial writes, unauthorized
   writes or false persisted-state conflicts. Existing business/Driver locks hold.
10. Page startup gains no blocking requests, catalog hydration or synchronous
    storage work. Measure matched baseline/candidate cold/warm startup and edit
    latency in Chromium/WebKit; reject repeatable regressions. Save p95 remains
    within 20% of successful baseline on matched fixtures/hardware. No added
    startup payload beyond the bounded recovery/save implementation.

## Setup and evidence

Use existing pinned Node/PostgreSQL/Playwright/fast-check/c8/ESLint/TypeScript.
No new dependencies or commits. Preserve unrelated working changes. Freeze current
runtime source before edits; isolate tests from production and external services.
Write regressions and observe RED before implementation; preserve assertions.
Run baseline and final project suite, affected Dispatch suites, browser/performance,
properties, coverage and five meaningful mutations (also properties alone), secret
scan and randomized suite health. Persist replay, stress, CI and release tooling.
All final claims must be bound to final source hashes and actual completed runs.
Deploy a narrow overlay only after all applicable gates pass; retain rollback.

Failure model: enrichment changes the comparison input; revision/digest pair drifts;
lease-check/commit race; duplicate/lost responses; older ack clears newer edits;
draft loss; authority/Driver protection regression; replay drops causal fields;
main-thread/storage/startup regression; partial projections or silent failures.

## Additional user constraint, 2026-09-17

Each order plan/data update during replay must finish within 500 ms. Record each
operation and the maximum, rather than relying on an average or p95. Deliberately
held race barriers and injected network delays are reported separately from
healthy update latency; their injected delay is never represented as application
processing time. The page startup/editing and save-baseline gates still apply.

## Existing test migration, 2026-09-17

The strict single-editor contract intentionally rejects a correct lease token
paired with another session. Positive legacy fixtures must send the session
that acquired their lease and both acknowledged fence values. Source-shape
assertions referring to live `currentPlan.digest` now refer to the frozen
payload; confirmation route refinement moved into the serialized worker.
Keep their business/outcome assertions and the new executable retry tests.

## User clarification, 2026-09-17

The user explicitly confirmed that the 500 ms maximum applies to **each
historical replay update**, not to 20 simultaneous saves on different dates.
Keep every stress latency sample and the integrity/race assertions. Treat burst
latency as measured capacity; apply the strict per-update timing gate to history
replay. The startup/edit responsiveness and matched save-p95 gates still apply.

## Historical failure discovered, 2026-09-17

Retained command 1833 exposed SQLSTATE 21000 during save: dependency enrichment
used relationship aliases as snapshot identities, replacing a source/member with
a sibling split or its aggregate group. Preserve each order's own identity,
quantity, and nested data when refreshing its projection; aliases may locate
relationships but cannot rename a stored order. Add permutation/property and
existing group/split command regressions. This failure is in the requested save
path and is included in the implementation scope.

## Browser harness corrections, 2026-09-17

The full confirmation flow can normalize the submitted snapshot and change its
status in one transaction, advancing the existing revision twice. Retry integrity
therefore asserts identical response revisions, exactly one command receipt with
the submitted base revision, and unchanged stored revision after retry; the
initial browser harness incorrectly assumed every confirmation advanced once.
Snapshot reload clears the transient success notice in the existing page. Verify
the selected current snapshot and stored restored data, rather than requiring
that transient notice to survive the reload. These corrections preserve the
approved one-commit-per-command and recovery outcomes.

## Replay performance refinement, 2026-09-17

The complete replay measured large retained boards above 500 ms. CPU profiling
identified duplicate canonical hashing and whole-plan copying: the database
command already owns fencing and durable receipts, then invokes a second,
in-memory receipt wrapper. Extract the shared pure plan transformation so each
wrapper keeps its own fence/receipt enforcement without repeating the other
wrapper's work. Existing state, digest compatibility, retry, mutation and generated
sequence assertions remain unchanged. Restart final source-bound runs afterward.

## Latest user clarification: action responsiveness, 2026-09-17

The user clarified: "the 0.5 second is per action, as long as the save did not
block, then it is good." This supersedes the earlier interpretation that every
historical database save must finish within 500 ms. Keep all backend/replay
latency samples as measurements. Gate user-action feedback and continued browser
responsiveness at 500 ms while a real save response is deliberately held for at
least 1.5 seconds. Verify subsequent edits remain usable and eventually persist.
Startup, integrity, retry, ownership, and matched baseline checks remain required.

## Baseline race diagnostic and final adversarial checks, 2026-09-17

One existing CO cancellation test intermittently requires exactly one fulfilled
promise. The live baseline reproduces the same failure when cancellation enters
the shared lock first: cancellation succeeds, then save succeeds after removing
the cancelled CO. Its neighboring stale-save test explicitly expects that scrub.
Keep the original assertion unchanged. Diagnose both submission orders on the
baseline and candidate, and separately assert the persisted safety invariant:
a cancelled CO is never left planned. Record this pre-existing scheduling
sensitivity in evidence; it is not permission to ignore a new integrity failure.
Final adversarial cases also verify delayed confirmation generations, visible
recovery/retry errors, unchanged-save fencing and rollback after each submitted
confirmation validation failure. These are regression checks of existing paths;
do not claim their first run proved a new runtime defect.

The additional confirmation fixture initially expected a nonexistent specialized
missing-driver code. The existing validation emits the established
`DISPATCH_DRIVER_TIME_CONFLICT` fallback with missing-assignment details. The test
now asserts that actual API contract and unchanged revision/digest/status/receipt;
no runtime change or relaxed validation was made for this fixture correction.

## Explicit source-event simulation, 2026-09-17

The user asked whether replay applies order-data events. Distinguish retained
state replay from event simulation. Add real source-reconciliation updates
between load and save, refresh and verify the visible order changed while the
persisted fence did not, then save and retry the unchanged request identity.
Exercise classic/V2 HTTP paths, browser schedules before commit and after commit
with a delayed response, and eligible retained split/group histories. Generated
metadata events are explicitly simulated; absent source versions remain gaps.
Do not claim partial audit rows form an exact chronological event replay.

The cancellation-first schedule reproduces the legacy assertion failure on both
versions in 10/10 attempts, while all 20 persisted safety checks pass. Run the
adjacent baseline suite with that valid schedule for a deterministic comparison;
keep the failure visible in baseline and candidate totals. The loader swaps only
submission order and adds the persisted integrity assertion before the unchanged
original assertion. Coverage reports exclude comment-only/blank lines using
parser token locations; V8 cannot execute a comment. Executable changed lines
remain the required coverage set.

## Performance defect found in final measurements, 2026-09-17

Repeated baseline/candidate runs found a startup/editing regression. The new
idle draft backup unnecessarily called full plan normalization and route/summary
calculation, and recovery module loading could precede the board's first paint.
Two new tests failed before the fix: a draft-only capture must not recalculate
or mutate the live plan, and recovery work waits through the initial paint.
Add a lightweight draft capture option; actual server requests still use full
normalization. Preserve pending immutable requests before HTTP. Defer recovery
through two animation frames with the existing timer fallback. Restart final
source-bound tests, replay, browser measurements and soak; do not use the earlier
runtime's results as final passes. The previously quoted estimate is extended.

The final source-event replay also contains retained transfer-order splits now
closed in the captured authoritative data. Three of the 2,505 simulated updates
refresh their definitions, but the operational read correctly hides them and save
rejects `NETSUITE_ORDER_CLOSED`.
Report hidden source refreshes separately and reject any unexplained missing
refresh; do not count this closed-order rejection as a false persisted-state
conflict or as a visible source refresh.

## Repeated browser measurements, 2026-09-17

The first final-runtime comparison improved repeated navigation in both engines,
but one first-navigation sample was slower and Chromium edit p95 increased by
3.3 ms. Before collecting further results, schedule two additional matched
rounds, reversing baseline/candidate order in the second. Retain and include all
three rounds. Compare the median of the three first navigations, all 21 warm
navigations, all 240 edit samples, and all 24 saves per engine/version. This
resolves a single-launch timing outlier without selecting a favorable round.
The limits remain unchanged: no startup/edit increase and save p95 within 20%.

## Profiled rendering correction, 2026-09-17

All three final-runtime timing rounds remained outside the unchanged limits.
Actual Chromium profiling attributed about 640 ms of a 932 ms large-catalog edit
to repeated assignment and order scans. Build one assignment lookup per order-list
render, preserving the existing first matching truck/load/stop and all supported
parent/child reference matches. Never retain it between renders or use it for
write identity. Reuse the fixed Toronto date formatter, never the resulting date,
so midnight and daylight-saving boundaries remain current. Ensure the background
catalog starts after the initial authoritative board can paint; recovery scheduling
also starts after the awaited forecast step. Observe the new performance and
behavior tests failing first, then restart the complete final-source gauntlet.
The previous runtime's passing soak remains diagnostic evidence, not a final pass.

The corrected runtime passed editing, saving and repeated-navigation comparisons.
First-load marginal medians gave an inconsistent signal: WebKit was faster in two
of three matched rounds (deltas -16, +25, -32 ms), and its mean was faster, but
subtracting the two marginal medians reported +25 ms. Before further sampling,
add 13 first-navigation-only pairs, reversing order to give eight baseline-first
and eight candidate-first pairs across all 16. Include every original and new
sample. Require both the overall first-load mean and the median paired change to
show no increase; retain marginal medians as diagnostics. Other timing limits stay
unchanged. Do not keep sampling until a favorable run appears. Runtime is unchanged.

The fresh full suite exposed a pre-existing source-shape assertion whose 600-character
gap limit no longer accommodates the paint scheduling code. Replace that assertion
with execution of the actual initializer, capability loader, and BIN feed loader.
Assert the complete render/snapshot/connect/capability/feed ordering with the gate
both disabled and enabled, and assert a direct disabled feed call makes no request.
Preserve the other compatibility assertions. This changes test evidence only, not
the frozen runtime; rerun the full suite and remaining final-source checks.

Final changed-line coverage identified unexercised indexed card fallback and
dependency-parent branches. SAVE-UI-36 renders real planned, unplanned, dependent,
and missing-parent cards through both the legacy lookup and the index, requires
identical complete output, asserts visible planned/drag states, and rejects any
repeat scan on the indexed path. Removing a stop and rebuilding the index must
immediately clear the planned badges. This adds evidence without a runtime edit.

## Startup read overlap, 2026-09-17

All 16 prescribed startup pairs completed. Chromium mean first readiness was
424.95 ms baseline versus 431.79 ms candidate, with a +4.25 ms paired median;
the strict no-increase gate therefore remains failed. WebKit and repeated
navigation/edit/save checks passed. Retain every sample; do not add more rounds
or introduce timing tolerance. CPU/network traces show setup reads serially
precede the independent saved-plan bootstrap request. Start those reads together,
but await both before adopting the plan, its fence, or rendering the ready board.
Test both completion orders and failed setup without adopting any partial state.
Observe SAVE-UI-37–39 fail first, then restart all final-runtime gates after this
bounded startup correction. Earlier passing soak/replay data remains diagnostic.

Three diagnostic pairs after overlapping setup alone did not establish a reliable
Chromium improvement. The CPU trace attributes about 60 ms to the initial loading
render, before any bootstrap request starts. Start all initial reads first and put
the loading render in their readiness promise, so network work overlaps that CPU
work. The render is still a prerequisite for plan adoption; setup, render, or fetch
failure prevents adoption. SAVE-UI-40 observes request/render/adoption ordering.
Initializer mocks must honor the new setup-readiness prerequisite. Preserve the
three provisional pairs; restart the prescribed full timing set on the final code.
SAVE-UI-41 also requires a rejected loading render to reach the locked fallback
view without adopting the fetched snapshot or producing an unhandled rejection.

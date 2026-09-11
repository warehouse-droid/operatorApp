# Google Maps usage-control verification evidence

Date: 2026-09-11 UTC

## Outcome

The Google Maps usage-control implementation passed the complete focused
gauntlet, the complete isolated MBT suite, the complete legacy baseline, and a
read-only replay of the latest seven complete production UTC days. The replay
projects 425 controlled usage units per 30 days, below the requested 5,000
ceiling and the application's 4,500 hard limit.

The final source review found no further safe hot-path call reduction to add.
In particular, the replay's 92 geocodes represent 92 unique observed
destinations, so claiming or forcing additional reuse would change location
verification behavior rather than remove duplicated work.

No deployment, production migration, production write, or Google API request
was performed by this verification.

The executable behavior is defined in
`google-maps-usage-control-spec.md`.

## Seven-day production replay

Command:

```text
npm run replay:google-maps-usage
```

The command ran inside a PostgreSQL `REPEATABLE READ READ ONLY` transaction and
rolled the transaction back. It did not call Google.

- Window: `2026-09-04T00:00:00.000Z` through
  `2026-09-11T00:00:00.000Z`.
- Evidence: 111 plan snapshots, 310 active-truck intervals, 259 jobs, 92
  unique observed destinations, one dependency suggestion, nine known browser
  sessions, and six confirmation events.
- Route previews: 1,401/1,401 valid; 1,216 retained Google previews and 185
  deterministic fallbacks.
- Historical defects: all 45 malformed source previews were identified as
  `leg_count_mismatch` and repaired with valid fallbacks; none were silently
  omitted.
- Fingerprints: 1,401/1,401 stable.

| Mechanism | Dispatch routes | Monitor ETA | Driver geocode | Dependency routes | Dynamic maps | Seven-day total | Projected 30 days |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Reconstructed legacy | 103 | 13,941 | 92 | 3 | 9 | 14,148 | 60,635 |
| Controlled | 7 | 0 | 92 | 0 | 0 | 99 | 425 |

The identical-event comparison is a 99.3% reduction. Every replay assertion
passed: all previews valid, all fingerprints stable, projected controlled usage
below 5,000, and zero Google calls made by replay.

The legacy comparison is a reconstruction, not a Google Cloud invoice. Its
browser-session count is a lower bound because historical map-canvas creation
was not previously metered. Google Cloud billing remains the final authority.

## Focused gauntlet

Command:

```text
bash server/tools/google-maps-usage-gauntlet.sh
```

Final result:

- Migration 198 applied successfully to the isolated database.
- 31/31 unit, property, adversarial, concurrency, frontend, adapter, and
  integration behavior tests passed.
- Coverage across the policy, gateway, and replay modules: 97.12% statements,
  79.01% branches, 93.93% functions, and 97.12% lines.
- Strict focused ESLint passed.
- 8/8 usage-control mutants were killed, including hard-limit, subsystem,
  denied-call, monitor fan-out, traffic identity, malformed-preview, and
  high-waypoint guards; sources were restored.
- Secret scans passed for all 30 server paths and the root deployment example;
  no high-confidence findings were detected.

## Whole-worktree regression evidence

- Complete isolated MBT main run: 455 files and 2,258 tests passed.
- Complete legacy baseline: 134/134 harnesses passed.
- Focused Dispatch cache-generation contracts: 11/11 tests passed.
- Dispatch unplan-freshness mutation check: 4/4 mutants killed; sources were
  restored.
- Dispatch Monitor, route-duration, memory-bound, Driver location-reliability,
  and consecutive-stop-visit harnesses all passed and are also covered by the
  successful full legacy baseline.

During the whole-tree review, stale test contracts were updated to match the
already implemented browser generations, the Maps Usage Admin section, the
authorized explicit PO/TO search behavior, and the one-time Driver location
verification receipt. These changes strengthen the intended contracts; they
do not relax the route budget or Driver completion gates.

### Browser-matrix audit and completed-stop race repair

The first complete Playwright matrix executed 501 cases: 496 passed and five
failed. One failure exposed a real completed-stop evidence race: after a
successful append, the refresh could recreate the submitted form draft, and a
remote `driver.stop.photos_added` event arriving during photo preparation was
discarded. The client now refreshes a successful append without recapturing the
released form and coalesces/defer-retries live refresh events until the active
operation finishes. The Dispatch review bundle was advanced to
`20260911-completed-photo-draft-v2`.

- The strengthened scenario passed on Chromium desktop, Chromium mobile, and
  WebKit mobile (3/3). It verifies a blank post-submit draft, retention of a new
  reason/photo, and stale-state revalidation after an event deliberately sent
  while compression remains busy.
- Two regression mutants were killed: resurrecting the submitted form failed
  on the old reason, and dropping busy-time events failed on missing stale
  state. The verified source was restored and the 3/3 browser run passed again.
- The two initial P3 BIN accessibility failures passed when isolated on both
  mobile engines, identifying them as suite-order/timing flakes.
- Two unrelated active-CO manifest cases remain outside this change: mobile
  Chromium has an order-pool overlay intercepting the load-title click, and
  the WebKit variant invokes Chromium-only JavaScript coverage. Those cases
  must be repaired and the complete browser matrix rerun before treating the
  whole worktree as deployment-ready.

## Runtime guarantees verified

- Ordinary render, polling, and draft-save paths do not call Google routing.
- A changed confirmed load uses at most one multi-stop route request; an
  unchanged fingerprint reuses its persisted estimate.
- Monitor ETA is explicit/manual and has a 15-minute same-route cooldown.
- Capacity denial returns a labelled local fallback immediately; requests are
  not queued for later execution.
- The rolling hard limit is 4,500, leaving 500 units below the 5,000 target,
  with narrower per-subsystem limits and concurrency-safe admission.
- Photo completion reuses a valid job/device-bound location receipt and falls
  back to a fresh check if the receipt is absent or invalid.
- The Admin Maps Usage panel shows daily admitted usage and attribution by
  action/API, including attempted, denied, failed, and latency counts.
- The server key is never exposed to browser configuration; browser Maps uses
  its own restricted key and centrally metered canvas admission.

## Deployment boundary

This verification intentionally did not deploy. Before a whole-worktree
cutover, configure separate restricted server and browser keys, confirm the
Google Cloud project quota/budget alerts independently, apply migration 198,
and keep the application in `conserve` mode for the initial observation
window.

## Subsequent whole-worktree deployment — 2026-09-11

The historical deployment boundary above was followed by the authorized
whole-worktree release. The two active-CO browser harness issues and the BIN
edit-readiness timing issue were resolved without removing behavioral
assertions; all 501 configured browser cases are verified by the final profile
runs plus three exact missing-input replays. The full 2,258-test MBT and
134-harness legacy runs passed for the frozen runtime.

Migration 198 is now applied. The separate browser key and actual Routes and
Geocoding requests passed; the user added Routes API permission to the
existing server key before cutover. Deployment uses budget-controlled `normal`
mode to retain embedded maps, with the 4,500 rolling hard limit and 300 automatic
map-load allowance unchanged. The earlier projected 425 calls describes the
conserve-mode replay, not a complete normal-mode bill. Cloud quota/billing
alert configuration remains independently unverified.

Both production app and worker now use the same tested image. Cutover
unavailability measured 4.45 seconds, and production post-checks passed.
Full image identity, source hash, precise test aggregation, credential checks,
and the separately investigated printer-auth warning are recorded in
[the whole-worktree release evidence](whole-worktree-deployment-20260911-evidence.md).

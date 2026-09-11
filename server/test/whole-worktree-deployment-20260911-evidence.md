# Whole-worktree release evidence — 2026-09-11

Status: deployed on 2026-09-11; production post-checks passed. The Google Routes
permission blocker was resolved before cutover. Both app and webhook worker
now run the frozen whole-worktree image, and migration 198 is applied.

## Authorization and scope

The user requested deployment of the complete shared worktree with a short
cutover after tests passed, then supplied the separate browser Maps key and
asked to continue. The user subsequently authorized a commit only after
deployment and successful production post-checks. That condition is now met.
No reset, ad hoc operational data repair, order completion, or NetSuite posting
was performed as a release check. Normal application startup maintenance is
recorded separately below.

The existing evidence-first specifications for Maps usage controls and Driver
route-prefix protection apply. Deployment validation uses Tier 3 checks because
the release affects API spend, credentials, concurrent Dispatch writes, and
Driver execution. Browser-harness corrections retain the existing behavioral
assertions and do not alter production runtime code.

## Frozen runtime

- Image: `mbbs-operator-app:whole-worktree-20260911-v1`
- Image ID: `sha256:4fd9e6ed01ef41b741e40bb0a988f804ace8ad3637d772fb6bb8ce670d727fee`
- Node: `v20.20.2`
- All 874 deployable runtime files match the current worktree byte-for-byte.
- Runtime manifest SHA-256:
  `cac3fbe1aa02bf806b6edec0fe23f4355eebe5d433889167543843af412afebd`
- Verifier and release/rollback Compose definitions are retained in
  `docker/backups/whole-worktree-20260911/`.

Both the app and webhook worker now use this same image. Before this release,
the app used `scm-search-vendor-20260910-v1` and the worker used
`dispatch-recon-pending-20260908-v1`.

## Existing final runtime verification

The complete isolated MBT run after the last production-source edit passed
455 files and 2,258 tests. The full legacy baseline passed all 134 harnesses.
Maps usage-control focused tests passed 31/31, and eight usage-control mutants
were killed. Driver route-prefix tests previously passed 22/22 and killed
12 mutants. Detailed coverage, known pre-existing lint/type diagnostics, and
the completed-stop photo-race repair are recorded in the feature evidence
reports; this release does not claim a clean whole-repository type/lint baseline.

## Browser-harness repairs

1. The active-CO pickup incident replay invoked Chromium-only JavaScript
   coverage on WebKit. Coverage collection is now Chromium-only; all engines
   still check physical stop order, route/timing previews, and zero writes.
2. That replay exercises the fixed-width desktop planning board. It now uses
   a 1440px viewport on every engine instead of attempting a desktop-board
   load-title click behind the phone viewport's clipped panels. This is not a
   claim that the planning board has gained a phone-responsive layout.
3. The subsequent full matrix passed 500/501. The remaining WebKit BIN case
   failed before entering Edit Mode, not while assigning a BIN. Its trace
   contains no acquire-lease POST. The mobile helper used keyboard `press`,
   which does not wait for an enabled button, while the initial shell disables
   editing until the authoritative snapshot loads. An explicit enabled-state
   assertion now precedes activation; no assignment assertion was removed.
   The formerly failing case then passed five consecutive WebKit repetitions.

The final complete profiles run with one worker each against three separate,
freshly migrated test databases and separate artifact directories, avoiding
cross-profile database or report-file interference. There were no automatic
retries or skipped cases. All 501 configured browser cases are now verified:
498 passed in those profile runs, while the same replay case in each of the
three profiles initially failed in `beforeAll` because the separate artifact
directory lacked `dispatch-soa07894-event-replay.json`. The exact existing
input was restored and that case passed on all three browser engines. A result
aggregator requires matching case IDs and accepts replacements only for this
specific missing-input setup error. This is combined evidence, not a claim of
one uninterrupted 501-pass run.

The final Chromium desktop/mobile profiles contain 166 cases each, and WebKit
contains 169. The BIN readiness cases all passed in these final profiles.
The combined result is retained as
`docker/backups/whole-worktree-20260911/browser-verification-summary.json`.
Fresh focused reruns also passed all 31 Maps tests and all 22 Driver-prefix
tests, including the Mike BL42349 replay. Driver-prefix pure logic coverage
was 100% statements/functions/lines and 91.13% branches in this rerun.

## Maps deployment configuration

The user-supplied `GOOGLE_MAPS_BROWSER_API_KEY` is present in the production
`docker/env/.env`, has valid key syntax, and differs from the server key.
No credential value was printed or copied into source control.

The initial deployment note proposed `conserve`, but that mode disables all
automatic map canvases even when a browser key exists. To retain embedded maps
as requested, the release override uses budget-controlled `normal` mode.
This operational adjustment was announced before cutover. The 4,500-unit
rolling hard limit, 300 automatic map-load allowance, and the removal of
background route/ETA calls remain in force. Eleven normal-mode policy/property
and frontend-contract tests were rerun successfully.

The read-only production replay from the frozen image again validated
1,401/1,401 previews over 2026-09-04 through 2026-09-11, with 1,401 stable
fingerprints and all 45 malformed historical estimates replaced by valid
fallbacks. Its 99 calls / projected 425 per 30 days describe the conserve-mode
reconstruction with zero automatic maps, not the complete normal-mode bill.
Normal mode adds separately metered browser map loads, subject to its 300-unit
automatic allowance and the shared hard limit. Historical browser sessions
were only a lower bound, so a precise historical normal-mode map bill cannot
be reconstructed. The new ledger starts at deployment and does not import
the previous month's Google Cloud bill.

## Backup and rollback preparation

- Private PostgreSQL custom-format backup: 278,232,629 bytes.
- Backup SHA-256:
  `fd790c9841c347de281287dc4b141593e7b066b7cfae0a1cad85a54163ce91ea`
- `pg_restore --list` succeeded (3,114 table-of-contents output lines).
- Both old images have dedicated rollback tags.
- The private rollback environment preserves other settings but disables paid
  Google Maps calls, so reverting to an old image cannot restore uncapped usage.
  Loading that configuration in the preserved old app image was verified.
- Read-only preflight found migration 198 as the only pending migration and
  no queued/running webhook jobs.

Migration 198 adds only the Maps usage ledger and its indexes. Its deployment
runner uses one database client, one transaction, a five-second lock timeout,
and a 30-second statement timeout, verifies the exact pending inventory and
indexes, and rolls back on error. Production database and Ollama containers
are not recreated by the app/worker cutover.

## Live credential gate — 2026-09-11 04:29 UTC

Migration 198 committed successfully, with all three expected indexes and no
remaining migrations. This is an additive usage ledger; existing business
records were not repaired or changed. The original production app and database
remain healthy, the original worker remains running, and the webhook queue has
no queued/running work (4,125 succeeded and 29 superseded).

Actual Google checks, counted in the new usage ledger:

- Browser Maps: passed twice at `https://test.mbbsoperation.com`, including
  the retry requested after the user changed website restrictions.
- Server Geocoding: passed independently.
- Server Routes: failed twice with HTTP 403, `PERMISSION_DENIED`, and
  `API_KEY_SERVICE_BLOCKED`; the second failure was after that restriction
  change. The gateway returned its valid fallback, but fallback is not accepted
  as successful credential verification for deployment.

The effective server credential still comes from `GOOGLE_MAPS_API_KEY`, and
the browser credential is distinct. Inspection of the currently running app
found legacy Directions API references in `order-dependency-repository.js` and
`mbt/frontdesk-pricing-adapter.js`, with no Routes API endpoint reference. The
new release uses `https://routes.googleapis.com/directions/v2:computeRoutes`.
An unchanged key permitted for the old service is not automatically permitted
for this different API. Routes API must be enabled in the same Google project
and allowed under the existing server key's API restrictions, retaining the
other required APIs. Removing browser website restrictions does not fix this
server-side service restriction; the browser key already passed at the site's
allowed origin.

At this checkpoint, cutover, production post-checks, and the conditional commit
remained pending. The evidence-first real-execution gate was not bypassed.
No API key values or credential-bearing request URLs were printed or committed.

## Permission resolution and production cutover

The user added Routes API to the original server key's allowed APIs. The first
immediate retry was still blocked; a spaced retry succeeded at approximately
04:33 UTC, returning `google_routes_v2` with no fallback. The same verification
also passed Geocoding. No application-source change or key replacement was
needed to resolve the permission error.

The authorized cutover recreated only `app` and `webhook-worker`, using the
prepared Compose override and `--no-deps --no-build --force-recreate`. Both
containers started at 04:34:44 UTC with the exact image ID recorded above.
The PostgreSQL container retained its 2026-08-14 startup timestamp and was not
restarted. Both new application containers had zero restarts during post-checks.

A 200ms-interval health observer collected 662 samples across the cutover:

- First unavailable sample: `2026-09-11T04:34:44.161Z`.
- First recovered sample: `2026-09-11T04:34:48.609Z`.
- Observed unavailability: 4.45 seconds; sample-bounded gap: 4.65 seconds.
- 22 unsuccessful samples; healthy for the remainder of the observation.

Normal startup maintenance reported seven global Dispatch order definitions
with repaired CO pickup metadata. Assignment projection startup reported
`ready=true`, `projected=0`, and `remaining=0`. No manual order repair, driver
completion, photo upload, or NetSuite posting was used as a smoke test.

## Production post-checks and commit boundary

Public-origin checks, independent direct-app checks, and a later repeat after
the stability observation all passed:

- `/health` is successful; the app remains healthy and the worker running.
- Eight served asset hashes exactly match the frozen release, including
  Dispatch, Monitor, Driver, service worker, completed-photo review, Control,
  and SCM Schedule assets.
- Driver, Dispatch Planning, Offline Review, and Admin Maps Usage pages load.
- Dispatch configuration and Maps usage APIs reject unauthenticated requests.
- Browser/server keys are distinct; the server key is not exposed in the
  unauthenticated configuration response.
- Driver-oriented planning is enabled; Dispatch catalog and assignments are
  ready, not warming up.
- Maps mode is `normal`, hard limit is 4,500, and the daily series has 30 days.
- No pending migrations or queued/running webhook work were found after
  deployment (4,125 succeeded and 29 superseded).

The initial ledger contains eight metered verification units: three rejected
Routes calls before permissions propagated, one successful Routes call, two
successful Geocoding calls, and two successful browser map loads. The three
failed calls in the new dashboard are this recorded pre-cutover verification,
not failures after successful permission activation.

### Printer-log warning investigated, not suppressed

The broad startup-log screen flagged repeated printer-agent HTTP 401 errors.
Further checks found that the complete printer repository and request-token
helpers are byte-identical to the previous app image. All four printer
authorization configurations match the pre-deployment database backup, and
all four configured printers authenticated successfully after cutover and
remain online. A read-only transaction verified these facts without printing
tokens or token hashes, resetting credentials, or making lease requests.

The final log classification retained 62 exact invalid-printer-credential
rejections and found zero other application failure messages in the captured
window. The identity of the rejected polling client is not established, and
its requests were not proved to predate this release. This remains an explicit
operational warning, not a claim of empty error logs or a printer-auth bypass.

The user-authorized commit is made only after these post-checks. The candidate
source/test set contains 223 files. The changed-line/new-file secret scan and
an exact check for both configured Maps keys found zero findings. Environment
secrets, the database backup, private logs, and generated browser artifacts
are excluded. The runtime tree hash identifies the source deployed; the
release commit contains this report and the existing reproducible feature
gauntlets. Live deployment evidence additionally requires private production
configuration and retained audit artifacts under the ignored backup directory.

Google Cloud billing alerts, project quotas, and application restrictions were
not inspected through an administrative Cloud account. Successful API calls
verify service access, not those Cloud settings. The application ledger is not
an import of prior Google billing usage or a guarantee about other API clients.

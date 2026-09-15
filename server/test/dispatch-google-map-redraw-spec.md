# Dispatch Google map refresh and pin repair

Status: implementation specification; no new deployment or commit is authorized
by this document. The user reported refresh not redrawing, requested the button
on the right of the Maps Preview section title, and supplied CE94489 Load 1 as
the incorrect-pickup-pin example.

Spec approval: detailed executable spec not separately approved (autonomous
regression repair). The requested behavior and layout are explicit user input.

## Failure model and acceptance criteria

- GMAP-01: one admitted Routes request returns the existing timing plus bounded
  overview road geometry and ordered stop coordinates. No separate Directions,
  Geocoding, traffic-on-polyline, optimization, or extra paid request is added.
- GMAP-02: Refresh redraws the road path and markers even if stop identity and
  travel times are unchanged. Preserve the existing map canvas and Google Map
  instance; redraw does not reserve another billable map load.
- GMAP-03: the first pin uses the first leg's start location; following pins use
  each corresponding leg's end location. Keep pickup/drop labels, ordering,
  duplicate-stop semantics, and logical order identities intact. CE94489's
  distinct vendor addresses must not all use schematic/default coordinates.
- GMAP-04: retained estimates preserve validated geometry through the existing
  bounded route cache and plan serialization. A changed route, date, or load
  must not acquire stale geometry from an outstanding response.
- GMAP-05: missing, oversized, nonnumeric, out-of-range, or mismatched geometry
  is not rendered as a valid Google route. Preserve valid timing, clearly label
  the local approximate map, and do not issue an automatic paid retry.
- GMAP-06: exactly one Refresh Google estimate button appears in the Maps
  Preview `.preview-section-title`, right-aligned beside its title, including
  a narrow preview. The old below-map button is removed.
- GMAP-07: refresh and rendering do not save/confirm/edit the operational plan,
  reorder stops, change driver state, or reset the view while a request is busy.
- GMAP-08 (additional user request): remove the duplicate schematic
  `map-preview load-map-preview fallback-map-preview` below the Google map.
  Keep the main map and explicit unavailable/approximate geometry messaging.
- GMAP-09 (additional user request): replay the 2026-09-11 plan in Driver PWA
  with Playwright. Verify pickup and drop-off completion, required photo
  evidence, correct next-job progression, and retained progress after reload.
  Use an isolated database and test photos only; never complete production
  jobs. Report which drivers/loads were replayed and any external boundaries
  not exercised, rather than claiming all live devices are verified.

## Verification and setup

Use existing Node tests, fast-check, c8, ESLint, and Playwright in isolated Docker
test services. No dependency, migration, Google API, or key is added. Write
behavioral RED tests before production edits. Exercise real application/browser
code with only Google/network boundaries substituted. Include property tests
for coordinate order/range, async stale-response cases, cache round trips,
budget denial, map-instance/admission counts, and three browser engines.

Run the Maps usage gauntlet, relevant Dispatch map/timing/performance regressions,
focused coverage, strict lint, manual mutation with restored source checks, and
secret/whitespace checks. Keep incident inspection read-only and private; do not
complete or alter real jobs to test a map. Retain commands and precise results
in a separate evidence report, including unverified limits.

## Deployment authorization update — 2026-09-11

The user subsequently requested "deploy first" while the final repository-wide
regression rerun was still running. This supersedes the no-deployment status at
the start of this specification. Perform a short app/worker cutover with exact
image/source verification, a fresh private backup, rollback images retained,
and read-only live post-checks. Continue the remaining tests in parallel and
report their actual results. This authorization does not permit completing
live Driver jobs or making test NetSuite postings. No new commit was requested.

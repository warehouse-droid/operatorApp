# Actual arrival diagnosis — 2026-09-20

Dispatch's repeated first-pickup departure and next-order arrival times are reproducible across plans. The dominant failure is a missing connection between stored Driver location verification and the background arrival worker. The forecast then substitutes the next job's start time for its unresolved arrival.

This investigation made no production writes and no runtime source changes. It covers automatic runs for September 13–19, 2026, with a read-only reconstruction of the deployed forecast for representative plans. All times below are America/Toronto.

| Plan date | Plan | Driver | Next order | Pickup departure | Displayed next arrival | Arrival source |
| --- | --- | --- | --- | --- | --- | --- |
| September 14 | 324 | Dao | SOA08493 | 06:46:48 | 06:46:48 | PWA job start |
| September 14 | 324 | Li | SOA08594 / SOA08595 | 06:56:56 | 06:56:57 | PWA job start |
| September 15 | 327 | Dao | SOA08668 / SOA08669 | 07:20:14 | 07:20:14 | PWA job start |
| September 18 | 330 | Dao | SOA08792 / SOA08793 | 06:59:44 | 06:59:58 | PWA job start |
| September 18 | 330 | Li | SOB120596 / SOB120594 | 06:38:43 | 06:38:57 | PWA job start |

There were 250 automatic calculation runs with retained physical-visit results in this period: 64 GPS/history-resolved arrivals, 13 same-site arrivals, 27 intentionally unchanged first stops, and 146 unresolved results. Of those unresolved results, 124 reported `destination_coordinates_unavailable`, 18 reported `no_sustained_destination_cluster`, and four reported `no_gps_points`. The missing-coordinate group includes one failed run and 123 runs requiring review. A join by job ID and driver found stored expected latitude/longitude in the separate verification table for 123 of the 124 coordinate failures. This establishes available coordinate evidence; it does not establish that all 123 visits have enough GPS history to resolve an arrival.

Of 26 retained first-to-second physical-stop legs, 22 failed for missing destination coordinates. All 22 next jobs started within 60 seconds of previous-stop completion. Their fallback arrival therefore creates an implausibly short travel duration, commonly identical at minute precision.

The worker reads expected coordinates only from `driver_job_records.location_details`, coordinates on saved plan stops, and configured own yards. It does not read `driver_location_verifications.details`. See [coordinate lookup](../src/dispatch-actual-arrival-service.js#L140) and [early rejection before GPS retrieval](../src/dispatch-actual-arrival-service.js#L361). The service deliberately avoids background Google geocoding. On September 19, all completed pickup/dropoff job records had empty location details and their saved plan stops lacked coordinate fields. Location-check records nevertheless had expected coordinates for all nine visits rejected for that reason. The own-yard configuration has coordinates for 3445, 2967, and 12441, but not 150 or 195; this helps explain why yard visits resolve more often than deliveries or 150-yard visits.

The online photos-completion endpoint calculates or retrieves location verification but does not pass it to `completeDriverJobOperationalEffects`: [completion path](../src/server.js#L20965). The offline path carries a verification ID and source, but not the expected coordinates: [offline trace](../src/driver-offline-service.js#L361). The worker does not follow that reference either. The automatic retry at 23:00 Toronto reads the same fields; retrying cannot repair this handoff. Its run-level message also incorrectly generalizes missing destination coordinates as a failure to obtain a qualifying Samsara cluster.

The forecast [falls back to `started_at`](../src/dispatch-forecast-service.js#L111) when canonical `actual_arrival_at` is absent. The [preceding travel interval](../src/dispatch-forecast-service.js#L506) then uses that value as its end. The first stop keeping its PWA start is intentional; treating the next job's immediately started timestamp as an observed arrival is the misleading fallback.

For a different failure, Li's September 19 TOB01111/TOB01114 drop at 2967 had coordinates and reached Samsara, but retained only three history points with no qualifying cluster. Correctly exposing stored coordinates will not by itself solve genuinely missing or sparse GPS evidence.

Verification: 13 existing arrival policy, service, and frontend contract tests passed in a container without network access. A separate disposable PostgreSQL container ran the real repository, worker, apply function, and forecast against synthetic fixtures and mocked Samsara HTTP responses. It reproduced the missing-coordinate rejection despite a populated verification record and the resulting zero-duration travel. Changing only the disposable fixture so the same coordinates were visible to the worker allowed GPS reconstruction and apply; both stop arrival and preceding travel end then used the reconstructed time. PWA start, completion, and photo evidence remained unchanged. Empty mocked GPS history remained a separate unresolved case. The synthetic reconstructed time is not a corrected production arrival.

The isolated reproduction and its machine-readable output are at `server/test-artifacts/actual-arrival-diagnosis/reproduce.mjs` and `isolated-result.json`. Reproduce with:

```sh
bash server/tools/executed-order-review-test.sh node test-artifacts/actual-arrival-diagnosis/reproduce.mjs
```

The deployed and workspace arrival policy/service/repository SHA-256 hashes matched during diagnosis:

```text
policy     6da868f06aae767b1d98f6458c899949ce802affcac6d5404808783424844789
service    41be9f85d86d452261ec0aadcd610d1829e2bad02be33b102c627666be7dba9e
repository 92ddc3830e2e5074a02ea66297ada957a203f73bd38b0b1e6fb56dfbe53aa880
```

The repair should preserve expected destination coordinates through completion and let reconstruction read existing server-created verification evidence matched to the driver, job, and recorded destination. It should distinguish unavailable GPS arrival from job start in the displayed timeline, make failure reasons specific, and provide historical preview/recalculation for affected routes. Coordinate retrieval must not silently use a changed order address or the truck's current position as the historical destination. Existing driver evidence should remain immutable.

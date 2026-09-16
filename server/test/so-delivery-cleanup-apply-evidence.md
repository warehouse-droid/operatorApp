# SO Delivery and CO cleanup — applied 15 September 2026

**Follow-up at 17:01:52 UTC:** the user identified two grouped COs missed by the
legacy group lookup. The corrected historical-member lookup marked **12 additional
COs Loaded**, including both reported references, bringing the applied CO total to
**63**. All 15 grouped COs reviewed in that follow-up are now Loaded and absent from
the active Operator feed. See the [grouped CO correction report](co-source-group-cleanup-evidence.md).
The counts below document the initial application.

## Outcome

The live app and webhook worker were deployed at **16:31:44 UTC**. The three cleanup
transactions committed between **16:32:52 and 16:33:35 UTC**, after a full isolated
database rehearsal. Independent live verification completed at **16:35:05 UTC**.

| Cleanup path | Qualifying orders | Orders changed | Headers changed | Lines changed |
| --- | ---: | ---: | ---: | ---: |
| NetSuite fulfilled, without local Driver delivery | 1,069 | 1,069 | 1,043 | 1,029 |
| Locally delivered: directly mark Operator Loaded | 525 | 374 | 363 | 887 |
| CO with a verified completed source | 56 | 51 | 51 | 0 |

The other **151 locally delivered SOs** and **5 qualifying COs** were already
consistent. The two SO paths are disjoint. All **1,594 qualifying SOs** now have
Operator status `loaded` and yard status `Loaded`.

- The local-delivery path preserved every captured NetSuite status and fulfillment
  field and added **zero completion events**. All **525** remain blocked from
  Dispatch replanning.
- The NetSuite path accepts directly verified status **F (Pending Billing)** or
  **G (Billed)**. **E (Pending Billing / Partially Fulfilled)** does not qualify.
  It added **313 NetSuite observation events**, without inventing Driver delivery
  evidence or a physical delivery timestamp.
- **984** NetSuite-fulfilled SOs currently qualify for planning. **85** retain
  pre-existing inactive/missing lifecycle restrictions. Cleanup did not reactivate
  those historical orders. Their references and states are in the result audit.
- All **56 qualifying COs** return `Loaded` through the real Operator detail API.
  Stored CO cargo and receiving lines are unchanged. Where the physical load time
  is unknown, the cleanup records an observation and leaves that time unknown.
- **13 review SOs** and **22 COs with unverified or skipped sources** were left
  unchanged, including their stored lines. A grouped CO requires every source
  member to be complete.

## Skipped SOs — unchanged

| References | Reason |
| --- | --- |
| SOB108436, SOB111243 | Packed quantities remain on inactive NetSuite lines |
| SOA04452, SOA04752, SOM04882, SOB114720, SOA05680 | Existing loaded unit differs from the current sales unit |
| SOB114506, SOA05157 | Packed lines have synchronization exceptions |
| SOB116833 | Linked allocation exceeds the order quantity |
| SOM05565 | Duplicate local order reference |
| SOR00107 | Locally cancelled |
| SOM05681 | Active reload or reattempt |

Twelve are excluded from the NetSuite path; SOM05681 is excluded from the direct
local-delivery path. None appeared among the SOs assigned to today's confirmed plan
in the final read-only check.

## Today’s Driver PWA, Operator PWA and Dispatch

Business date: **2026-09-15, America/Toronto**. The final live read captured
confirmed plan **327**, **18 loads**, **5 Driver routes / 63 jobs**, and **24 SO
details** at **16:34:36 UTC**.

**No application blocker was found in the checks performed.**

- In the disposable copy, the real Operator APIs packed and loaded **10 cards**
  covering SOs, grouped SOs and TOs, with **37 packing-line actions**.
- Dispatch saved today's complete plan through the real API with its edit lease:
  **HTTP 200**. The planning browser page rendered without JavaScript or API errors.
- The five Driver routes in the rehearsal snapshot progressed to completion using
  the real login, next-job, start, photo-token, upload and completion endpoints.
  One 30-second request timed out on the first route. The targeted recheck completed
  the remaining route, with no outstanding jobs or errors. This does not establish
  that production requests can never time out.
- Chromium opened the Operator, Driver and Dispatch Planning screens successfully;
  the final browser checks recorded no JavaScript or API errors. An initial test
  used the Dispatch menu URL instead of `/dispatch/planning`; the corrected check
  passed.
- The live active Operator load queue has **13 cards**, with **zero warning or
  underpack counters**. All 24 SO details exist; no displayed lines have blocked
  linked allocations or synchronization exceptions. Nine locally delivered SOs
  on today's plan changed from Open to Loaded.
- `SOR00030` and `SOB119972` return Completed and planning-eligible. Locally delivered
  `SOV02345` returns Completed and planning-restricted. All 525 qualifying local
  deliveries were checked against the authoritative planning policy.
- `SOA08748-S1`, `SOA08748-S2` and `SOA08751` were assigned after the rehearsal
  snapshot. Their current details and routes passed the live read-only checks;
  their exact newly assigned journeys were not replayed in the older copy.

### Practical limits and nonblocking observations

The isolated replay disabled external NetSuite posting, Samsara and offline mode.
Photo storage used a local stub and synthetic photos. Real external posting,
physical cameras, production photo storage, GPS and offline synchronization were
not exercised end to end. Live operational verification was read-only.

Completed `SOA08705` and `SOA08706` retain an `underpack_count` of 1 in their detail
responses. They are Loaded, their displayed required cargo quantities are covered,
and neither appears in the active queue. These counters did not block the tested
workflows and were not corrected by this cleanup.

## Verification and regression evidence

| Check | Result |
| --- | --- |
| Focused cleanup, CO, planning, HTTP and concurrency tests | **65 passed; 0 failed; 0 skipped** |
| SO fault-injection checks | **5/5 rejected by the suite and 5/5 by property tests** |
| CO fault-injection checks | **5/5 rejected by the suite and 5/5 by property tests** |
| Full scoped application regression | **2,372 passed; 2 baseline failures; 1 skipped** |
| Full scoped Dispatch regression | **585 passed; 10 baseline failures** |
| Baseline failure comparison | Exact failing test names unchanged; **zero new failures** |
| Targeted cleanup and CO static lint | Passed |
| New production CO helper coverage | **100% lines, branches and functions** |
| Maintenance core coverage | **95.20% lines, 94.84% branches, 97.61% functions** |
| Live per-phase repeat projection | **Zero remaining changes** |
| Live exact before/after audit | All expected SO rows and lines match; all 13 held SOs unchanged |
| Live CO audit | All expected headers match; all stored CO lines and 22 skipped COs unchanged |
| Runtime verification | Both services running; app healthy; 12 file hashes and served Dispatch assets match |

Tests cover stale or forged manifests, expired proof, local completion races,
Operator advisory-lock conflicts, idempotence, transactional rollback, duplicate
identities, units, linked supply, retired splits, skipped sources and partial group
completion. The source-status property tests reject a misleading full-status label
when the status code is not F/G. Local-delivery integration tests assert that
NetSuite fields and completion evidence remain unchanged.

The cleanup domain and final scope changes had failing behavioral tests before
implementation. The initial CO integration RED run stopped on an incomplete test
fixture; that run is not claimed as a behavioral RED result. The corrected
integration cases and the independent CO property/mutation checks passed. The full
repository's pre-existing type/lint failures are recorded in the earlier planning
evidence; this maintenance work does not claim an entirely green repository or
100% maintenance-tool coverage.

The release tests use a frozen copy of the deployed baseline plus these task tests.
Unrelated concurrent SCM tests and source edits were excluded from this release.
The full Dispatch run predates the final two small scope/property tests; the final
65-test focused run includes both. No production source changed after that run.

## Application controls and recovery artifacts

The fresh live manifests matched the rehearsed entries exactly; CO comparison
excluded only the fresh observation timestamp. No changed, added or removed
candidate entry required a different live mutation.

The apply tools require the explicit reviewed manifest hash and NetSuite proof no
older than 90 minutes. Each transaction acquires Fleet and Operator load locks,
uses NOWAIT table locks, validates fresh source evidence and exact before-images,
writes a field allowlist, and checks the complete result before committing.
Driver records, photos, plan snapshots, Operator posting commands and the SO
fulfillment posting queue matched their before-state during each SO transaction.
The CO transaction also preserved the complete captured SO state. No NetSuite
business records were written.

Deployed image: `mbbs-operator-app:so-delivery-cleanup-20260915-v1`

Image ID: `sha256:95535218857f1615424612c4cde7392e436e1b478642c291cdbc5b85db154e08`

Only 12 production files from the tested release were overlaid on the previously
deployed app image. No schema migration or dependency change was required.

The full pre-cleanup backup was restored successfully for the final rehearsal.
Backup SHA-256: `c3fd4ef4514e59f768a9e8caf9cbf526adb7100cf28f6bdf4b01a0cba80fc77f`.
The backup and exact before-images remain available. The Compose rollback file
restores the prior app/worker images; it does not undo data changes. The cleanup
CLI's `rollback` mode is a transaction rehearsal, not an inverse cleanup.

### Primary artifacts

Relative paths below are from the repository root. Business-data artifacts are
retained locally; no database dump was included in the deployment image.

- `server/test-artifacts/so-delivery-cleanup-apply-20260915/production/`
  - `live/manifest.json`, `local/manifest.json`, `live/co-manifest.json`
  - `live/apply-result.json`, `local/apply-result.json`, `live/co-apply-result.json`
  - `cleanup-final-audit.json`, `result-verification.json`
  - `today-after.json`, `today-verification-summary.json`
  - `rehearsal-comparison.json`, `deployed-*-hashes.json`
- `server/test-artifacts/so-delivery-cleanup-apply-20260915/`
  - `focused-final.log`, `full-app-final.log`, `full-dispatch-final.log`
  - `baseline-regression-comparison.json`, `coverage-final.log`
  - `pwa-replay.json`, `pwa-recheck.json`, `screenshots/`
  - `mutations/results.json`, `co-mutations/results.json`
- `docker/backups/so-delivery-cleanup-20260915/`
  - `pre-cleanup.dump`, `pre-cleanup.sha256`, `release-hashes.json`
  - `deploy.sh`, `apply.sh`, `compose.rollback.yml`
- [Executable specification](so-delivery-cleanup-apply-spec.md)
- [Earlier planning-rule evidence](dispatch-so-fulfilled-planning-evidence.md)

### Applied manifest hashes

| Path | SHA-256 |
| --- | --- |
| NetSuite without local delivery | `4c0da64b49cd5686e1dc2c5ea1566c70937b788be60af23f6b121c9c1ef1c408` |
| Direct local delivery | `1688c1f681e04271c47908189615b7f588c2515cacbd07ba35b2f47fcef2211a` |
| Completed-source CO | `f25350f068eedc30360b56766ff237e5dc98263bffb07c61c49fb237f089563e` |

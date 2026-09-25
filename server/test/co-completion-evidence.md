# CO execution identity correction

Status: fixed and deployed to the app and webhook worker at
**2026-09-18 21:26:33 UTC**. The committed repair corrected **16 transfers**
affecting **36 source sales orders**. GOM-6531-6537 passes the actual planning
guards from yard **2967**, with its CO completed.
The live planner-pool read at **21:27:15 UTC** confirmed that the group is visible,
the catalog is ready, and delivery planning is unrestricted.

Specification: [co-completion-spec.md](co-completion-spec.md).
Spec approval: not obtained (autonomous run). Tier 3, authorized by the request
to fix GOM-6531-6537 and recurring CO completion errors.

## Cause and correction

The driver route builder expanded a physical CO's retained source SO members
into execution references. Completing CO-GOM-6531-6537 at yard 2967 therefore
completed SOM06531 and SOM06537 locally while leaving the CO pending. The earlier
CO lifecycle fix covered records already carrying correct CO references.

The patch keeps a physical CO's identity, while wrappers of individual COs still
expand to their physical CO children. A database guard checks the exact saved
plan/load/stop, local CO, source membership, destination and chronology before
correcting stale references. Audited corrections remain authoritative for late
retries even after the completed stop leaves the current plan.

Original universal completion events remain immutable. A correction ledger
retains the original driver references and details; effective completion readers
exclude only the misassigned driver evidence. Genuine customer and manual
completion remain effective. Completion-service effects use the saved identity,
and corrected evidence cannot be claimed for automatic fulfillment.

## Executable acceptance mapping

| Spec | Evidence |
| --- | --- |
| 1: both grouping paths and ordinary groups | `test/mbt/unit/co-completion.test.js`; 100 generated group cases in `test/mbt/property/co-completion.property.test.js` |
| 2: consolidated CO + TO visit | Production route materialization and physical-visit execution tests; existing consolidated-visit regression suite |
| 3–4: stale database/offline identity and CO kind | Real PostgreSQL insert/update tests, real completion service, wrong yard/stop/member/plan/phase/chronology controls |
| 5: retained history and downstream effects | Original event equality, protected driver fields, immutable audit, canonical completion, historical fulfillment preview, claim and shortage tests |
| 6: planning and genuine completion | Actual planning guards; independent customer and manual delivery controls; live group reader in rollback rehearsal |
| 7: retry, rollback and concurrency | Repeated correction, removed-plan retry, complete rollback, six concurrent retries, and 20 generated retry/permutation cases |
| 8: broader repair | The deployment repair function is exercised by integration tests and by a rolled-back rehearsal on all 16 confirmed live cases |

## Verification results

- Focused packet: **55/55 passed**.
- Exact release candidates: the same **55/55 passed separately for the app
  and webhook worker**, preserving each service's existing changes.
- Changed JavaScript lines: **13/13 executed**, across six production modules.
  SQL is not instrumented by V8 coverage; migration DDL and its behavioral paths
  are exercised against PostgreSQL by the integration, adversarial and retry tests.
- Deliberate faults: **10/10 killed**, followed by a passing restored suite.
  Properties alone kill **6/10**; operational-effect propagation, shortage
  visibility, queued fulfillment claims and wrong-yard rejection rely on the
  dedicated integration tests rather than those generated properties.
- Shuffled suite: **13 files passed**, seed 6531.
- Static checks: **243 pre-existing TypeScript diagnostics, zero new**;
  configured ESLint checks have **zero diagnostics**. Legacy modules without
  ESLint configuration receive syntax and behavioral checks.
- Full-suite baseline: **2,825 tests, 2,805 passed, 19 failed, one skipped**.
  Final run: **2,844 tests, 2,824 passed, the same 19 failures, one skipped**.
  There are **zero new failing tests**. The 19 existing failures remain outside
  this repair's scope; this is not an all-green full-suite result.
- No dependency additions. Dependency hashes match the baseline, and the scoped
  secret scan found no secrets. Final source integrity and whitespace checks
  passed.

Initial regression tests failed **6/7**, with the already-correct CO-wrapper
case retained and later validated by fault injection. Additional RED runs caught
the stale operational-effects path, queued fulfillment claim, late retry after
plan removal, and opaque-stop detection in the repair tool.

Test setup issues were corrected explicitly: unique plan dates, exact existing
append-only rejection wording, and the shortage API's existing hidden-row
contract. No acceptance behavior was weakened.

An unrelated field-sales change entered the shared workspace during testing and
required a dependency absent from the existing test image. Verification therefore
uses the recorded seven-file CO patch over the pre-task snapshot at
`/home/ubuntu/co-completion-verified-20260918/server`. Other workspace changes are
preserved. Each deployment candidate overlays only these seven files onto that
service's captured live image.

## Live rehearsal

The real-data repair rehearsal passed and rolled back:

- **16 transfers**, **36 source SOs**, and **36 gate-disabled fulfillment
  candidates** matched the proven defect.
- No associated candidate had a NetSuite transaction ID. The repair records an
  audited local skip; it does not post or reverse anything in NetSuite.
- Driver photos/timestamps/IDs, original completion events, sales orders, sales
  lines and saved plan snapshots remained unchanged by checksum assertions.
- GOM-6531-6537 was planable from **2967**, with its transfer **completed**.
- After rollback, migration 209 was absent, driver record 4182 again retained its
  original SO references, and the CO remained pending load. No rehearsal changes
  persisted.

The tool rejects unmatched or ambiguous evidence. Historical records without
sufficient saved plan evidence require separate review; the successful audit
found no such case among the detected misassigned transfers.

## Release artifacts

Release directory:
`/home/ubuntu/operatorapp-deploy-backups/co-execution-identity-20260918-v1`.
The per-service manifests record original image IDs, seven-file source hashes,
configuration fingerprints and verified release-image IDs.

- App: `sha256:750f9d646398378dd5a7dcbd626749c70c6f0d54e86ecf6d111745dea6f20cd5`.
- Webhook worker: `sha256:6e56c75876ec990075723b5c1be89125c5a8aefacce9c0fe6fe4441baeb33a95`.

Rollback images and a **296 MiB private PostgreSQL backup** accompany the release.
The backup was validated with `pg_restore` before installing migration 209.
Both deployed images match their verified seven-file source hashes, preserve
their original service configuration, and have zero container restarts. The
database and Ollama containers were not replaced.

The committed repair passed the same protected-field checksum assertions as
the rehearsal. All **36 invalid, gate-disabled fulfillment candidates** received
an audited local skip; no NetSuite transaction was created or reversed. A second,
read-only check confirmed that GOM-6531-6537 is planable from 2967 and its CO is
completed. Both local and public health probes returned **200**; anonymous access
to Delivery Prep remained **401**.

The independent post-deployment database read found **16 correction ledger
entries**, **36 retained original completion events**, and **zero** of those
misassigned events remaining in the effective completion view. The normal
catalog refresh queue was processing the 68 affected references; the group was
already visible and planable through the production pool reader.

Recorded outcomes: `deployment-result.json`, `live-repair.json`, and
`live-verify.json` in the release directory. Test workspace copies and the
final planner-pool check are under `test-artifacts/co-completion/`.

## Reproduction and provenance

Run `bash tools/co-completion-gauntlet.sh` from the frozen verification source.
The entry point runs static checks, focused tests and coverage, fault injection,
shuffled tests, the full suite, baseline comparison, and dependency/secret checks.
Commands and fault definitions are persisted under `tools/co-completion-*` and
`test/support/co-completion-*`. Logs and JSON results are under
`test-artifacts/co-completion/final/`.

Source-manifest SHA-256:
`ee4e7811481f30d1cab22f9f7383bb93d3a78af0a15a57a199635ea901e40856`.

Frozen source archive: `test-artifacts/co-completion/verified-source.tar.gz`.
Archive SHA-256:
`85d01f0ca8f840a1258ef6bfb701b5ba2a1fb1ce3c27d2b8bfb1990059e09257`.

Tools: Node 20.20.2, TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0,
fast-check 4.9.0, pg 8.21.0. Test image:
`sha256:0a5ee3f2197eb21d9959c4cd71d12917e7ce5e7b112c02845681ec9eea7c460c`.
PostgreSQL image:
`sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15`.

No browser asset changes, new public API, or new external-service dependency is
introduced. Browser end-to-end and dependency-audit layers are not rerun for this
backend-only patch; actual service execution, existing HTTP regressions and
post-deploy public health/authentication probes cover the relevant boundaries.

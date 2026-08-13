# Driver PWA offline IndexedDB stress specification

Status: approved executable test/recommendation scope. Production behavior is intentionally unchanged.

## Failure being reproduced

The anonymized historical aggregate contains one 2026-08-05 iOS/WebKit-family failure:

```text
driver_indexeddb_unknownerror
Updating offline storage failed (UnknownError): Error preparing Blob/File data to be stored in object store
```

The current client converts `Blob`/`File` evidence into `ArrayBuffer` before IndexedDB persistence. The regression oracle therefore seeds v1/v2 Blob/File records, opens the current v3 schema, commits the evidence, and inspects the raw object store. No persisted photo may contain a Blob, File, `blob:` URL, missing local bytes before a durable receipt, or mutable replay payload.

## Historical input

`test/fixtures/driver-offline-stress-history.json` is a deterministic aggregate-only clone of 425 manifests observed from 2026-07-30 through 2026-08-11. It preserves route-length, stop/photo-count, photo-state, byte-percentile, common-route-shape, and error-family distributions. It contains no driver, device, customer, address, job, token, upload-object, or photo identifiers.

The critical capacity target is the historical p99 route: 21 stops × 8 required photos = 168 retained photos. Historical photo bytes span 151,795–1,918,533 bytes.

## Exactly 320 named cases

| IDs | Count | Layer |
|---|---:|---|
| DOS-001…DOS-032 | 32 | Historical WebKit/schema regressions |
| DOS-033…DOS-096 | 64 | Runtime-generated 4K capture and 20Hz UI races |
| DOS-097…DOS-192 | 96 | Registration, ticket, upload, and receipt network cut-points |
| DOS-193…DOS-240 | 48 | Quota, route capacity, and cross-cache pressure |
| DOS-241…DOS-280 | 40 | Reload, renderer, two-tab lease, and identity recovery |
| DOS-281…DOS-304 | 24 | PostgreSQL idempotency and durability contracts |
| DOS-305…DOS-320 | 16 | Property, mutation, telemetry, and harness integrity |

The matrix validator fails unless IDs are unique and contiguous, group counts match, 280 cases use real browser IndexedDB, 40 use Node/PostgreSQL, exactly 24 cases form the smoke gate, and browser assignments are exactly 144 mobile WebKit, 88 mobile Chromium, and 48 desktop Chromium. Grep-based project assignment excludes unrelated cases; it does not skip declared cases.

Each browser photo workflow creates eight `File` inputs from a runtime-generated 3840×2160 or 4032×3024 JPEG, PNG, or WebP canvas. Production compression processes the full-resolution corpus, and eight byte-backed evidence records cross the production IndexedDB API. Capture-race cases submit at 20Hz. Network cases run registration, ticket, zero-byte, half-byte, post-upload-commit, receipt, and lost-response cut-points with disconnects and 408/425/429/500/503 responses. The 1-second-connected/10-second-disconnected waveform uses deterministic virtual time while the operator continues local submissions.

## Oracle

A case passes only when all applicable invariants hold:

- exactly one logical event exists for one operator action;
- the sealed event registration payload is byte-for-byte stable on every replay;
- each of eight photo IDs has one owner and no orphan or duplicate ordinal;
- IndexedDB stores `ArrayBuffer`, never Blob/File/object URLs;
- local photo bytes remain until an individual durable server receipt is checkpointed;
- a lost response after server commit converges without duplicate application;
- reconnect drains all retained events/photos, including the 1s/10s waveform;
- two tabs cannot hold the same sync lease;
- quota rejection is atomic and never deletes retained evidence;
- the p99 route can retain 168 approved new captures;
- pressure mode applies only to new captures and never drops below 1600px, 750KB target, or JPEG quality 0.60;
- optional caches are evicted before immutable evidence.

Synthetic IndexedDB and network faults are explicitly labeled and counted separately from organic browser errors. A detector does not turn an unmet desired behavior into a passing test.

## Determinism and commands

Default seed: `20260812`. Override with `DOS_STRESS_SEED`; select one case with `DOS_STRESS_CASE_ID=DOS-NNN`.

```bash
npm run test:driver-offline-stress:smoke   # exactly 24 PR cases
npm run test:driver-offline-stress:full    # all 320 cases
npm run test:driver-offline-stress:soak    # 8 hours plus 30-minute stable drain
npm run coverage:driver-offline-stress
MBT_MUTATION_EPHEMERAL=1 npm run mutate:driver-offline-stress
npm run gauntlet:driver-offline-stress
```

The soak repeats named smoke cases with changing deterministic seeds; repetitions do not create new case IDs. `DOS_SOAK_HOURS` and `DOS_SOAK_DRAIN_MINUTES` may shorten harness validation, but release evidence requires 8 hours and 30 minutes.

## Production remediation acceptance — approved 2026-08-12

The user authorized the production offline-mode remediation after reviewing the
320-case evidence and ordered a complete 320-case before/after rerun. No new
runtime or development dependency is authorized or required.

The fix is accepted only when these executable behaviors hold:

1. The browser-wide corruption guard retains at least the 168-photo historical
   p99 route plus a documented three-stop (24-photo) margin: 192 photos total.
   The independent 250 MB byte guard remains in force.
2. Admission reserves the remaining required route photos and 10% byte
   headroom. It uses the smaller of the application evidence budget and the
   available browser quota when `navigator.storage.estimate()` is available.
3. A normal new capture targets 2048px and 1 MB. A pressured new capture targets
   1600px and 750 KB and never encodes below JPEG quality 0.60. The policy is
   deterministic and reports whether the route can still be completed.
4. Pressure policy applies only to a newly selected file. A draft already
   attached to an event, its hash, byte size, ordinal, and sealed registration
   payload are never recompressed or changed.
5. Delivery-instruction image cache records in the active, unlocked partition
   are evicted before required evidence is rejected for browser headroom. No
   unsynchronized photo, event, manifest, profile, or other partition is
   deleted.
6. If even pressure capture cannot preserve the route reserve, admission fails
   before persistence with retained count/bytes and remaining-route details.
   The rejected write is atomic: every retained evidence byte remains present.
7. Existing upload durability, replay idempotency, click mutex, and renewable
   lease invariants remain unchanged and all related stress cases stay green.
8. The Driver shell/version cache is advanced atomically so an older cached
   photo policy cannot run with the new database admission policy.
9. The final evidence reruns exactly DOS-001 through DOS-320. The eight organic
   mobile-WebKit legacy Blob cases retain their original oracle and are reported
   separately as pass/fail; they may not be reclassified or waived.

Setup plan: edit the existing Driver browser modules, their focused tests,
version/cache declarations, and evidence documents; use the already-pinned
Docker/Node/Playwright/PostgreSQL toolchain; add no package; make no git commit;
and preserve all unrelated working-tree changes.

CI runs the 24-case gate on relevant pull requests, the complete 320-case matrix daily, and the 8-hour soak plus 30-minute stable drain every Sunday. The continuous soak requires a self-hosted Linux/x64 runner with the dedicated `driver-offline-soak` label because [GitHub-hosted jobs are limited to six hours](https://docs.github.com/en/actions/reference/limits). The soak consumes runner time and browser/CPU resources, not model tokens.

## Platform boundary

The WebKit project emulates iPhone 15/mobile Safari behavior in Playwright. It provides real WebKit and real IndexedDB execution but is not proof for physical iPhone storage pressure, iOS process suspension, CriOS packaging, thermal termination, or device-specific quota. A physical-device pre-release run remains necessary for those risks.

## Legacy WebKit Blob recovery acceptance — approved 2026-08-12

The user authorized a focused, iterative fix for DOS-001, DOS-005, DOS-009,
DOS-013, DOS-017, DOS-021, DOS-025, and DOS-029, followed by rerunning those
same eight cases. The original migration oracle remains unchanged.

The focused change is accepted only when all of these behaviors hold:

1. The legacy setup creates a real schema-v1 IndexedDB record whose value owns a
   `Blob`; substituting ArrayBuffer, mocking IndexedDB, skipping WebKit, or
   reclassifying the organic error is forbidden.
2. WebKit receives writable, test-scoped locations for every backing file it
   needs while the rest of the test container remains read-only. No test path
   may read or modify production browser data.
3. Loading the unmodified production runtime upgrades the legacy record to
   schema v3 without deleting it. The stored result contains ArrayBuffer bytes
   and contains no Blob, File, or object URL.
4. The migrated bytes have the exact original length and SHA-256, and the
   migrated photo can join seven new 4K captures in one sealed eight-photo event.
5. Each of the eight named cases passes independently with no retry, waiver, or
   expected-failure annotation. A failed probe triggers diagnosis and another
   bounded fix before the eight-case rerun.
6. The existing ArrayBuffer-only write boundary, atomic route admission,
   durable-receipt deletion rule, and all focused offline-driver contracts stay
   green.

Failure model: WebKit may be unable to create its external Blob backing file in
the read-only container; a writable path may be configured but ignored; a test
could become falsely green by changing the legacy value type; migration could
drop or alter bytes; writable test state could leak between cases; or a fix
could broaden container write access. The tests must directly detect each of
these outcomes.

Setup plan: use the existing pinned Docker and Playwright 1.62.1/WebKit 26.5
toolchain; add no dependency; first change only isolated test storage paths;
modify production code only if an authentic pre-existing Blob reaches it and
exposes a production defect; create no git commit; and preserve unrelated
working-tree changes.

### No-Blob acceptance revision — approved 2026-08-12

After the writable-backing-store probe still reproduced WebKit's native Blob
`UnknownError`, the user explicitly authorized an error-free method that does
not store Blob values. This revision supersedes item 1 above for the focused
eight IDs; all other integrity requirements remain in force.

1. Each case creates the same deterministic in-memory photo Blob, converts it
   to ArrayBuffer before the schema-v1 `put()`, and proves the raw IndexedDB
   value never contains Blob, File, or an object URL.
2. The case then loads the production schema-v3 runtime, retains the exact byte
   length and SHA-256, combines the historical photo with seven new 4K captures,
   and seals exactly one eight-photo event.
3. The case names and metrics must say `ArrayBuffer-only`; they must not claim
   that WebKit's native legacy-Blob persistence or recovery was repaired.
4. The prior native-Blob run artifacts remain immutable evidence of the browser
   limitation. They are not deleted, overwritten, waived, or relabeled.
5. A static anti-regression contract must fail if the eight WebKit cases ever
   return to `{ blob: ... }` persistence or stop asserting the raw binary-only
   record shape.

## Atomic Driver PWA release acceptance — approved 2026-08-12

The user authorized fixing the release-shell mismatch, rerunning the shell and
photo-integrity gates plus all 320 named cases, and then executing the real
8-hour fault-cycling soak followed by a 30-minute stable drain. No deployment
is authorized by this acceptance section.

The release generation is accepted only when all of these behaviors hold:

1. The server gate, page runtime, background sync runtime, and service worker
   all advertise `2026.08.12.3`; the minimum supported interactive client is
   the same version. Older workers retain access only to the existing evidence
   drain endpoints.
2. The Driver cache advances from v26 to v27. The page and service-worker shell
   use the single asset token `20260812-driver-pwa-v3` for Driver CSS, i18n CSS
   and JavaScript, offline DB/hash/photo/sync modules, bin UI, and `driver.js`.
   The service-worker registration itself is also versioned with that token.
3. Existing release assertions must reject any mixed asset token, stale cache
   generation, or disagreement among client/server versions. Updating an
   assertion to permit a mixed generation is forbidden.
4. Full-run evidence identifies the deployable shell, service worker, and
   server version gate in its source digest; a green 320 result cannot be
   attributed to a digest that omits those files.
5. The version gate, offline-client shell, photo-integrity, recovery-assets,
   and ordinary-camera contracts pass before the complete DOS-001…DOS-320 run.
   The complete run must execute 320 unique contiguous IDs with no retry,
   failure, missing result, flaky result, or organic IndexedDB error.
6. The soak must use the default `DOS_SOAK_HOURS=8` and
   `DOS_SOAK_DRAIN_MINUTES=30`, complete at least one fault-cycling and one
   stable-drain cycle, retain immutable per-cycle evidence, and fail on any
   nonzero cycle exit or shortened wall-clock duration.
   A stable-drain child must receive an explicit phase/profile, select only
   drain-capable browser/network and server durability cases, remain
   continuously online, inject no network or IndexedDB fault, observe no first
   sync failure, and record that effective profile in each case artifact. A
   controller that changes only the phase label is invalid release evidence.
   A runner ceiling may split execution only at a completed-cycle boundary via
   an atomic, source-digest-bound checkpoint. Segment rollover cannot reduce the
   targets: evidence must accumulate at least eight hours of successful active
   fault-cycle duration plus 30 minutes of successful active stable-drain
   duration. A source change, interrupted/pending cycle, failed cycle, changed
   duration, or changed run ID invalidates resume and requires a new soak.
   Release segments run as the normal Compose service defined by
   `test/driver-offline-soak.compose.yml`; a leased one-off container is not
   release evidence because its termination can interrupt an active cycle.
   The checkpoint and Compose service must also bind both the runtime and E2E
   services to immutable `repository@sha256` image references. A moved default
   tag or changed image reference invalidates resume.
7. All work uses a dedicated isolated Compose project. Production containers,
   data, and deployment state remain untouched, and isolated resources are
   enumerated before removal.

Failure model: a new `driver.js` can be cached beside old offline modules; the
page, worker, and server can disagree about the minimum version; a stable cache
name can retain mixed shell entries; test evidence can omit the actual worker
or HTML; the long soak can stop early or omit the stable drain; or cleanup can
target production. The release assertions, source digest, full matrix, soak
summary, and label-scoped cleanup must directly detect these outcomes.

Setup plan: use only the pinned Docker/Node/Playwright/PostgreSQL toolchain;
add no dependency; make no git commit; edit only the Driver generation values,
their existing release assertions, stress source-state inventory, and evidence
documents; preserve unrelated worktree changes; and do not deploy.

## Scoped iPhone Driver cache repair acceptance — approved 2026-08-12

The user authorized an in-app recovery control for iPhone/Safari installations
that remain on a stale Driver PWA generation. The control repairs only the
MBBS Driver application shell; it is not a substitute for Safari's browser-wide
Clear History and Website Data operation, and it must never clear offline work.

The repair is accepted only when all of these behaviors hold:

1. The action is available from both the normal Driver status panel and the
   required-update screen, including online-only mode. It plainly says that
   saved routes, photos, pending submissions, login state, and other MBBS app
   data are preserved.
2. Repair is online-only and refuses to start during a rest, photo interaction,
   foreground mutation, synchronization, or saved-route replacement. A single
   in-document latch and a single service-worker operation prevent overlapping
   repairs.
3. The service worker first downloads every versioned Driver shell asset with
   `cache: "reload"` into a staging cache. It verifies the complete staged shell
   before changing the active cache. A staging/network failure leaves the
   previous active shell and all non-Driver caches unchanged.
4. After successful staging, the worker refreshes the active shell, removes
   unexpected entries, preserves the offline-mode sentinel, and deletes only
   cache names beginning with `mbbs-driver-shell-`. It never unregisters the
   service worker and never invokes an IndexedDB/database deletion, broad
   CacheStorage deletion, `localStorage.clear()`, or `sessionStorage.clear()`.
5. The page waits for an acknowledged `DRIVER_REPAIR_SHELL` result from the
   current worker. Only a successful result for the current PWA version may
   trigger a cache-busting `/driver` navigation. Timeout, stale-worker, and
   network failures retain the current page and show a retryable error.
6. The Driver release advances atomically to client/server version
   `2026.08.12.3`, cache generation v27, and asset token
   `20260812-driver-pwa-v3`. Existing version, shell, photo-integrity, focused
   WebKit, and all 320 stress cases must remain green after the change.
7. An executable CacheStorage harness must prove successful scoped replacement,
   preservation of the operator cache and offline-mode sentinel, and rollback
   behavior when staging fails. Real WebKit coverage remains part of the full
   matrix; a physical iPhone pre-release check is still required for standalone
   PWA lifecycle behavior that browser emulation cannot prove.

Setup plan: add no dependency; modify only the Driver shell/page styles and
translations, version declarations, focused contracts, source-state inventory,
and evidence documents; preserve unrelated worktree changes; make no git
commit; and do not deploy.

## Toronto timestamp display cache refresh — 2026-08-13

The shared UI timestamp formatter must derive both the calendar date and clock
time from `America/Toronto`. The production regression value
`2026-08-13T02:16:00.195Z` must render as `12-Aug 10:16 PM`, while the literal
business date `2026-08-13` must remain `13-Aug`.

This display-only correction keeps the Driver client/server version and asset
token at `2026.08.12.3` / `20260812-driver-pwa-v3`, but advances the scoped
Driver shell cache from v27 to v28. Initial v28 shell installation must fetch
every shell asset with `cache: "reload"`, preserve IndexedDB and the offline-mode
sentinel, and delete only older `mbbs-driver-shell-` caches. The v27 soak evidence
remains historical; v28 requires a new complete stress run before deployment.

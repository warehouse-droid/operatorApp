# SCM Dependency Manager — Verification Evidence

Date: 2026-08-19 UTC

Status: the original feature was deployed on 2026-08-20 UTC. The 2026-08-25
started-job readiness correction is implemented locally and is not yet deployed.

## Outcome

- SCM writers can search the latest global normal/group/split order identities and preview/apply Link TO, Link PO, unlink, and direct-ship changes from `/scm/dependency-management`.
- A target may have multiple distinct TO dependencies. Re-linking the same TO to the same logical target extends it; moving that TO to another target remains blocked.
- Dispatch and SCM use the same atomic command, blocker, target-signature, plan-revision, and plan-digest path.
- Relationship, plan snapshot, Operator materialization, action receipt, and old-manifest supersession commit together or roll back together.
- A dependency change unrelated to started Driver work no longer waits for a
  screen-off or suspended Driver PWA. Planned job rows without start/completion
  evidence are explicitly ignored by the activity blocker.
- Started or completed jobs for an affected order remain a hard blocker, while
  activity for an unrelated order remains isolated.
- Optional Web Push and the readiness endpoints remain non-authoritative; neither
  can override the started-job blocker.
- After commit, the old manifest and grant are fenced. Unexpected old events remain review evidence and cannot produce operational effects.

## Executed gates

| Gate | Result |
| --- | --- |
| Focused behavior/database/HTTP/UI suite | 36/36 passed |
| Focused ESLint | Passed with zero warnings |
| Legacy browser syntax | Passed |
| Safety mutation suite | 8/8 mutants killed; source hashes restored |
| Dependency licenses | 396 packages passed; pre-existing `buffers@0.1.1` metadata exception remains documented |
| Changed-source secret scan | 23 paths checked; no high-confidence findings |
| Migration upgrade/idempotency | 1/1 passed through migration 173 |
| Dispatch optimization/regression suite | 52 files, 205 tests passed |
| Driver PWA cache/reset/UX contracts | 36/36 passed |
| Mobile WebKit service-worker cache/reset E2E | 3/3 passed |
| Driver offline stress matrix | 320/320 passed; 0 failed; 0 missing |
| Diff whitespace validation | Passed |

## Historical replay

The anonymized 2026-08-05 through 2026-08-18 replay processed 29,334 cross-system events and compared the projection after every event:

- Dispatch events: 5,661
- SCM events: 13
- NetSuite-derived events: 16,632
- Driver events: 7,028
- Plan transitions: 843
- Projection comparisons: 29,334
- Mismatches: 0
- Causal digest: `31ccef9ea09ad0de3a454b2af6c3cf8bf753097b43bb3ac3d9fdf9184ee27310`

The historical source did not contain `splitPoLink`, `splitPoDirectShip`, or `groupPoLink`. Those three interactions, plus grouped TO and combined relationship cases, are covered by deterministic adversarial tests rather than being silently claimed as historical coverage. The replay artifact is SHA-256 pseudonymized and excludes names, addresses, photos, and raw payloads.

## Driver offline and WebKit evidence

Run: `full-seed-20260812-2026-08-19T214314-888Z`

- 48 desktop Chromium cases passed.
- 88 mobile Chromium cases passed.
- 144 mobile WebKit cases passed.
- Organic IndexedDB errors: 0.
- Deliberately injected IndexedDB/network/quota faults: 100; every passing detector retained immutable evidence and converged later.
- The eight schema-v1 WebKit recovery cases persisted `ArrayBuffer`, not `Blob`, and all passed.
- Covered 4K eight-photo captures, 20 Hz confirm/submit/next-step bursts, offline start, half-upload disconnect, 1-second-connected/10-seconds-disconnected cycling, lost responses, renderer crashes, quota pressure, cache eviction, and multi-tab/device contention.
- Source SHA-256 bound to the run: `4d83b5a025b735e838ad0edb0be30661bdf7c25e62a14f44c356d7cccd90237f`.

This is real Playwright WebKit execution with an iPhone 15 device profile, not a physical-iPhone field test.

## Reproducible commands

```sh
npm run gauntlet:scm-dependency-management
npm run test:dispatch:performance
npm run test:driver-offline-stress:full
node --test --test-concurrency=1 test/mbt/integration/migration-upgrade.test.js
```

The gauntlet intentionally requires `MBT_TEST_ISOLATED=1`; mutation testing additionally requires `MBT_MUTATION_EPHEMERAL=1` and a writable disposable source copy.

## Artifacts

- Specification: `test/scm-dependency-management-spec.md`
- Two-week replay: `test-artifacts/dispatch-planner-replay/two-week-2026-08-05_2026-08-18.json`
- Offline stress evidence: `test-artifacts/driver-offline-stress/runs/full-seed-20260812-2026-08-19T214314-888Z/evidence.md`
- Offline stress per-case results: `test-artifacts/driver-offline-stress/runs/full-seed-20260812-2026-08-19T214314-888Z/cases/`

## Deployment boundary

The user separately authorized production deployment on 2026-08-20 UTC.

- Release image: `mbbs-operator-app-app:latest`, image ID `sha256:725f0cfedeeee3f0c169f57b63f3b879d653a7e6a29c05e99f0d5302918f2bb0`.
- Rollback image: `mbbs-operator-app-app:rollback-pre-scm-deps-20260820T010143Z`, image ID `sha256:25b659c84f63cdae5789299b58821e67d367c9c902fd355377be352cb6ff64af`.
- Backup: `docker/backups/pre-scm-dependency-20260820T010143Z.dump`, SHA-256 `988e33b3c644deabda5c1329fea5f92e35f3b6445d67d4a9becfde55412a244a`.
- Production migrations 171, 172, and 173 applied successfully. The post-migration read-only preflight reported no missing migrations, no Dispatch collisions, and no feature-flag inventory corruption. Its initial-rollout-only `ready` value remained false because seven established MBT production gates were already enabled before this deployment; those gates were intentionally preserved.
- Only the application container was recreated. Docker event and application-listen timestamps bound the interruption to 1.72 seconds; PostgreSQL and Ollama were not restarted.
- The application, PostgreSQL, and Ollama containers were healthy after cutover. The Driver PWA version remained `2026.08.12.3`; offline mode remained disabled at revision 3. Dispatch Driver-oriented planning remained enabled.
- `DISPATCH_PLANNER_ORDER_POOL_MODE` and `DISPATCH_PLANNER_COMMAND_MODE` remained `off`, preserving the legacy planner until a separately authorized shadow/on cutover. The SCM Dependency Manager itself is live and authentication-protected.
- The bounded storage cleanup completed successfully, retained the three newest dumps including the deployment backup, and preserved both release and rollback images. The disposable test project and its exact test image were removed after deployment.

---

## Partial multi-source quantity and CO routing amendment

Date: 2026-08-27 UTC

Status: implemented, verified, and deployed to production on 2026-08-28 UTC.

### Accepted behavior

- A TO allocation remains immutable audit evidence, while its effective route
  contribution is capped per item by the TO's current outbound quantity (or
  receiving quantity when outbound evidence is unavailable).
- A partial TO is valid. It must not raise attention merely because its current
  quantity is below the linked SO allocation; the unserved quantity remains on
  the SO's ordinary outbound route.
- Item budgets are isolated and conserved when one TO contributes to multiple SO
  lines. Replenishment TOs remain timing prerequisites and never add their source
  or transit-CO location to the SO route.
- A direct TO contributes a pickup only while it has positive effective sales
  material. An explicitly zero direct contribution creates neither an empty
  pickup nor a route-validation blocker.
- An active CO for a direct TO redirects that operational pickup to the CO
  destination; cancelling the CO restores the canonical TO source. COs attached
  to replenishment TOs remain operationally invisible to the SO route.
- Missing linked material-line identity, inactive TOs, terminal TOs with work in
  progress, and the existing execution/lifecycle blockers remain real attention
  conditions.

### Test-first evidence

The production assertions were written before the implementation changes:

- The first focused run passed the unchanged controls and failed the mixed
  partial-TO case because the old sync path raised quantity attention.
- The anonymized replay failed only its two reduced-quantity shapes (`D003` and
  `D005`) with the legacy "quantity is below its linked Sales Order allocation"
  behavior.
- The four-TO/one-PO case independently failed when a zero-contribution direct TO
  left its source in the SO route. The implementation was then changed to make
  effective material, rather than the saved allocation, authoritative for route
  contribution.

The executable specification now includes scenarios 19 through 28 in
`test/scm-dependency-management-spec.md`.

### Current-data audit and replay

A read-only production audit examined all 123 dependency records and all 301
saved dependency lines across 108 SO targets; it made no production mutations.

- Nine targets have more than one non-cancelled TO dependency: eight have two
  replenishment TOs and one has two direct TOs. The current maximum is two TOs,
  so the synthetic three- and four-TO cases extend beyond today's data.
- Eleven active/attention dependencies (25 lines across 10 targets) are captured
  in the pseudonymized executable replay fixture. It covers every currently
  planning-relevant dependency shape, including direct, replenishment, partial
  quantity, multiple TOs, and an active direct transit CO.
- The other 112 delivered, received-local, or cancelled records were included in
  the aggregate invariant audit and remain covered by the lifecycle/rollback
  harnesses rather than being represented as active planning cases.
- The audit found no negative saved allocations, missing SO/TO headers,
  zero-line dependencies, or active missing-material identities. It found one
  active quantity-limited dependency and one legacy quantity-only attention row.
  That legacy attention row will clear on its next TO sync only after this
  amendment is deployed.
- Sixty-three active CO records were considered by the overlay audit. One matched
  a direct dependency and one matched a replenishment dependency; both routing
  modes are exercised explicitly.

### Extreme and randomized cases

- Four TOs plus one direct PO: two direct TOs, two replenishment TOs, partial and
  zero current quantities, residual base-yard fulfillment, cancellation, and
  deterministic CO overlays.
- Ten SO lines: three lines direct through `TO0001`, three lines waiting on
  replenishment through `TO0002`, and four lines direct through a PO. Every line
  is owned exactly once and all ten remain on the customer drop.
- A fixed random seed chooses CO overlays for direct and replenishment TOs in both
  extreme cases. Direct CO cancellation restores the canonical pickup;
  replenishment CO creation/cancellation cannot change the SO route.
- Property tests run 500 generated allocation sets per invariant, covering up to
  12 same-item allocations plus independent item budgets, receiving fallback,
  fractional conversions, unknown quantities, and zero/direct routing
  boundaries.

### Executed gates

| Gate | Result |
| --- | --- |
| Focused behavior/database/replay suite | 49/49 passed |
| Quantity module coverage | 100% statements, 98.36% branches, 100% functions, 100% lines |
| Focused mutation suite | 16/16 mutants killed (100%); sources restored and 32/32 baseline tests passed |
| Full SCM dependency gauntlet | Passed |
| Order-dependency rollback harness | Passed |
| Dispatch-link rollback harness | Passed |
| CO lifecycle regression | 27/27 passed in a freshly migrated disposable database |
| PO/residual-route regression | 39/39 passed; internal Driver route harness also passed 96 checks |
| Focused ESLint and legacy syntax | Passed with zero warnings |
| Dependency licenses | 396 packages passed; the pre-existing `buffers@0.1.1` metadata exception remains documented |
| Changed-source secret scan | 29 paths checked; no high-confidence findings |
| Diff whitespace validation | Passed |

All database tests used an isolated PostgreSQL 18 container and the repository's
Node 20 test image. No dependency was added. No browser UI source changed for
this amendment, so route projection, physical-visit, frontend contract, and
Driver/CO lifecycle tests were used instead of claiming a new manual browser or
device run.

### 2026-08-28 deployment boundary

- The release was built as an exact two-file layer on the previously deployed
  CO transit-source image. Unrelated local Dispatch/MBT worktree changes were
  excluded from the build context's `COPY` instructions.
- Release image: `mbbs-operator-app-app:to-dependency-quantity-20260828T005509Z`,
  image ID `sha256:ba047cf6acf6129b5ddd9a3ded5a1ef6e0b7087e8821ef4a88f6cf748176cdc4`.
- Rollback image: `mbbs-operator-app-app:rollback-pre-to-quantity-20260828T005509Z`,
  image ID `sha256:af91cdbe08422eb32b56dd33806f2bdb537271e2fddb2d688cb101495d75351e`.
- Backup: `docker/backups/pre-to-quantity-20260828T005509Z.dump`, 253,857,980
  bytes, SHA-256
  `896409d1dcb00aa35fe7bb9f8859275e159398b278da2348378dad3473e3f16f`.
  PostgreSQL successfully listed the custom-format restore catalog before the
  container-side temporary copy was removed.
- No migration was required. Only the application container was recreated.
  PostgreSQL and Ollama retained their original
  `2026-08-14T13:14:47Z` start times and remained healthy.
- The running source hashes exactly match the tested files:
  `c841bbd3bdaf3a655445bb991bb9afbd04745fd68e2125454ad4323a7324dbb2`
  for `order-dependency-quantity.js` and
  `a5346d0ec7ec4f4d8a4ded60be33cfb7304dfc7e85991edb481c731a0e006efb`
  for `order-dependency-repository.js`.
- The production health endpoint returned
  `{"ok":true,"app":"MBBS Yard Server"}`. Startup logs contained only the
  normal server-listening message.
- A read-only production projection loaded all 11 then-planning dependencies
  across 10 targets before reconciliation, found one quantity-limited line, one
  active transit CO, no replenishment dependency in a direct manifest, and no
  zero-contribution direct pickup.
- The single legacy quantity-only attention dependency had no execution
  progress. Its normal transactional TO sync cleared attention while retaining
  the `quantityLimited` diagnostic. Because that replenishment was already
  complete, the existing lifecycle rule moved it to delivered. The final
  read-only projection had zero legacy quantity-attention rows and zero
  quantity-limited attention rows.

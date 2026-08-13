# Driver PWA offline stress evidence

## Latest full campaign

- Run: `full-seed-20260812-2026-08-13T144152-488Z`
- Seed: `20260812`
- Source SHA-256: `895284f96a81a8d9a5151913cb365f53d2e30df729e06691a79af836166c09b0`
- Requested/executed/passed/failed/missing: **320/320/320/0/0**
- Browser cases: **280/280 passed**; real Node/PostgreSQL cases: **40/40 passed**
- Browser assignment: 144 mobile WebKit, 88 mobile Chromium, 48 desktop Chromium
- Historical input: anonymized deterministic aggregate clone of 425 route manifests from 2026-07-30 through 2026-08-11; p99 was 21 stops, or 168 required photos at eight photos per stop
- iOS scope: mobile WebKit emulation only; physical iPhone/CriOS validation remains required

| Group | Executed | Passed | Failed |
|---|---:|---:|---:|
| Historical/schema | 32 | 32 | 0 |
| 4K capture/click storm | 64 | 64 | 0 |
| Network/upload cut points | 96 | 96 | 0 |
| Quota/cross-cache | 48 | 48 | 0 |
| Lifecycle/concurrency | 40 | 40 | 0 |
| Server idempotency/durability | 24 | 24 | 0 |
| Integrity/property/telemetry | 16 | 16 | 0 |

The complete post-fix campaign improved from 288/320, then 312/320, to **320/320**. All 24 former route-capacity/storage-pressure failures and all eight former mobile-WebKit schema-v1 failures passed. DOS-001, DOS-005, DOS-009, DOS-013, DOS-017, DOS-021, DOS-025, and DOS-029 now persist ArrayBuffer-only historical bytes, verify their deterministic SHA-256 after schema upgrade, and combine them with seven new 4K captures. No retry, waiver, expected failure, or injected IndexedDB fault was used for those eight cases.

The current write boundary converts every Blob/File to ArrayBuffer before IndexedDB. The campaign observed **0 organic IndexedDB errors** while retaining 100 deliberately injected IndexedDB, network, and quota faults as passing recovery detectors. The earlier native-Blob WebKit artifacts remain immutable RED evidence of the browser-engine failure and were not relabeled.

All 96 network cases converged without lost or duplicate events across registration, ticket, zero-byte upload, halfway upload, post-commit, and receipt cut points. These included disconnects, 408, 425, 429, 500, 503, and the virtual 1-second-online/10-seconds-offline waveform while 20 Hz operator click storms continued. All 24 server cases preserved exactly-once application under lost responses after commit.

The full evidence retains all 320 result records, including per-case dimensions, compressed byte counts, click metrics, fault phase, retry/convergence data, and sanitized failures. It is stored at `test-artifacts/driver-offline-stress/runs/full-seed-20260812-2026-08-13T144152-488Z/`.

## Focused no-Blob WebKit rerun

After a writable-backing-store probe reproduced the same native WebKit Blob
`UnknownError`, the user approved the no-Blob acceptance revision in the
executable specification. The eight affected IDs now create the historical
photo in memory, convert it to ArrayBuffer before the schema-v1 IndexedDB
`put()`, load the production schema-v3 runtime, and combine the preserved photo
with seven new 4K captures in one sealed eight-photo event.

The final independent rerun passed **8/8**, with no retry, waiver, expected
failure, or organic browser error. Every raw historical record contained one
131,072-byte ArrayBuffer and contained no Blob, File, or object URL. Its
deterministic SHA-256 was verified again after the schema upgrade. All runs used
source digest
`7686f72d0c1763161b57f5e4e9c34cef784530873158836c370bf68e64c86c96`.

| Case | Immutable run | Historical SHA-256 |
|---|---|---|
| DOS-001 | `full-seed-20260812-2026-08-12T181814-367Z` | `a080168127b29c4c5573ab684e40016a7c9090e2d77c70985bfd87bf67ad01e5` |
| DOS-005 | `full-seed-20260812-2026-08-12T181821-454Z` | `a25ed5ff6afc4a69160761a8501ee320aa43bc0f1d9120e5d7fb0e316cddb543` |
| DOS-009 | `full-seed-20260812-2026-08-12T181828-192Z` | `91c80428b7f49b2972060c7cb2b3c61ddfeb6737062c1033ac518c4d541e54fc` |
| DOS-013 | `full-seed-20260812-2026-08-12T181834-854Z` | `08b600cbfba58681523beba2b35367afaadc3daefba33a99b3381935568d1006` |
| DOS-017 | `full-seed-20260812-2026-08-12T181841-278Z` | `f3f8ad9caa974c965a0f8b08e4e2601a55cb36b3069607c4c87c5e51ab64ec82` |
| DOS-021 | `full-seed-20260812-2026-08-12T181848-019Z` | `8de1109df732fbc0ec8e32a4940a0963ddab7c05eba413920407157496140fdb` |
| DOS-025 | `full-seed-20260812-2026-08-12T181854-747Z` | `c25a5bc71a91df9c8b3f8afc608948b65e070996cd01f644212485227e73d1f3` |
| DOS-029 | `full-seed-20260812-2026-08-12T181901-318Z` | `3a6373f4e2ee72b2f8ca16938443ab5025c8932d3a87c2a34614d70ea2d725e6` |

This focused result is prevention evidence, not proof that native WebKit Blob
persistence or recovery was repaired. The prior native-Blob artifacts remain
immutable and RED. The complete approved ArrayBuffer release-oracle matrix was
subsequently rerun and is the 320/320 campaign recorded above.

## Assurance gates

- Matrix validator: 320 contiguous IDs, 24 smoke cases, 280 browser cases, and 40 PostgreSQL cases
- Focused property/invariant contracts: 15/15 passed, including the deterministic no-Blob fixture guard
- Coverage: 97.61% statements/lines, 84.44% branches, and 97.56% functions; all configured thresholds passed
- Persisted mutation gate: 8/8 mutants killed, source restored, post-mutation contracts green
- Binary/cache contracts: 10/10 passed; scoped lint and legacy syntax checks passed
- Real PostgreSQL verification: 40/40 passed
- Dependency tree, scoped lint, secret scan, shell syntax, source-state, and diff-whitespace gates: passed
- Shortened soak-controller proof: one fault-cycling cycle followed by one explicit stable-drain cycle, exit 0

The actual eight-hour wall-clock soak was not repeated during this implementation session. The weekly self-hosted CI job executes eight hours of cycling plus a 30-minute stable drain. The approved ArrayBuffer release gate is green at 320/320; physical iPhone/CriOS validation remains separate from Playwright mobile-WebKit emulation. The soak process itself consumes runner time and essentially no model tokens.

## Artifact layout

Each immutable run is written beneath `test-artifacts/driver-offline-stress/runs/<run-id>/`:

- `evidence.json` and `evidence.md` — every requested outcome and failure detail;
- `cases/DOS-NNN.json` — sanitized per-case browser, seed, network, and quota metrics;
- `playwright-report.json`, traces, and failure screenshots;
- `commands.json` and `run.json` — exact invocations, versions, timing, and source identity;
- `mutation/mutation-report.json` — eight persisted mutants and source-restoration proof;
- `soak/soak-*.json` — wall-clock cycles and stable-drain proof.

The executable specification is the acceptance oracle. A failed desired-behavior assertion is retained as RED evidence and is never waived or relabeled as a passing injected-fault detector.

# Driver PWA offline stress evidence

## Latest full campaign

- Run: `full-seed-20260812-2026-08-12T173755-266Z`
- Seed: `20260812`
- Source SHA-256: `e8f1ff5c4547260a0b53f2f0ebd9d31f52269f80e1ccb2780a097c4d8bf18e7c`
- Requested/executed/passed/failed/missing: **320/320/312/8/0**
- Browser cases: **272/280 passed**; real Node/PostgreSQL cases: **40/40 passed**
- Browser assignment: 144 mobile WebKit, 88 mobile Chromium, 48 desktop Chromium
- Historical input: anonymized deterministic aggregate clone of 425 route manifests from 2026-07-30 through 2026-08-11; p99 was 21 stops, or 168 required photos at eight photos per stop
- iOS scope: mobile WebKit emulation only; physical iPhone/CriOS validation remains required

| Group | Executed | Passed | Failed |
|---|---:|---:|---:|
| Historical/schema | 32 | 24 | 8 |
| 4K capture/click storm | 64 | 64 | 0 |
| Network/upload cut points | 96 | 96 | 0 |
| Quota/cross-cache | 48 | 48 | 0 |
| Lifecycle/concurrency | 40 | 40 | 0 |
| Server idempotency/durability | 24 | 24 | 0 |
| Integrity/property/telemetry | 16 | 16 | 0 |

The post-fix campaign improved from 288/320 to 312/320. All 24 former route-capacity and storage-pressure failures passed. The only remaining failures are DOS-001, DOS-005, DOS-009, DOS-013, DOS-017, DOS-021, DOS-025, and DOS-029. Each is a mobile-WebKit legacy schema-v1 case that organically reproduces `UnknownError: Error preparing Blob/File data to be stored in object store`, classified as `driver_indexeddb_unknownerror`; no fault was injected.

Those eight failures occur while the test asks WebKit to create the historical schema-v1 Blob record, before the fixed Driver runtime is loaded and can migrate it. They remain RED and are not waived. The current write boundary converts every Blob/File to ArrayBuffer before IndexedDB, and its binary persistence, migration, atomic admission, durable-receipt, and cache-isolation contracts all pass. Application code cannot recover bytes that the browser engine refuses to expose to an IndexedDB transaction.

All 96 network cases converged without lost or duplicate events across registration, ticket, zero-byte upload, halfway upload, post-commit, and receipt cut points. These included disconnects, 408, 425, 429, 500, 503, and the virtual 1-second-online/10-seconds-offline waveform while 20 Hz operator click storms continued. All 24 server cases preserved exactly-once application under lost responses after commit.

The full evidence retains all 320 result records, including per-case dimensions, compressed byte counts, click metrics, fault phase, retry/convergence data, and sanitized failures. It is stored at `test-artifacts/driver-offline-stress/runs/full-seed-20260812-2026-08-12T173755-266Z/`.

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
immutable and RED. The latest complete 320-case campaign also remains the
312/320 run above; the full matrix has not been rerun after the approved oracle
revision.

## Assurance gates

- Matrix validator: 320 contiguous IDs, 24 smoke cases, 280 browser cases, and 40 PostgreSQL cases
- Focused property/invariant contracts: 11/11 passed, including the deterministic no-Blob fixture guard; the latest full campaign ran the earlier 10/10 contract set
- Coverage: 97.28% statements/lines, 84.56% branches, and 97.14% functions; all configured thresholds passed
- Persisted mutation gate: 8/8 mutants killed, source restored, post-mutation contracts green
- Binary/cache contracts: 10/10 passed; scoped lint and legacy syntax checks passed
- Real PostgreSQL verification: 40/40 passed
- Dependency tree, scoped lint, secret scan, shell syntax, source-state, and diff-whitespace gates: passed
- Shortened soak-controller proof: one fault-cycling cycle followed by one explicit stable-drain cycle, exit 0

The actual eight-hour wall-clock soak was not spent during this implementation session. The weekly self-hosted CI job executes eight hours of cycling plus a 30-minute stable drain. The focused no-Blob gate is green, but the latest complete 320-case release gate remains RED under its original native-Blob oracle until the complete matrix is rerun under an explicitly approved release oracle. The soak process itself consumes runner time and essentially no model tokens.

## Artifact layout

Each immutable run is written beneath `test-artifacts/driver-offline-stress/runs/<run-id>/`:

- `evidence.json` and `evidence.md` — every requested outcome and failure detail;
- `cases/DOS-NNN.json` — sanitized per-case browser, seed, network, and quota metrics;
- `playwright-report.json`, traces, and failure screenshots;
- `commands.json` and `run.json` — exact invocations, versions, timing, and source identity;
- `mutation/mutation-report.json` — eight persisted mutants and source-restoration proof;
- `soak/soak-*.json` — wall-clock cycles and stable-drain proof.

The executable specification is the acceptance oracle. A failed desired-behavior assertion is retained as RED evidence and is never waived or relabeled as a passing injected-fault detector.

# Delivery Instruction Evidence Report

Verified on 2026-08-11 with `tools/delivery-instruction-gauntlet.sh` in an isolated Docker Compose project and a fresh PostgreSQL database.

## Executable evidence

- Workflow suite: 33/33 tests pass across domain, property, repository, HTTP authorization/range streaming, Driver identity, offline cache, sync, upload policy, and UI contracts.
- Neighboring regressions: Driver offline/client-version/photo integrity, consolidated physical visits, Dispatch stop visits/performance boundaries, and PWA recovery assets pass.
- Schema: a fresh migration through 155 and the representative schema-101 upgrade/idempotency test pass.
- Coverage: 99.32% statements/lines, 100% functions, and 71.72% branches for the delivery-instruction domain and repository; 20/20 critical changed-line probes execute.
- Mutation: 18/18 injected critical faults are killed, followed by a clean-source rerun.
- Runtime: the production image serves Sales and Driver pages, while unauthenticated private instruction/media APIs fail closed.
- Supply-chain boundaries: no new dependency is introduced; production dependencies report zero install-time vulnerabilities; changed sources pass the high-confidence secret scan.

## Deliberate limits

- The gauntlet validates the existing upload-worker protocol and byte-preserving policy without contacting production object storage.
- Camera, installed-PWA, mobile filesystem, and network-transition behavior are covered by deterministic contracts/harnesses; a physical-device acceptance pass remains an operational pre-deployment check.
- Video is intentionally online-only. Instruction images and text are the offline-supported formats.

Reproduce with `npm run gauntlet:delivery-instructions` from `server/` or run `bash server/tools/delivery-instruction-gauntlet.sh` from the repository root.

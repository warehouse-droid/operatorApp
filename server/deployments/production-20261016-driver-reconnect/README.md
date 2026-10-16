# Deployed application snapshot: Driver reconnect

This snapshot records the verified application and its distinct webhook worker,
including required earlier deployed changes. Runtime bytes come from the release
candidate, with full hashes and immutable image identities in `manifest.json`.
The shared development workspace, credentials, database records, uploads, tickets,
and generated test artifacts are excluded.

Driver uploads and uncertain completion requests recover automatically. Completion
checks saved history before replay; Driver and Dispatch planning ignore billing
status while preserving closed/cancelled safeguards. The app logs completion stages,
connection failures and recovery. Drivers must reload the PWA online once active
submissions have finished to load shell v47.

`verification.json` records the exact release checks and known limitations. The
original real R2 replay remains valid because its upload client bytes are unchanged.
Historical incident cause attribution is not claimed.

The application runtime is under `server/src`, `server/public`, and
`server/migrations`. On a clean checkout, reconstruct the distinct worker into a
new directory with `python3 server/deployments/production-20261016-driver-reconnect/restore-worker.py /tmp/worker-source`.
The helper verifies every reconstructed file and does not deploy it.

Tests use pinned package dependencies plus the repository's bounded isolated
Docker configuration and `mbbs-tests.slice`. The reconnect unit, property,
integration and Playwright files are included. Host-specific release and replay
scripts additionally require the documented local browser image/toolchain,
ignored baseline/evidence captures, and separately supplied short-lived R2 test
tickets. They are preserved as operational tooling, not a credential-bearing or
self-contained replay of production records. Do not run release tooling from this
snapshot without preparing a fresh release capture.

`tools/driver-reconnect-snapshot.py` stages only an explicit support list and the
verified runtime into a private Git index. It never commits, updates branches,
pushes, or modifies the normal index. Re-run prepare and stage after deployment;
verify `deployed: true` before committing the resulting tree.

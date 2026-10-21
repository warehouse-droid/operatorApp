# Split dialog loading evidence — 12 October 2026

The existing Split action now displays the dialog before its fresh status request resolves. Confirmation remains disabled until an exact SO/TO preview verifies the selected order. The preview reads the selected header, lines, persistent split definition and loaded CO evidence; it avoids the whole enriched order feed. No buttons, dependencies, migrations or split mutation behavior were added.

The preview preserves native split progress, registered-only split quantities, TO outbound status, packed/loaded restrictions and no-store authenticated access. Late responses cannot reopen a closed dialog or replace a newer response. Failure and a changed planning date fail closed. Existing completed-S1 preservation, first-level splitting and S2 further splitting pass their regression tests.

Spec approval was not obtained (autonomous read-only performance task). The frozen acceptance spec is `test/split-dialog-fast-spec.md`. Initial regressions failed 18/18 against the captured live code before implementation. Strengthened race tests exposed and corrected date-change and ambiguous-parent bugs; coverage then added HTTP error, background status refresh and pending-confirmation checks.

Final source hash: `962cf47cf63cae0d4beb43330c3a363d6b1bd0834c750c4d3d9fccdecd629c77`. Final command: `python3 tools/split-dialog-fast-20261012/run.py final`.

- 24 focused checks passed (17 integration/property checks and 7 real Chromium scenarios).
- 43 existing checks passed; the same 43 pass on the captured live baseline with transport-only fixture support. No new regression failures.
- The 24 focused checks passed again with file order reversed: 91/91 total final non-mutant checks, including repeats.
- Changed executable line coverage: 111/111; this is changed-line coverage, not a claim of exhaustive branch coverage.
- Four non-equivalent manual mutations were all detected: delayed display, enabled pending confirmation, receiving lines treated as outbound, and parent quantity used for a registered split.
- Type and lint checks added zero diagnostics versus the captured live baseline. The existing type-check baseline has 23584 diagnostics; this is not a clean whole-repository type check. Modified tests have zero lint diagnostics.
- The status property used seed 20261012 and 15 generated positive packed/loaded quantities. Mutation kills are example/browser results, not property-only claims.

Toolchain: Node v20.20.2, TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0, fast-check 4.9.0, Playwright 1.62.1. Exact source/test/tool hashes are in `test-artifacts/split-dialog-fast-20261012/toolchain.json`.

Tests used the standard isolated Compose stack in `mbbs-tests.slice` with bounded resources, fake credentials and no production volumes. Teardown was registered before launch. `cleanup-final.json` confirms containers, database volumes and test networks were removed, both Docker listings contain only the four production services, and production health passed. Logs are retained without test databases.

No whole-repository or external NetSuite suite was run: this change adds a local read path and keeps existing mutation/network integration code unchanged. Integration checks use the actual HTTP server and PostgreSQL; browser checks exercise the production script with held network responses. Production verification is read-only and does not split an actual order. No before/after end-to-end latency measurement was taken; any release timing below is the direct local preview query, excluding HTTP/network/UI overhead.

Release uses a four-file overlay on the exact live image, preserves environment and dependent services, retains the rollback image, and automatically rolls back if live checks fail. Release succeeded at 2026-10-12T07:48:06.341719+00:00; image `sha256:9f15284a379624504a89c4599d3348c440e757cd33e93bb325b058d241e9b1f8`. Only the app changed; environment and dependent services were preserved. The planner serves the new asset version, and anonymous preview access returns 401. Completed S1 driver records and assignment hashes match the pre-release capture; cargo and group membership match historical completion evidence, retaining 4 photo references. Five direct read-only previews of SOA09143-S4 had median 10.38 ms, maximum 30.02 ms and a 885-byte response. This measurement excludes HTTP/network/UI overhead and has no before-time comparison. `deployment-result.json` and `cleanup-after-release.json` contain the final checks: production healthy and no test containers, volumes or networks remain.

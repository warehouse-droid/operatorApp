# Custom Order history yard matching — 2026-10-26

Status: deployed and verified at 2026-10-26T13:51:30.199519Z after the user
explicitly requested `deploy` and `short cutover`. The initial automatic review
block preceded that approval. Only the application container was replaced;
production records and database schema were unchanged.

The live read-only lookup reproduced RP-PER-CAM-1022 appearing for all yards but
not for yard 3445. Its configured pickup is `3445 Kennedy Road, Toronto, ON`;
the old lookup recognizes only bare codes. Completed driver records 7115/7117
retain six photos and completion at 2026-10-22T12:28:53.982Z.

The correction preserves exact-code matching and additionally accepts a unique
configured Dispatch address, ignoring case and whitespace. Matching uses shared
yard master data. Ambiguous, blank and unrelated addresses stay unscoped.

Spec: [custom-order-movement-yard-spec.md](custom-order-movement-yard-spec.md).
Spec approval: not obtained (autonomous run), so independent specification review
did not occur. Validation demonstrates the stated constraints, not completeness
of the specification.

| Acceptance criterion | Executable evidence |
| --- | --- |
| Full-address history, completed stops, six photos, source preservation | Y1 |
| Four configured addresses and generated case/whitespace variants | Y2, 16 seeded generated cases |
| Existing exact yard codes | Y3 |
| Unrelated/hostile addresses and number collisions | Y4 |
| Authorized list/detail/CSV; empty/wrong scopes and ordinary filters | Y5 and Y1 |
| Inactive historical yard identity | Y6 |
| Ambiguous or blank configured addresses | Y7/Y8 |
| Current master address determines identity | Y8 |
| Other history behavior and query planning | Existing history/performance suites and two history harnesses |
| One runtime file and unchanged dependencies | Captured image/tree hashes; bounded candidate image check |
| Disposable host workloads | Standard runner teardown plus image-check finally block; both Docker listings show only four production containers |

Final fresh checks:

- 26 tests passed, zero failed/skipped; same result with the file order reversed.
- Yard movement and sales-order reload history harnesses passed.
- The original behavior reproduced five failures and three passes in the eight
  focused cases; the corrected implementation passed all eight.
- 11/11 changed executable JavaScript lines covered. PostgreSQL-native branch
  instrumentation is unavailable; database behavior is exercised by the cases.
- Five of five deliberately faulty variants failed their targeted tests. The
  address-property test alone killed two of five; exact-code, offsite and
  ambiguous-address errors require the other explicit tests. No claim that
  address properties alone cover the access policy.
- Syntax checks passed. ESLint: zero runtime or tooling diagnostics.
- TypeScript: 821 diagnostic output lines both before and after, zero additions.
  The first static run caught implicit-any annotations in the new helper; string
  annotations were added and the complete check command rerun successfully.
- Diff secret scanning passed. Dependencies unchanged; no install/audit/license
  expansion required. One 14-line SQL helper; no network, filesystem or process
  capability added to the runtime.
- The legacy `dispatch-custom-order-harness.js` fails identically before/after:
  `AssertionError [ERR_ASSERTION]: The server-side TO feed must include open Custom Orders.`
  Its source-text regex expects an older server implementation. The assertion
  was preserved, not skipped or rewritten; its downstream cases do not run.
  Focused Y3/Y4/Y5 cover the relevant code/scope invariants independently.
- Validation covers the affected history suites, not every unrelated application
  module. No new browser run was added for this SQL-only correction. Live
  authenticated browser validation was not performed; post-release read-only
  repository checks confirmed the actual order, both driver records, all six
  photos and the CSV row. Health passed and all three anonymous history APIs
  returned 401 on their first attempt in the successful deployment.

Reproduce from the repository root:

```sh
bash docker/run-isolated-tests.sh node tools/custom-order-movement-yard-checks.mjs
```

Node v20.20.2; fast-check 4.9.0; c8 12.0.0; ESLint 10.8.0; TypeScript 7.0.2.
Runtime source SHA-256:
`64d8f76205c048802b355d5feef3d6d0f92c17d14ce99185a9fc1e83ddddcfbf`.
Exact input hashes and concise gate results are in the operational release
record `server/deployments/custom-order-movement-yard-20261026/validation-passed.json`.
Generated test output, logs, temporary copies, containers and test networks were
removed by the disposable runners, including after failed runs.

Deployed image: `mbbs-operator-app:custom-order-movement-yard-20261026`.
Image ID: `sha256:861049eb520f52628f519a38c437841be5663bc2a1336c862f44f58747fabafb`.
Its 1,503 runtime files match the captured live tree except the intended lookup
file. Seventeen imported runtime dependency files and the package lock match
the tested workspace. The existing package.json difference is scripts only;
dependencies/devDependencies match and the release preserves the live file.

The explicitly approved release was applied using:

```sh
python3 server/tools/custom-order-movement-yard-release.py deploy
```

The release checks active operations, preserves runtime configuration, updates
only the application container, verifies the actual record with read-only
database access, and restores the prior image on failed verification. The
worker, database and Ollama containers are excluded from the update.

The first authorized cutover restored the original image automatically after
an anonymous API verification request exceeded its five-second timeout. The
restored image was healthy, its complete source/configuration matched the
original capture, and replaying the same read-only sequence succeeded. Release
verification now permits up to three attempts only for startup timeouts; all
record/photo/access assertions remain mandatory. The application image and its
test results were unchanged. All three HTTP checks passed on attempt one in
the successful retry.

The successful cutover took 18.379 seconds through full verification, with
6.037 seconds of observed health interruption (81 health samples). All 1,503
runtime file hashes matched the reviewed image. Worker/database/Ollama identities
and application runtime configuration were preserved. Both running and stopped
container listings contained only the four production containers. Operational
details are in `deployment-result.json`, `cutover-observation.json`,
`cutover-timing.json`, and the earlier `rollback-result.json` in the release folder.

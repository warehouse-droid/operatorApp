# Split SO-to-split PO completion verification

SN1401884 now shows Completed in the live PO/TO schedule, including its
reconciliation-enriched row and exact-reference status projection. The release
finished on October 2, 2026 at 18:41 UTC. Driver dropoff 5492 already contained
the completed SOA09140-S1 and SOA09143-S1 deliveries at
2026-10-02T16:32:30.332758Z. The earlier PO rule checked original SO/group
references instead of resolving these exact split children, so it missed the
existing Driver proof. No Driver history was edited.

Migration 257 adds the missing immutable PO completion using that existing
Driver job and its exact PostgreSQL timestamp. The transport-status mapping
checks group membership, source line, source SO, allocated quantities and Driver
order kind. Every required product split must arrive; unfinished product remains
Partially Done. PALLET and Split Pallet Fee exclusions persist. The strict receipt
contract is unchanged, and this repair created zero Item Receipt jobs.

The [deployment result](../deployments/direct-linked-po-group-20261002-v2/result.json)
records the two-file overlay, complete runtime-tree verification, healthy local
and public endpoints, six preserved waitlist asset hashes and three protected
API routes. Configuration and worker/database/Ollama containers are preserved.
The final cutover observed 6.127 seconds of interruption, with readiness after
8.551 seconds. Live verification retained these dates:

| Order | Status | Actual completion (UTC) |
| --- | --- | --- |
| SN1401884 | Completed | October 2, 16:32:30 |
| LOINC-033146 | Completed | September 14, 16:11:31 |
| LOINC-035332 | Completed | October 1, 17:37:53 |
| PO#B03964 | Completed | October 2, 17:15:18 |

PO#B03964's later Driver completion existed before this follow-up cutover.

Old-coder Tier 3 was chosen because canonical completion can affect receipt
admission. Spec approval: not obtained (autonomous run). The user authorized
the PO/TO status deployment and subsequent correction. The
[specification](direct-linked-po-group-spec.md) records acceptance scenarios,
failure modes, setup and the visible compatibility/performance clarifications.
No dependency was added and no Git commit was created.

Run the persisted checks from `server` with the existing isolated runners:

```sh
python3 tools/direct-linked-po-group-gauntlet.py all
```

This entry point reruns scoped regressions with coverage, mutations, syntax,
test lint, reversed file ordering, waitlist regressions, credential-pattern scan
and version/source-hash reporting. It operates on the frozen validation source
in `deployments/direct-linked-po-group-20261002-v2`, the task-owned
`direct_linked_po_group_20261002` database, and the separate waitlist test database.
External NetSuite access is disabled in both isolated runners. The read-only
production preview is persisted separately:

```sh
python3 tools/direct-linked-po-group-preview.py
```

It verifies the frozen candidate before cutover and guards the captured live
app identity; after deployment that identity guard intentionally refuses to
preview over a different app. Current live verification is available through
`python3 tools/direct-linked-po-group-deploy.py verify`.

Final results after the last application/test edit:

| Layer | Actual result |
| --- | --- |
| Affected PO/TO suites, including ten group scenarios | 128 passed, 0 failed, 0 skipped |
| Same suites in reversed file order with fresh per-file database | 128 passed, 0 failed |
| Waitlist integration, adversarial and browser suites | 63 passed, 0 failed |
| New quantity properties | 20 generated examples, 40 quantity scenarios, seed 261002 |
| Deliberate mutations | 5/5 rejected on behavioral assertions |
| Property-only mutation runs | Missing sibling, insufficient quantity and false receipt admission each rejected |
| Changed JavaScript query-construction lines | 22/22 executed, 271 hits each |
| JavaScript syntax and new test lint | Passed, zero lint warnings |
| Scoped patch credential-pattern scan | Zero matches; no new runtime network/subprocess/env capability |
| Production rollback rehearsal of migration 257 | Passed in 2.904 seconds; transaction rolled back |
| Committed bounded recovery | Passed in 2.843 seconds; exact Driver timestamp retained |
| Live-data candidate preview | Read-only, 7.633 seconds total; completed list 2.785 seconds, active list 2.156 seconds |
| Deployed live verification | Read-only, 8.420 seconds total; completed list 3.036 seconds, active list 2.412 seconds |

Both live runs use a 10-second per-statement timeout. These are individual
samples, not production percentile or load-test claims. The migration transaction
fingerprinted the PO header, product/PALLET lines, allocations, canonical group,
group members, Driver jobs, prior PO/SO completions, receipt jobs and original
strict receipt function. Their fingerprints remained equal. Recovery tests also
check rollback, idempotence and duplicate suppression.

Acceptance maps to named tests in
`test/dispatch/integration/direct-linked-po-group-lifecycle.test.js`:

| Spec behavior | Executable evidence |
| --- | --- |
| Pickup progress and enriched/filtered rows | `grouped split pickup projects In Transit through filtered and enriched schedule rows` |
| All required split deliveries and actual final timestamp | `every grouped product split must arrive before completion at the final Driver time` |
| Parent/sibling isolation | `an unrelated split or completed root SO cannot complete this group's pending child` |
| Group identity, quantity and Driver kind | `group definitions with wrong line identity or insufficient quantity cannot establish delivery`, plus `group completion rejects wrong Driver kind` |
| Charges excluded; products still required | `SN1401884 shape: a grouped product split and linked PALLET split complete without new receipt admission`, `group completion rejects unfinished product quantity`, and existing charge/fee suites |
| Cancelled links and strict receipt admission | `group completion rejects cancelled allocation`, new quantity properties and receipt mutant |
| Bounded recovery and unchanged history | `historical group recovery retains exact Driver proof, source data, rollback and idempotence`, production fingerprint guard and live exact-Driver join |
| PO/TO, split and waitlist regression boundaries | Remaining 118 PO/TO tests and 63 waitlist tests |

The original-source run produced seven behavioral failures and three passing
negative regressions. The new implementation passed all ten. Final mutation
logs attribute each rejection to the selected named/property test; this is a
suite-level result, not independent mutation certification of every assertion.

Failures and corrections are retained honestly. Initial new-test lint reported
five missing-brace errors; formatting was corrected without changing assertions.
The reversed run exposed an older partial-delivery fixture whose second SO was
PALLET-only. The two affected scenarios now select an actual product fixture,
matching the user's PALLET exclusion; their timing/status assertions are unchanged.

The first app release passed isolated correctness tests but production schedule
verification exposed repeated reference resolution across Driver history. That
read was cancelled and the prepared automatic rollback restored the prior app.
The verified PO completion and compatible migration were retained. The two
measured health interruption windows were 5.358 and 5.553 seconds; the initial
sampler's 282.483-second span includes the healthy interval between restarts and
the slow schedule verification. The optimized query materializes resolved links
and matching Driver candidates, and passed real active/completed list checks
before its final release. Preview setup initially omitted a shared public module
and the selected app configuration, then used invalid module URLs; these harness
issues were corrected. Its initial full-list expectations incorrectly used the
exact-reference-only projection API and omitted Cancelled rows from the completed
view. The specification records both corrections; SN1401884's exact status,
timestamp and no-receipt assertions were preserved throughout.

Source identity and logs are in
[gauntlet-result.json](../deployments/direct-linked-po-group-20261002-v2/gauntlet-result.json)
and the release manifest. Deployed JavaScript hash is
`90cbb807492d59b43544b6817b6b23e367292e75ec2996661c46829810273733`;
migration 257 hash is
`f263103b66f9571c1d0a221d7236a1083a01f1fdf7e7e810807e702935caf3da`.
Recorded tools: Node 20.20.2, PostgreSQL 18.4, pg 8.21.0, c8 12.0.0,
ESLint 10.8.0, fast-check 4.9.0 and Python 3.14.4.

Limits: this verifies affected workflow suites, not every unrelated repository
module. These large JavaScript repositories are outside the existing static-type
configuration; real PostgreSQL executes and validates SQL types. SQL line/branch
instrumentation is unavailable, so V8 coverage measures query construction while
behavioral tests, mutations and live execution verify SQL behavior. No separate
formatter is configured for this change. Dependency audit was unnecessary because
dependencies did not change. Group snapshots use the existing flat canonical SO
child format; nested groups are outside this correction. Legacy links without a
persisted group definition retain exact root-reference compatibility. A known
group with missing children, mismatched line identity or insufficient quantities
fails closed. External receipt posting and production stress testing were not run.

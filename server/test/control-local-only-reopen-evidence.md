# Control local-only reopen evidence

Specification: [control-local-only-reopen-spec.md](control-local-only-reopen-spec.md).
Spec approval: not obtained (autonomous run). Tier 3. User direction expressly
authorizes a local reopen without checking NetSuite. No dependencies, migration,
commits or production order corrections were added.

Reproduce with `python3 server/tools/control-local-only-reopen-run.py final` from
the repository root with Docker access. The runner uses the live source as its
baseline and overlays exactly the four verified files; baseline source hashes,
candidate hashes, tool versions and measurements are in
[control-local-only-reopen-evidence.json](control-local-only-reopen-evidence.json).
This reproduction assumes the recorded pre-release live baseline is available;
after publication use the retained rollback image as the baseline when recapturing.

| Check | Final result |
| --- | --- |
| Initial regression against unchanged live source | All seven original new scenarios failed, including missing browser confirmation and a NetSuite connection attempt |
| Relevant regression suite | 124 passed, four reproduced baseline failures, zero new failures; 128 total, none skipped |
| New API/browser/history tests | 8/8 passed, including outbound TO coverage |
| Changed executable lines | 25/25 covered, including real browser coverage |
| Manual mutation | 6/6 killed; a property-only run also killed the quantity-reset mutant |
| Restored primary suite | 8/8 passed after mutation restoration |
| Types | 1,722 baseline diagnostics; 880 candidate diagnostics; zero new diagnostics |
| Lint and JavaScript syntax | Zero diagnostics for changed runtime JavaScript |
| Cleanup | Disposable containers, database storage and networks removed; both Docker listings verified; production health passed |

The four existing failures concern old expectations that loading blocks PO
linking: stale Open header, missing Operator attribution, source CO attribution,
and the pre-reopen PO-link refusal in the billed-order HTTP test. Each fails on
the unchanged live implementation before the candidate run. Those assertions
were retained. Earlier tests requiring NetSuite fulfillment/status to block the
Control reset were explicitly revised to the user's new local-only contract,
with conservation assertions replacing refusal assertions. One pre-existing
browser locator was scoped to the reopen panel so notification status elements
cannot make it ambiguous.

Spec mapping: the new integration suite covers F/G historical IF reopening,
zero remote requests with direct access enabled and NetSuite unavailable,
Operator/Dispatch availability, original photos/history and audit before-state,
new ledger evidence invalidating stale previews or ending local authority,
changed historical IF identity, outbound TO, grouped retry properties, and the
visible Confirm reopen action. Existing suites cover roles, yards, local receipt
and posting guards, Driver start, atomic rollback and concurrent reset locks.

Failure notes: initial harness attempts lacked the test working directory and
dependencies; both test stacks were removed. A root-owned generated mount path
blocked artifact deletion once; the exact directory was removed and the harness
now creates mount paths before startup and runs containers as the host user.
All later runs removed their unique artifact directories automatically.

Limits: unrelated application suites were not run. Full randomized test ordering
was not run; the primary suite was repeated after restoration. Manual mutations
are selected examples, not exhaustive. The dependency audit is inapplicable
because package files did not change. Type checking reports existing imported
module errors rather than claiming a clean application-wide type check. Separate
closed/inactive-order synchronization rules remain outside this reset change.
Diff review found no secrets or new external I/O capability; the reopen path's
NetSuite location-directory dependency was removed.

Only concise source evidence is retained. Logs, coverage, temporary dependency
installs and source snapshots were removed by the retention wrapper. Operational
release/rollback records are under `server/deployments/control-local-only-reopen-20261021`.

Deployed at 2026-10-21 15:18 UTC as image
`sha256:cb3eb17fc292c889cc8fb6f4db48b24e15c3c2ea85c4359e569b82baf28b4236`.
All four live file hashes and served Control assets match the verified candidate;
application configuration is unchanged. Database, worker and Ollama containers
were not replaced. The first publication attempt deferred while a local posting
job was active; it finished naturally before publication. No NetSuite lookup or
production order reset was performed for diagnosis or verification.

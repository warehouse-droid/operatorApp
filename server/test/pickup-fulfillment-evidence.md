# Existing IF pickup reconciliation — evidence (Tier 3)

Implemented and deployed to `mbbs-operator-app:pickup-existing-if-20260922-v1`. Operator confirmation can
complete a locally pending pickup using verified shipped IFs already in NetSuite.
The command creates zero posting steps, persists the IF numbers, and uses the
existing atomic local pickup finalization. Partial pickup remains partial.

- Spec: [pickup-existing-if-spec.md](pickup-existing-if-spec.md).
- Spec approval: separate approval not obtained (autonomous run within the user's
  implementation request). Confidence is reduced for any unreviewed interpretation;
  the spec is available for review.
- Source hash: `2c7444e0aa16e225d376a38977c4ecc7efea537fb63ed62f2b75740e84e946ea`; reproduce using `state()` in
  `tools/pickup-existing-if-gauntlet.py`. The pre-change snapshot is retained under
  `test-artifacts/pickup-existing-if/baseline`.
- Entry point: `python3 tools/pickup-existing-if-gauntlet.py` from `server`.
  It clears its final artifacts, uses disposable internal-network PostgreSQL
  databases, and compares the full suite to the saved pre-change baseline.
- Toolchain: Node v20.20.2, c8 12.0.0,
  ESLint 10.8.0, TypeScript 7.0.2,
  fast-check 4.9.0; package versions are already pinned.
  Test image digest: `sha256:a213a201d54066121bc474fd418fe25417cc595bfc4be21abd3cefcd0cd6e6a2`.

| Requirement | Evidence | Status |
| --- | --- | --- |
| Billed/Pending Billing reuses IF; normal open SO still posts | unit reader and real HTTP reader tests | pass |
| Missing orderLine recovered by stable key | unit target/draft test and PostgreSQL admission | pass |
| Wrong source, item, yard, unit, quantity, unshipped or void IF blocks | 34 corruption cases, generated properties and adversarial commands | pass |
| Multiple IFs, duplicate links, repeated SKU identities | unit tests and 350 generated property examples | pass |
| Only confirmed quantity completes; partial can resume | PostgreSQL 40 + 69 pickup test | pass |
| No duplicate command/load and atomic rollback | concurrent admissions/workers, replay and injected commit failure | pass |
| Save and return IF numbers for the existing result renderer | persisted load response and processor/finalizer assertions | pass |
| No new NetSuite transaction for reconciliation | zero adapter calls and HTTP request allowlist | pass |

| Final check | Result |
| --- | --- |
| Focused tests and neighboring posting tests | 102 passed, 0 failed |
| Focused tests in shuffled order | 58 passed, seed 220922 |
| Changed executable lines | 242/242 covered |
| Manual mutations: unit suite independently | 7/7 killed |
| Manual mutations: property suite independently | 7/7 killed |
| Types | 0 new errors; 256 pre-existing diagnostics |
| Lint | 0 new findings; 1 pre-existing complexity finding |
| Full suite | 2980 passed, 19 existing failures, 1 skipped |
| Full-suite comparison | 0 new failing tests or files; 17 failing files versus 18 baseline |
| Dependencies, schema | no changes |
| Changed-source secret scan | no matches in the scoped key/token pattern scan |
| Exact release candidate | 102 tests passed; imports and all six deployed runtime hashes verified |
| Live health/auth checks | local/public health 200; unauthenticated posting policy 401 |

Live read-only replay (`python3 tools/verify-pickup-fulfillment-live.py`):

| SO | Existing evidence |
| --- | --- |
| SOA07442 | Blocked: local 2.7 Yard versus current NetSuite 2 Yard |
| SOA07445 | IF149514 |
| SOA07446 | IF149515 |
| SOA07444 | IF151113 |

SOA07444's earlier local refresh was reconstructed only in memory for replay.
No local order rows or NetSuite fulfillments were changed by this validation.
The worker, database, application configuration and unrelated deployed files were
preserved. The release directory contains the prior image and a rollback override.

Known boundaries: missing/ambiguous evidence and unsupported kit mappings require
review. A status read is now needed for each enabled customer pickup, and billed
orders require additional source/IF reads; observed live lookups took about 4–89
seconds. App claims prevent competing app commands, but cannot lock external
NetSuite users after a read. Existing pickup validation and photo rules remain in
force. New frontend visuals were not introduced; browser layout checks are n/a.
Dependency vulnerability scanning was not repeated because dependencies did not
change; this report makes no repository-wide vulnerability claim.

During implementation, the initial claim-list test used the wrong stored shape
and was corrected; the domain assertions remained intact. Lint-driven extraction
was checked against the frozen tests. The mutation harness was corrected to
recognize fast-check counterexamples, and a missing-result assertion was made
explicit. The full suite caught the new adversarial file missing from its explicit
registration list; registration was added and verified before the final run.
Pre-existing repository failures were retained, not waived or hidden.

Raw evidence: `test-artifacts/pickup-existing-if/final/`, including source hashes,
coverage, static baseline comparisons, every mutant output, shuffle and full logs.

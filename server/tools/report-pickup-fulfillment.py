"""Render evidence from the completed check and release artifacts."""
import json
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
ARTIFACT = SERVER / 'test-artifacts/pickup-existing-if'
FINAL = ARTIFACT / 'final'
checks = json.loads((FINAL / 'checks.json').read_text())
regression = json.loads((FINAL / 'regression.json').read_text())
source = json.loads((FINAL / 'source.json').read_text())
live = json.loads((ARTIFACT / 'live-replay.json').read_text())
release = json.loads(Path('/home/ubuntu/operatorapp-deploy-backups/pickup-existing-if-20260922-v1/result.json').read_text())
assert checks['sourceHash'] == regression['sourceHash'] == source['sourceHash']
rows = '\n'.join('| ' + row['order'] + ' | ' + (', '.join(row['existingIFs']) if 'existingIFs' in row else
    'Blocked: local 2.7 Yard versus current NetSuite 2 Yard') + ' |' for row in live['results'])
text = f"""# Existing IF pickup reconciliation — evidence (Tier 3)

Implemented and deployed to `{release['image']}`. Operator confirmation can
complete a locally pending pickup using verified shipped IFs already in NetSuite.
The command creates zero posting steps, persists the IF numbers, and uses the
existing atomic local pickup finalization. Partial pickup remains partial.

- Spec: [pickup-existing-if-spec.md](pickup-existing-if-spec.md).
- Spec approval: separate approval not obtained (autonomous run within the user's
  implementation request). Confidence is reduced for any unreviewed interpretation;
  the spec is available for review.
- Source hash: `{source['sourceHash']}`; reproduce using `state()` in
  `tools/pickup-existing-if-gauntlet.py`. The pre-change snapshot is retained under
  `test-artifacts/pickup-existing-if/baseline`.
- Entry point: `python3 tools/pickup-existing-if-gauntlet.py` from `server`.
  It clears its final artifacts, uses disposable internal-network PostgreSQL
  databases, and compares the full suite to the saved pre-change baseline.
- Toolchain: Node {checks['versions']['node']}, c8 {checks['versions']['c8']},
  ESLint {checks['versions']['eslint']}, TypeScript {checks['versions']['typescript']},
  fast-check {checks['versions']['fast-check']}; package versions are already pinned.
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
| Focused tests and neighboring posting tests | {checks['focusedAndNeighbors']} passed, 0 failed |
| Focused tests in shuffled order | {checks['focused']} passed, seed {checks['shuffleSeed']} |
| Changed executable lines | {checks['changedLineCoverage']['covered']}/{checks['changedLineCoverage']['total']} covered |
| Manual mutations: unit suite independently | 7/7 killed |
| Manual mutations: property suite independently | 7/7 killed |
| Types | 0 new errors; {checks['baselineTypeErrors']} pre-existing diagnostics |
| Lint | 0 new findings; {checks['baselineLint']} pre-existing complexity finding |
| Full suite | {regression['passed']} passed, {regression['currentFailedTests']} existing failures, {regression['skipped']} skipped |
| Full-suite comparison | 0 new failing tests or files; {regression['currentFailedFiles']} failing files versus {regression['baselineFailedFiles']} baseline |
| Dependencies, schema | no changes |
| Changed-source secret scan | no matches in the scoped key/token pattern scan |
| Exact release candidate | 102 tests passed; imports and all six deployed runtime hashes verified |
| Live health/auth checks | local/public health 200; unauthenticated posting policy 401 |

Live read-only replay (`python3 tools/verify-pickup-fulfillment-live.py`):

| SO | Existing evidence |
| --- | --- |
{rows}

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
"""
(SERVER / 'test/pickup-fulfillment-evidence.md').write_text(text)
print('test/pickup-fulfillment-evidence.md')

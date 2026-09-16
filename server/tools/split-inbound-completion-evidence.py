"""Summarize the final recorded checks without inventing unavailable results."""
from pathlib import Path
import hashlib
import json
import re

root = Path(__file__).resolve().parents[1]
artifact = root / 'test-artifacts/split-inbound-completion'
read = lambda name: json.loads((artifact / name).read_text())
static, types, coverage, mutants = [read(name) for name in ['static.json','types.json','changed-coverage.json','mutations.json']]
for file, digest in static['hashes'].items():
    assert hashlib.sha256((root / file).read_bytes()).hexdigest() == digest, file
assert all(row['killed'] for row in mutants)
assert all(not row['missing'] for row in coverage)
assert not types['added']
suite = [json.loads(line) for line in (artifact/'suite.log').read_text().splitlines() if line.startswith('{')]
assert len(suite) == 3 and all(row['matched'] for row in suite)

def counts(name):
    content = (artifact/name).read_text()
    return {key:sum(map(int,re.findall(r'^# '+key+r' (\d+)$',content,re.M))) for key in ['tests','pass','fail']}

focused, related, reversed_suite, maintenance = [counts(name) for name in ['focused.log','regression.log','reversed.log','refresh-tests.log']]
assert focused['fail'] == maintenance['fail'] == 0
covered = sum(row['coveredLines'] for row in coverage)
changed = sum(row['changedLines'] for row in coverage)
source_hash = hashlib.sha256(json.dumps(static['hashes'],sort_keys=True).encode()).hexdigest()
lines = [
    '# Completed split PO incoming inventory — evidence', '',
    'spec approval: not obtained (autonomous run)', '',
    'User-authorized Tier 2 fix. Specification: [split-inbound-completion-spec.md](split-inbound-completion-spec.md).', '',
    '## Result', '',
    'Shared remaining-quantity SQL now excludes an exact completed PO split and a fully received local header. Partial receipts reconcile the fixed baseline, posted physical/sales quantities, and latest NetSuite total without counting the same receipt twice. Confirmation timestamps prevent a new receipt draft from reusing an old partial-receipt status.', '',
    'The planner, proposal editor, vendor alternative evidence, and new transfer-phase evidence use this rule. Existing approved phase snapshots and source allocation deductions are retained.', '',
    '## Final checks', '',
    f'- Focused PostgreSQL tests: {focused["pass"]}/{focused["tests"]} pass, including the live three-by-24-PLT reproduction.',
    f'- Draft evidence maintenance: {maintenance["pass"]}/{maintenance["tests"]} pass (unchanged manual quantities, audit, idempotence, revision guard). These maintenance checks were added after the one-time helper; the application fix has observed RED tests.',
    f'- Related SCM/receiving suites: {related["pass"]}/{related["tests"]} pass; {related["fail"]} reproduced baseline failure.',
    f'- Reversed file order: {reversed_suite["pass"]}/{reversed_suite["tests"]} pass; {reversed_suite["fail"]} reproduced baseline failures. Zero new failures in either order.',
    f'- Changed application lines: {covered}/{changed} exercised; PostgreSQL cases cover completion, status, timestamp, conversion and remaining-quantity conditions.',
    f'- Manual mutation: {sum(row["killed"] for row in mutants)}/{len(mutants)} assertion kills. Property tests alone detect {sum(row["propertyKilled"] for row in mutants)}/{len(mutants)}; no claim that properties cover all completion/status conditions.',
    '- Property test: 40 generated receipt/ordered-quantity combinations, seed 3737; exact expected balance and lower/upper bounds asserted.',
    f'- TypeScript {types["typescript"]}: {types["baselineErrors"]} baseline / {types["currentErrors"]} current diagnostics, zero new.',
    f'- Syntax: four application files pass. Lint: {sum(row["current"] for row in static["lint"])} existing diagnostic, zero new. New helper complexity <= 12.',
    '- Secret scan: zero findings in the new helper and focused fixtures. No dependency, lockfile, network, authentication, or schema changes.', '',
    '## Baseline and verification limits', '',
    '- `smart-scm-harness.js` already fails because its fixture is missing an active Item Master record.',
    '- Reversed order also exposes the existing vendor-alternative harness integer overflow after another fixture leaves very large item IDs. The original source reproduces both failures; no assertion was weakened.',
    '- The whole application suite was not run: the applicable SCM, split receiving and inventory suites above were selected. Unrelated browser flows and external NetSuite writes were not exercised. No UI code changed.',
    '- A timestamp edge case was found after the first deployment; it has its own observed RED (181.6 actual vs 900 expected), regression, and final deployment. Earlier individual guard mutations became redundant after this safeguard; final mutants remove the complete relevant guard and all are detected.',
    '- Local partial counters require a confirmed, posted receipt timestamp. NetSuite remains the authority for other raw on-order balances; this fix changes the local split overlay, not historical source inventory snapshots.', '',
    '## Acceptance mapping', '',
    '| Spec | Evidence |', '|---|---|',
    '| 1: three completed 24-PLT splits | planner and editor reproduction tests; live item 2277 at 3445 |',
    '| 2: exact identity; sibling/kind/pickup isolation | exact-reference test and real Driver trigger pickup/drop-off test |',
    '| 3–4: posted partial receipts; overlap; bounds | mixed pallet/layer/section/piece example, sales-only property test, full receipt and stale-draft tests |',
    '| 5: consistent consumers and frozen phase | vendor alternative test; approval evidence and repeated approval immutability |',
    '| 6: existing split behavior | same/cross-yard, terminal filters, ordinary parent evidence, related suites |',
    '| 7: retain operational data and manual proposal quantities | read-only query change, maintenance tests, live rollback and fingerprints |', '',
    '## Reproduce', '',
    'From the repository root: `bash server/tools/split-inbound-completion-gauntlet.sh`.', '',
    'Uses cached `mbbs-retired-confirm-test:20260914` (Node 20.20.2, TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0, fast-check 4.9.0) and disposable PostgreSQL 18. The test runner creates an internal Docker network and removes the database afterwards. Baseline is recoverable from the task-only patch. Live maintenance is a separate explicit command bound to run 389, revision 2; do not rerun `apply` after correction.', '',
    f'Application source set SHA-256: `{source_hash}`.', '',
    '```json', json.dumps(static['hashes'],indent=2), '```', ''
]
live_file = artifact/'live-verify.json'
if live_file.exists():
    live=read('live-verify.json')
    applied=read('live-apply.json')
    before=read('live-read-before-refresh.json')
    assert live['fingerprints']==before['fingerprints']
    lines += ['## Live verification', '',
        '- Final image: `mbbs-operator-app:split-inbound-completion-20260915-v2`, app and webhook worker. Only four source files were layered over the existing deployment.',
        f'- Forecast {live["forecastRunId"]}; HUNT70S-RDM-CG / 3445: incoming {live["inventory"]["quantityOnOrder"]} SQFT, backorders {live["inventory"]["quantityBackordered"]} SQFT, signed Expected -10.250831 PLT.',
        f'- Corrected saved inventory evidence on {len(applied["maintenance"]["updates"])} rows in Blanket run 389; revision 2 → 3. Proposal 34397 / line 119322 stays at 5 PLT.',
        '- Transaction rehearsal was rolled back before apply. Before/after fingerprints match for every proposal header and every non-evidence line value in the run.',
        '- Before/after inventory reasons are retained in the plan revision and `smart_scm.split_inbound_completion.inventory_refresh` audit. Deploy backups are under `/home/ubuntu/operatorapp-deploy-backups/split-inbound-completion-20260915-v2/`.', '']
(root/'test/split-inbound-completion-evidence.md').write_text('\n'.join(lines))
print(json.dumps({'focused':focused,'maintenance':maintenance,'related':related,'reversed':reversed_suite,'coverage':[covered,changed],'mutants':len(mutants),'sourceHash':source_hash}))

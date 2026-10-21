"""Compare the fix against production and record reproducible release evidence."""
from collections import Counter
import difflib
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
ARTIFACT = SERVER / 'test-artifacts'
RELEASE = ARTIFACT / 'direct-ship-lifecycle-20260925'
DEPLOYMENT = ARTIFACT / 'direct-ship-deployment-20260926-v2'
CHECKS = ARTIFACT / 'dispatch-special-po-lifecycle/checks'


def log(name):
    return (RELEASE / (name + '.log')).read_text()


def counts(value):
    return {key: sum(map(int, re.findall(r'^(?:ℹ |# )' + key + r' (\d+)$', value, re.M)))
            for key in ['tests', 'pass', 'fail', 'skipped', 'cancelled']}


def failures(value):
    return sorted(set(re.findall(r'^✖ (.+?) \([\d.]+ms\)$', value, re.M)))


def failed_files(value):
    files, current = set(), None
    for line in value.splitlines():
        match = re.match(r'\[isolation\].+ (/app/\S+)', line)
        if match:
            current = match.group(1).removeprefix('/app/')
        if line.startswith('✖ ') and line != '✖ failing tests:':
            assert current
            files.add(current)
    return sorted(files)


def replay():
    files = failed_files(log(sys.argv[2] if len(sys.argv)>2 else 'frozen-full'))
    script = """import path from 'node:path';
import {query,closeDb} from './src/db.js';
import {buildIsolatedTestEnvironment} from './test/support/test-foundation.mjs';
import {runNodeTestFilesIsolated} from './test/support/test-database-isolation.mjs';
const files=process.argv.slice(1);
if(files.includes('test/mbt/integration/stock-return-draft-insert.test.js')) {
  await query("UPDATE return_reason_cache SET fetched_at=now()-interval '2 days'");
}
await closeDb();
process.exitCode=await runNodeTestFilesIsolated(files.map(file=>path.resolve(file)),{
  environment:buildIsolatedTestEnvironment(process.env,{databaseUrl:process.env.DATABASE_URL}),label:'Production baseline replay'});
"""
    command = ['sudo', '-n', 'env', 'SPECIAL_PO_CHECK=direct-ship-baseline-full',
               'SPECIAL_PO_SOURCE_ROOT=' + str(DEPLOYMENT / 'baseline'),
               'bash', str(SERVER / 'tools/dispatch-special-po-test.sh'),
               'node', '--input-type=module', '-e', script, *files]
    with (RELEASE / 'baseline-full.log').open('wb') as output:
        result = subprocess.run(command, cwd=SERVER, stdout=output, stderr=subprocess.STDOUT)
    print(json.dumps({'baselineFailedFiles': files, 'exitCode': result.returncode,
                      'stockReturnCacheAgedToMatchLongFullRun': 'test/mbt/integration/stock-return-draft-insert.test.js' in files,
                      'counts': counts(log('baseline-full'))}), flush=True)


def diagnostics():
    def lint(file):
        return Counter((row['filePath'], message['ruleId'], re.sub(r'line \d+ column \d+', 'line N column N', message['message']))
                       for row in json.loads(file.read_text()) for message in row['messages'])
    def types(file):
        return Counter(re.sub(r'\(\d+,\d+\)', '', line) for line in file.read_text().splitlines())
    result = {}
    for name, parse in [('lint', lint), ('types', types)]:
        baseline = parse(CHECKS / 'direct-ship-baseline-static' / (name + '.log'))
        candidate = parse(CHECKS / 'direct-ship-final-static' / (name + '.log'))
        assert not candidate - baseline, (name, candidate - baseline)
        result[name] = {'existingDiagnostics': sum(candidate.values()), 'newDiagnostics': 0}
    return result


def coverage():
    source = json.loads((CHECKS / 'direct-ship-final-coverage/coverage/coverage-final.json').read_text())
    result = []
    for file in json.loads((SERVER / 'tools/direct-ship-files.json').read_text()):
        if not file.startswith('src/') or not file.endswith('.js'):
            continue
        baseline_file = DEPLOYMENT / 'baseline' / file
        before = baseline_file.read_text().splitlines() if baseline_file.exists() else []
        after = (SERVER / file).read_text().splitlines()
        changed = set()
        for tag, _, _, start, end in difflib.SequenceMatcher(a=before, b=after).get_opcodes():
            if tag in ['insert', 'replace']:
                changed.update(range(start + 1, end + 1))
        data, hits = source['/app/' + file], {}
        for key, pos in data['statementMap'].items():
            for line in range(pos['start']['line'], pos['end']['line'] + 1):
                hits[line] = max(hits.get(line, 0), data['s'][key])
        changed = {n for n in changed if after[n - 1].strip() and not after[n - 1].lstrip().startswith('//')}
        missing = sorted(n for n in changed if not hits.get(n, 0))
        assert not missing, (file, missing)
        result.append({'file': file, 'changedLines': len(changed), 'covered': len(changed)})
    return result


def check():
    groups=['infrastructure','unit','contracts','property','integration','adversarial','concurrency']
    declared=sum(1 for group in groups for path in (DEPLOYMENT/'source/test/mbt'/group).rglob('*')
                 if path.is_file() and re.search(r'\.test\.(js|mjs)$',path.name))
    assert re.search(r'Isolated MBT main run (?:failed in \d+/'+str(declared)+r' file\(s\)|passed: '+str(declared)+r' file\(s\))',log('frozen-full')), 'Full suite still running or inventory changed'
    baseline_related = set(failures(log('baseline-related')))
    baseline_full = set(failures(log('baseline-full')))
    assert not set(failures(log('final-coverage'))) - baseline_related, 'New related failure'
    assert set(failures(log('final-random'))) == set(failures(log('final-coverage'))), 'Order-dependent related suite'
    assert not set(failures(log('frozen-full'))) - baseline_full, 'New full-suite failure'
    assert set(failed_files(log('frozen-full'))) <= set(failed_files(log('baseline-full')))
    assert counts(log('frozen-full'))['fail'] <= counts(log('baseline-full'))['fail'], 'Additional full-suite failure'
    assert counts(log('final-coverage'))['fail'] <= counts(log('baseline-related'))['fail'], 'Additional related failure'
    assert counts(log('final-offline'))['fail'] == 0 and 'run passed' in log('final-offline')
    mutations = json.loads((CHECKS / 'direct-ship-final-mutations/mutations.json').read_text())
    assert len(mutations) == 11 and all(row['killed'] for row in mutations)
    assert sum(row['propertyKilled'] is True for row in mutations) == 5
    summary = json.loads((CHECKS / 'direct-ship-final-coverage/coverage/coverage-summary.json').read_text())
    route = summary['/app/src/dispatch-to-route-projection.js']
    assert route['lines']['pct'] == 100
    assert 'Secret scan passed:' in (CHECKS / 'direct-ship-final-secrets/secrets.log').read_text()
    manifest = json.loads((DEPLOYMENT / 'manifest.json').read_text())
    assert sorted(manifest['runtimeChanges']) == sorted(json.loads((SERVER / 'tools/direct-ship-files.json').read_text()))
    replay_result = json.loads((RELEASE / 'replay.json').read_text())
    assert replay_result['passed'] and not replay_result['failures']
    assert replay_result.get('catalogRefresh'), 'Production-copy catalog refresh was not exercised'
    assert 'completionRecovery' in replay_result, 'Historical completion recovery was not exercised'
    result = {'passed': True, 'sourceTreeHash': manifest['sourceTreeHash'],
              'fullSuite': counts(log('frozen-full')), 'relatedSuite': counts(log('final-coverage')),
              'randomizedSuite': counts(log('final-random')), 'offlineSuite': counts(log('final-offline')), 'newTestFailures': 0,
              'knownFullFailures': sorted(baseline_full), 'knownRelatedFailures': sorted(baseline_related),
              'mutationKilled': len(mutations), 'propertyMutationsKilled': 5,
              'changedCoverage': coverage(), 'routeCoverage': route, 'staticChecks': diagnostics(),
              'productionCopyInventory': replay_result['inventory'], 'simulations': len(replay_result['simulations']),
              'catalogRefresh': replay_result.get('catalogRefresh'), 'snapshot': replay_result['snapshot'],
              'historicalCompletionRecovery': len(replay_result['completionRecovery'])}
    (DEPLOYMENT / 'release-checks.json').write_text(json.dumps(result, indent=2) + '\n')
    validation_files = sorted({path for pattern in ['tools/direct-ship*', 'test/dispatch/**/direct-ship*', 'test/direct-ship-lifecycle-spec.md']
                               for path in SERVER.glob(pattern) if path.is_file()})
    validation_hashes = {str(path.relative_to(SERVER)): hashlib.sha256(path.read_bytes()).hexdigest() for path in validation_files}
    (DEPLOYMENT / 'validation-files.json').write_text(json.dumps(validation_hashes, indent=2) + '\n')
    covered = sum(row['covered'] for row in result['changedCoverage'])
    report = f"""# Direct shipment lifecycle evidence

Spec approval: **not obtained (autonomous run)**. The user authorized fixing and replaying direct-ship SOs with linked TOs/POs. This is Tier 3 validation of the [executable specification](direct-ship-lifecycle-spec.md), not independent review of its completeness.

Runtime source hash: `{manifest['sourceTreeHash']}`. Candidate image: `{manifest['imageId']}`. The 14 runtime differences from the previous production release are recorded in `tools/direct-ship-files.json`. The release was rebased onto the separately deployed Special Stock fix, which is preserved unchanged.

## Acceptance evidence

| Behavior | Executable evidence |
| --- | --- |
| Fully linked PO cannot be planned twice; both references guarded; SCM inherits linked planning | `direct-ship-po-planning.test.js`: feed, actual V2 rejection, common guards, schedule |
| Partial PO requires all SO deliveries and its remaining delivery, in either order | Same integration file: both delivery orders, actual latest timestamp, both completed aliases blocked |
| Partial TO exposes exactly its unallocated cargo through feed, saved plan and Driver | `direct-ship-to-lifecycle.test.js`: 20 native pieces minus 19 leaves 1; real replacement command, compact snapshot and materialized Driver job |
| TO completion waits for both portions; full TO uses actual Driver time | Same integration file: both delivery orders, completion and direct receipt timestamps |
| Quantity conservation and source caps | `direct-ship-quantities.test.js`: 1,000 generated cases, seed 35925230; duplicate item lines, cancellation, mixed units; integration tests for reduced source and already-received stock |
| Replay and concurrency do not double receipts | Competing transactions, replay assertions and existing online/offline Driver integration; 25-way completion race |
| Correct historical projection without deleting evidence | Migration integration: immutable old event retained, correction applied twice, legitimate later completion remains effective |
| Started route cargo stays unchanged | `direct-ship-recorded-projection.test.js` |
| Browser displays exact remaining pickup/drop quantities | `frontend/direct-ship-quantities.test.js` executes the production declarations with stale stop totals |
| Cached planner cards reflect repaired history | Fresh production-copy replay rebuilds the derived catalog and verifies corrected labels without changing delivery/receipt totals |

## Final verification

- Full isolated suite: {result['fullSuite']['tests']} tests, {result['fullSuite']['pass']} passed, {result['fullSuite']['fail']} pre-existing failures, {result['fullSuite']['skipped']} skipped. All failing files replayed on the production baseline; **zero new failures**.
- Related suite: {result['relatedSuite']['tests']} tests, {result['relatedSuite']['pass']} passed, {result['relatedSuite']['fail']} pre-existing harness failure. Randomized order (seed 23035925) produces the same result. The 23 new direct-shipping tests pass.
- Actual offline Driver flow: {result['offlineSuite']['pass']} passed, {result['offlineSuite']['fail']} failed. Online flow is included in the related suite.
- Changed backend JavaScript lines: **{covered}/{covered} covered**, across 11 modules. New TO projection line coverage: {route['lines']['pct']}%; branch coverage: {route['branches']['pct']}%. SQL migration paths and browser behavior are tested directly; they are not included in the Node line metric.
- Manual mutations: **11/11 killed**; the quantity suite alone kills its 5 applicable mutants (four generated-property defects plus the fixed mixed-unit example).
- Syntax, lint and types: zero new diagnostics. Existing lint diagnostics: {result['staticChecks']['lint']['existingDiagnostics']}; existing type diagnostics: {result['staticChecks']['types']['existingDiagnostics']}.
- Secret scan: task diff passed. A whole-file scan initially flagged an unchanged HTML token attribute; changed-line scanning confirms it was not introduced by this task.
- No packages or runtime network capabilities were added. Existing Node 20.20.2 tooling image `field-sales-check-2941306:latest`, PostgreSQL 18 and project lockfile dependencies were used. New functions are bounded to projection, database guards or release tooling; existing broad repositories retain their public signatures.
- Candidate app and worker booted; health returned 200; migrations ran twice. The previous app and worker also booted against the migrated schema. The shared priority scheduler test preserved Operator capacity during worker activity. These smoke checks made no live NetSuite writes.

## Production-copy replay

Snapshot: `{replay_result['snapshot']}`. The private dump and per-order data remain under `test-artifacts/`.

{result['productionCopyInventory']['distinctLinkedSalesOrders']} distinct linked SOs, {result['productionCopyInventory']['directTransferLinks']} direct TO links ({result['productionCopyInventory']['activeTransferLinks']} active, {result['productionCopyInventory']['cancelledTransferLinks']} cancelled), and {result['productionCopyInventory']['poAllocations']} PO allocation rows ({result['productionCopyInventory']['activePoAllocations']} active) were checked. {result['productionCopyInventory']['recordedCompletedCustomerDrops']} recorded customer drops were replayed twice. {result['simulations']} isolated delivery simulations passed. Receipt quantities and immutable event counts were unchanged on the second replay. Simulations are not represented as real deliveries. No production Driver jobs, receipts or NetSuite fulfillments were created by replay. The completion-only recovery matched {result['historicalCompletionRecovery']} historical entries discovered by actual replay, and a second recovery created nothing.

## Reproduce and limits

Run `bash tools/direct-ship-gauntlet.sh`. It uses the captured baseline, frozen release and private production backup. The production-data portion requires authorized access to that backup; ordinary tests use disposable seeded databases. `tools/direct-ship-test-source.py` copies final task tests/tooling into the frozen runtime without changing runtime files. `validation-files.json` records their hashes. Each layer's raw logs and JSON are retained under `test-artifacts/direct-ship-lifecycle-20260925` and `test-artifacts/dispatch-special-po-lifecycle/checks/direct-ship-*`.

The initial RED runs exposed the duplicate planning and premature TO completion defects. Later RED runs added receipt capping, mixed-unit, recorded-route and alias protections. An unknown-quantity fixture initially violated a schema constraint; its fixture was corrected without changing expectations and its guard behavior was proven by mutation. A timestamp mutant initially broke SQL parameter binding; it was replaced with a valid processing-time defect and the final suite killed it. The read-only migration preview initially undercounted candidates because an inner SQL alias shadowed its correlation; comparison with the actual migration exposed it, and the corrected preview matches the four candidates. No acceptance assertion was weakened.

The full repository is not globally green: the exact baseline failure names are in `release-checks.json`. Coverage is reported for changed backend lines, not as total application coverage. Browser quantity tests execute actual declarations but do not substitute for testing every interactive browser path. Replay covers one recorded production snapshot; it does not send historical business actions again to NetSuite. Migration rollback compatibility was verified by startup, while immutable correction history is retained. These are scoped evidence and explicit limits, not a claim of universal correctness.
"""
    live_names = ['deployment-result.json', 'live-probe.json', 'catalog-refresh.json',
                  'completion-recovery-audit.json', 'live-inventory.json', 'final-worktree-status.json']
    if all((DEPLOYMENT / name).exists() for name in live_names):
        live = {name: json.loads((DEPLOYMENT / name).read_text()) for name in live_names}
        deployed = live['deployment-result.json']
        probe = live['live-probe.json']
        refreshed = live['catalog-refresh.json']
        audit = live['completion-recovery-audit.json']
        inventory = live['live-inventory.json']
        drift = live['final-worktree-status.json']['unreleasedRuntimeFiles']
        assert deployed['imageId'] == manifest['imageId'] and deployed['deployed']
        assert probe['driverEvidenceVerified'] and probe['bothPoAliasesBlocked']
        assert audit['receiptsUnchanged'] and audit['remainingMissingCompletions'] == 0
        assert inventory['inventoryMatchesReplay']
        report += f"""
## Live deployment

Deployed on 2026-09-26 at 03:15 UTC; final service verification: {deployed['at']}. Both app and worker run the exact verified image, with 1082 runtime file hashes checked in each. Local/public health: {deployed['localHealth']}/{deployed['publicHealth']}; anonymous protected API access: {deployed['anonymousAccess']}. Database, Ollama and service configuration were preserved.

Four original partial-TO completion events remain immutable and are excluded from the effective history. Three missing PO completions were recovered from their original Driver evidence: LOINC-024857, LOINC-028285 and SN1398328. Receipt counts and received quantities were unchanged by recovery; a subsequent query found zero missing completions. SPREQ-000007 was handled by the other thread, and this recovery left its record unchanged.

Catalog refresh: {refreshed['requested']} references, {refreshed['upserted']} cards written, {refreshed['removed']} removed. LOINC-035925 is {probe['scheduleStatus']}, both PO aliases are blocked from replanning, and its completion time ({probe['completedAt']}) matches actual Driver evidence. Live checks covered {probe['fullyLinkedPoGuardsChecked']} fully linked PO families and {inventory['liveTransferGuardsChecked']} active TO links. The live inventory matches all 83 SOs in the replay.

The first live catalog check failed because a NetSuite sync ran during verification. TOB01093, TOB01095 and TOB01135 acquired independent Received reconciliation evidence; TOB01129 became Pending Receipt. The existing fulfilled-TO policy uses a Completed card label while retaining residual planning eligibility. The deployment check had incorrectly equated that label with local Driver completion. The specification now states this distinction explicitly; runtime acceptance tests were unchanged. The clarified checks require no obsolete local completion, retain residual planning eligibility, and verify TOB01129's SCM schedule is In Transit. The isolated snapshot replay was rerun with these checks. The deployed runtime source was unchanged after the full-suite run.

The development image disappeared before the post-deployment replay could start its application checks. That infrastructure attempt failed, and its logs were retained. The replay runner now uses the exact release image ID from the manifest, fails early if it is unavailable, and prohibits pulls. The final isolated replay uses production dependencies and is recorded in `postdeploy-runtime-replay.log`; the final changed-line secret scan is in `postdeploy-secrets.log`. The full gauntlet can rebuild a missing development image using the existing `Dockerfile.test` and lockfile; this rebuild branch was syntax-checked but was not needed for the final runtime replay.

Newer runtime edits from the other thread are outside this deployed snapshot: {', '.join('`' + name + '`' for name in drift) if drift else 'none at the final worktree check'}. Private backups and raw per-order deployment evidence remain under `test-artifacts/direct-ship-deployment-20260926-v2/`.
"""
    (SERVER / 'test/direct-ship-lifecycle-evidence.md').write_text(report)
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    {'replay': replay, 'check': check}[sys.argv[1]]()

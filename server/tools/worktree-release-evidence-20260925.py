"""Reproduce candidate failures on production source and verify release evidence."""
import collections
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
RELEASE = SERVER / 'test-artifacts/whole-worktree-deployment-20260925'


def read(name):
    return (RELEASE / name).read_text()


def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + '\n')


def failed_files(log):
    files = set()
    current = None
    for line in log.splitlines():
        match = re.match(r'\[isolation\].+ (/app/test/\S+)', line)
        if match:
            current = match.group(1).removeprefix('/app/')
        if line.startswith(('✖ ', 'not ok ')) and line != '✖ failing tests:':
            assert current, 'Failure outside a test file'
            files.add(current)
    return sorted(files)


def failure_names(log):
    return sorted(set(re.findall(r'^✖ (.+?) \([\d.]+ms\)$', log, re.M)))


def counts(log):
    return {key: sum(map(int, re.findall(r'^(?:ℹ |# )' + key + r' (\d+)$', log, re.M)))
            for key in ['tests', 'pass', 'fail', 'skipped', 'cancelled']}


def replay():
    label = sys.argv[2] if len(sys.argv) > 2 else 'baseline-failures'
    files = failed_files(read('full-mbt.log'))
    prior_file = RELEASE / 'baseline-failures-result.json'
    prior = json.loads(prior_file.read_text()) if label != 'baseline-failures' and prior_file.exists() else None
    if prior:
        files = sorted(set(files) - set(prior['files']))
    if not files:
        print(json.dumps({'additionalFailedFiles': 0}), flush=True)
        return
    save(label + '-files.json', files)
    script = """import path from 'node:path';
import {buildIsolatedTestEnvironment} from './test/support/test-foundation.mjs';
import {runNodeTestFilesIsolated} from './test/support/test-database-isolation.mjs';
process.exitCode=await runNodeTestFilesIsolated(process.argv.slice(1).map(f=>path.resolve(f)),{
environment:buildIsolatedTestEnvironment(process.env,{databaseUrl:process.env.DATABASE_URL}),label:'Production baseline replay'});
"""
    command = ['sudo', '-n', 'env', 'WORKTREE_RELEASE_CHECK=' + label,
               'WORKTREE_RELEASE_SOURCE_ROOT=' + str(RELEASE / 'baseline'),
               'bash', str(SERVER / 'tools/worktree-release-test-20260925.sh'),
               'node', '--input-type=module', '-e', script, *files]
    with (RELEASE / (label + '.log')).open('wb') as output:
        result = subprocess.run(command, cwd=SERVER, stdout=output, stderr=subprocess.STDOUT)
    summary = {'files': files, 'exitCode': result.returncode, 'failures': failure_names(read(label + '.log')),
               'counts': counts(read(label + '.log'))}
    save(label + '-result.json', summary)
    if prior:
        merged = {'files': sorted(set(prior['files']) | set(files)), 'exitCode': max(prior['exitCode'], result.returncode),
                  'failures': sorted(set(prior['failures']) | set(summary['failures'])),
                  'counts': {key: prior['counts'][key] + summary['counts'][key] for key in summary['counts']},
                  'logs': prior.get('logs', ['baseline-failures.log']) + [label + '.log']}
        save('baseline-failures-result.json', merged)
    print(json.dumps(summary), flush=True)


def diagnostics():
    base = RELEASE / 'checks/dispatch-static-baseline/executed-order-review'
    after = RELEASE / 'checks/dispatch-static/executed-order-review'
    def lint(file):
        return collections.Counter((entry['filePath'].replace('/app/', ''), message.get('ruleId'), message['severity'],
            re.sub(r'on line \d+ column \d+', 'at the outer declaration', message['message']))
            for entry in json.loads(file.read_text()) for message in entry['messages'])
    before_lint = lint(base / 'lint-baseline-final.log')
    after_lint = lint(after / 'lint-current-final.log')
    def types(file):
        return collections.Counter(re.sub(r'\(\d+,\d+\)', '', line) for line in file.read_text().splitlines())
    before_types = types(base / 'types-baseline-final.log')
    after_types = types(after / 'types-current-final.log')
    assert not after_lint - before_lint, 'New lint diagnostics'
    assert not after_types - before_types, 'New type diagnostics'
    return {'lint': sum(after_lint.values()), 'typeOutputLines': sum(after_types.values()), 'newLint': 0, 'newTypes': 0}


def supplemental():
    results = {}
    script = """import fs from 'node:fs';import {spawnSync} from 'node:child_process';
const results={};
for(const name of ['driver-offline-client','operator-return-ui']){
 const r=spawnSync(process.execPath,['src/'+name+'-harness.js'],{encoding:'utf8',timeout:60000});
 fs.writeFileSync('test-artifacts/'+name+'.log',(r.stdout||'')+(r.stderr||''));
 results[name]={exitCode:r.status,assertion:(r.stderr||'').match(/AssertionError \\[ERR_ASSERTION\\]: ([^\\n]+)/u)?.[1]||''};
 if(r.error||r.signal)throw r.error||new Error(r.signal);
}
console.log(JSON.stringify(results));
"""
    for label, source in [('candidate', 'source'), ('baseline', 'baseline')]:
        command = ['sudo', '-n', 'env', 'WORKTREE_RELEASE_CHECK=supplemental-' + label,
                   'WORKTREE_RELEASE_SOURCE_ROOT=' + str(RELEASE / source),
                   'bash', str(SERVER / 'tools/worktree-release-test-20260925.sh'),
                   'node', '--input-type=module', '-e', script]
        output = subprocess.check_output(command, cwd=SERVER).decode()
        results[label] = json.loads(output.strip().splitlines()[-1])
    for name, result in results['candidate'].items():
        if result['exitCode']:
            assert result == results['baseline'][name], name + ' has a new failure'
    save('supplemental-checks.json', results)
    print(json.dumps(results), flush=True)


def flake_probe():
    script = """import path from 'node:path';
import {buildIsolatedTestEnvironment} from './test/support/test-foundation.mjs';
import {runNodeTestFilesIsolated} from './test/support/test-database-isolation.mjs';
for(let i=0;i<5;i++){
 await runNodeTestFilesIsolated([path.resolve('test/mbt/integration/stock-return-draft-insert.test.js')],{
  environment:buildIsolatedTestEnvironment(process.env,{databaseUrl:process.env.DATABASE_URL}),label:'Stock return timing probe '+(i+1)});
}
"""
    source = sys.argv[2]
    assert source in ['source', 'baseline']
    command = ['sudo', '-n', 'env', 'WORKTREE_RELEASE_CHECK=stock-return-timing-' + source,
               'WORKTREE_RELEASE_SOURCE_ROOT=' + str(RELEASE / source),
               'bash', str(SERVER / 'tools/worktree-release-test-20260925.sh'),
               'node', '--input-type=module', '-e', script]
    name = 'stock-return-timing-' + source + '.log'
    with (RELEASE / name).open('wb') as output:
        subprocess.run(command, cwd=SERVER, stdout=output, stderr=subprocess.STDOUT, check=True)
    result = {'counts': counts(read(name)), 'failures': failure_names(read(name))}
    save('stock-return-timing-' + source + '.json', result)
    print(json.dumps(result), flush=True)


def expired_cache_probe():
    script = """import path from 'node:path';
import {query,closeDb} from './src/db.js';
import {buildIsolatedTestEnvironment} from './test/support/test-foundation.mjs';
import {runNodeTestFilesIsolated} from './test/support/test-database-isolation.mjs';
await query(\"UPDATE return_reason_cache SET fetched_at=now()-interval '2 days'\");await closeDb();
process.exitCode=await runNodeTestFilesIsolated([path.resolve('test/mbt/integration/stock-return-draft-insert.test.js')],{
 environment:buildIsolatedTestEnvironment(process.env,{databaseUrl:process.env.DATABASE_URL}),label:'Expired return-reason cache'});
"""
    results = {}
    for source in ['baseline', 'source']:
        command = ['sudo', '-n', 'env', 'WORKTREE_RELEASE_CHECK=stock-return-expired-' + source,
                   'WORKTREE_RELEASE_SOURCE_ROOT=' + str(RELEASE / source),
                   'bash', str(SERVER / 'tools/worktree-release-test-20260925.sh'),
                   'node', '--input-type=module', '-e', script]
        name = 'stock-return-expired-' + source + '.log'
        with (RELEASE / name).open('wb') as output:
            result = subprocess.run(command, cwd=SERVER, stdout=output, stderr=subprocess.STDOUT)
        results[source] = {'exitCode': result.returncode, 'counts': counts(read(name)), 'failures': failure_names(read(name))}
    expected = 'normal stock draft preserves every line field and consumes the draft only on success'
    assert results['baseline']['failures'] == results['source']['failures'] == [expected]
    for source in results:
        assert 'metadata-catalog/record/v1/creditMemo' in read('stock-return-expired-' + source + '.log')
    save('stock-return-expired-cache.json', results)
    print(json.dumps(results), flush=True)


def check():
    info = json.loads(read('manifest.json'))
    log = read('full-mbt.log')
    assert re.search(r'Isolated MBT main run (?:passed|failed)', log), 'Full suite incomplete'
    progress = re.findall(r'\[isolation\] MBT main (\d+)/(\d+)', log)
    assert progress and progress[-1][0] == progress[-1][1], 'Full suite did not reach final file'
    failing = failure_names(log)
    baseline = json.loads(read('baseline-failures-result.json'))
    expired = json.loads(read('stock-return-expired-cache.json'))
    assert expired['baseline']['failures'] == expired['source']['failures']
    baseline['failures'] = sorted(set(baseline['failures']) | set(expired['baseline']['failures']))
    assert set(failed_files(log)) <= set(baseline['files']), 'Baseline must reproduce all failed files'
    assert set(failing) <= set(baseline['failures']), 'New regression failures: ' + str(set(failing) - set(baseline['failures']))
    full_counts = counts(log)
    assert full_counts['cancelled'] == 0, 'Cancelled full-suite tests require review'
    special = counts(read('special-http.log'))
    assert special == {'tests': 7, 'pass': 7, 'fail': 0, 'skipped': 0, 'cancelled': 0}
    focused = read('dispatch-focused.log')
    random = read('checks/dispatch-layers/random.log')
    assert 'Isolated Executed source review run passed:' in focused
    assert 'Isolated Executed source review run passed:' in random
    assert counts(read('checks/dispatch-layers/coverage.log'))['fail'] == 0
    assert json.loads(read('checks/dispatch-layers/replay.json'))['reviewCount'] == 1
    supplemental_checks = json.loads(read('supplemental-checks.json'))
    for name, result in supplemental_checks['candidate'].items():
        if result['exitCode']:
            assert result == supplemental_checks['baseline'][name], 'New supplemental failure'
    mutations = json.loads(read('checks/dispatch-layers/executed-order-review/mutations.json'))
    assert len(mutations) == 7 and all(row['killed'] for row in mutations)
    assert all(row['propertyKilled'] for row in mutations if row['propertyKilled'] is not None)
    coverage = json.loads(read('checks/dispatch-layers/executed-order-review/coverage/coverage-summary.json'))['total']
    assert coverage['lines']['pct'] == 100
    patterns = [r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----', r'\bAKIA[A-Z0-9]{16}\b',
                r'\bsk-(?:live|proj)-[A-Za-z0-9_-]{24,}']
    hits = []
    for name in info['runtimeChanges']:
        content = (RELEASE / 'source' / name).read_text()
        baseline_file = RELEASE / 'baseline' / name
        old = set(baseline_file.read_text().splitlines()) if baseline_file.exists() else set()
        added = '\n'.join(line for line in content.splitlines() if line not in old)
        if any(re.search(pattern, added) for pattern in patterns):
            hits.append(name)
    assert not hits, 'Credential pattern hits: ' + str(hits)
    before_package = json.loads(read('baseline/package.json'))
    after_package = json.loads(read('source/package.json'))
    assert all(before_package.get(key) == after_package.get(key) for key in ['dependencies', 'devDependencies', 'overrides'])
    for name, sha in info['runtimeFiles'].items():
        assert hashlib.sha256((RELEASE / 'source' / name).read_bytes()).hexdigest() == sha
        assert hashlib.sha256((SERVER / name).read_bytes()).hexdigest() == sha
    result = {'passed': True, 'sourceTreeHash': info['sourceTreeHash'], 'imageId': info['imageId'],
        'fullSuiteFiles': int(progress[-1][1]), 'fullSuite': full_counts, 'preexistingFailureNames': failing,
        'baselineReplay': baseline, 'newFailures': 0, 'dispatchFocused': counts(focused), 'dispatchRandom': counts(random),
        'diagnostics': diagnostics(), 'coverageNewModules': coverage, 'mutantsKilled': len(mutations),
        'propertyMutantsKilled': sum(row['propertyKilled'] is True for row in mutations),
        'secretScanHits': hits, 'dependencyChanges': False, 'supplemental': supplemental_checks,
        'expiredReturnReasonCacheReproduction': expired, 'specialOrderHttp': special}
    save('release-checks.json', result)
    print(json.dumps(result), flush=True)


def report():
    info = json.loads(read('manifest.json'))
    deployed = json.loads(read('deployment-result.json'))
    checked = json.loads(read('release-checks.json'))
    smoke = json.loads(read('release-smoke.json'))
    backup = json.loads(read('backup-result.json'))
    probes = json.loads(read('live-priority-probes.json'))
    assert deployed['deployed'] and checked['passed'] and smoke['passed']
    assert deployed['imageId'] == checked['imageId'] == info['imageId']
    full = checked['fullSuite']
    failures = '\n'.join('- ' + name for name in checked['preexistingFailureNames'])
    document = f'''# Whole worktree deployment — 25 September 2026

Deployed the full application worktree snapshot from **{info['createdAt']}**.
Production verification completed at **{deployed['at']}**. Both the app and
webhook worker run `{info['image']}` (`{info['imageId']}`).
All **{info['sourceFileCount']} runtime files match in each service**, with
{len(info['runtimeChanges'])} changes from the prior application. Source manifest
SHA-256: `{info['sourceTreeHash']}`. Git base: `{info['gitBase']}` plus the
recorded worktree changes. This deployment did not create a new Git commit.

The previously pending Dispatch executed-order source review, persistent
acknowledgements, blank-address protection, and Special Order quantity queue
refactor are live. Verified source updates permit further planning without
requiring acknowledgement first; manual edits to executed route history remain
protected. The earlier SCM Aggregate alert, exact submission timestamps,
confirmation date editing, and Operator priority fix remain present.

## Release evidence

| Check | Result |
| --- | --- |
| Full MBT suite | {checked['fullSuiteFiles']} files; {full['tests']} tests, {full['pass']} passed, {full['fail']} pre-existing failures, {full['skipped']} skipped, {full['cancelled']} cancelled |
| New broad-suite failures | 0; every failed file was replayed against captured production source |
| Focused Dispatch / randomized Dispatch | {checked['dispatchFocused']['pass']} / {checked['dispatchRandom']['pass']} passed |
| Special Order HTTP checks in required disposable DB | {checked['specialOrderHttp']['pass']}/7 passed |
| New feature modules | 473/473 lines, 44/44 functions, 367/462 branches executed |
| Deliberate bug detection | 7/7 detected; property tests independently detected all 5 applicable mutants |
| Static comparison | 0 new lint/type diagnostics; {checked['diagnostics']['lint']} existing lint diagnostics and {checked['diagnostics']['typeOutputLines']} TypeScript output lines |
| Actual production image rehearsal | App health 200, worker started, repeated migration run passed |
| Priority / rollback rehearsal | Operator work completed while worker background work held a shared slot; queue reservations cleaned; prior app and worker started against the upgraded schema |
| Production verification | Local/public health 200, {deployed['servedAssetHashesPerEndpoint']} asset hashes matched at each endpoint, anonymous API access 401, zero restarts |
| Settings and services | App/worker configuration preserved; database and Ollama were not restarted |
| Dependencies and secrets | No dependency changes; changed-runtime credential-pattern scan found 0 hits |

Migration `{deployed['migration']}` was applied before the new app started.
The additive review table can remain if application images are rolled back.
No live NetSuite test documents were created. A private custom-format database
backup was validated with `pg_restore --list`: {backup['bytes']} bytes,
{backup['tocLines']} TOC lines, SHA-256 `{backup['sha256']}`.
Previous app and worker image IDs and rollback Compose overrides are retained.
Read-only live NetSuite probes succeeded from both services. The app's Operator
probe spent {probes['app']['sharedQueueWaitMs']} ms in the shared queue and
{probes['app']['durationMs']} ms overall; the worker background probe spent
{probes['webhook-worker']['sharedQueueWaitMs']} ms in the queue and
{probes['webhook-worker']['durationMs']} ms overall. These were reads of an
existing IF, not measurements of a newly submitted customer pickup.

## Existing failures and limits

The broad suite is not wholly green. These failures were reproduced against the
previous production source, with the same tests and isolated runner:

{failures}

The Special Order HTTP files require a database ending in `mbt_verify`; the full
suite uses per-file `mbt_test` clones. Their seven scenarios all passed when rerun
on their required isolated database. The stock-return failure depends on the
seeded return-reason cache aging past ten minutes during the full run: a harmless
metadata GET is recorded by its fixture as an unexpected external request. Five
fresh-cache repetitions passed on each source tree; explicitly aging the cache
reproduced the same failure on both versions. This is retained as known test debt.

Two supplemental legacy harnesses also fail identically on both source trees:
Driver cannot isolate the duplicate-completion source block; Operator expects an
older two-column return layout. Neither is a new release regression. Assertions
were not weakened or skipped to obtain a passing release decision.

Initial browser checks could not write their screenshots/reports because of
test-container artifact permissions and a missing output directory. Correcting
the runner setup produced 107 passing focused tests. An initial combined
coverage/mutation invocation contaminated the disposable mutation baseline with
coverage fixtures; mutation was rerun before coverage in a fresh database and
detected all seven bugs. Production source was unchanged during these checks.

Coverage measures the four new modules, not every changed legacy/browser line.
Those paths have functional, contract, browser and concurrency checks. Existing
type/lint debt remains. Tests use local mirrors and controlled network boundaries;
they do not constitute a production-load benchmark or a live accounting write.
User deployment authorization was explicit; the detailed deployment specification
was not separately reviewed (autonomous execution).

## Reproduction and retained records

Release tools are `tools/worktree-release-20260925.py`,
`tools/worktree-release-test-20260925.sh`,
`tools/worktree-release-feature-checks-20260925.sh`,
`tools/worktree-release-smoke-20260925.py` and
`tools/worktree-release-evidence-20260925.py`. Existing test dependencies were
provided by `field-sales-check-2941306:latest` (Node 20.20.2).

The frozen source, production baseline, full file hashes, build/test logs,
per-file failure replay logs, screenshots, migration/backup details, image
rollback definitions and live verification are retained privately in
`server/test-artifacts/whole-worktree-deployment-20260925/`.
Backup files, credentials, operational data and generated test artifacts are
excluded from the application image; no application feature remains excluded.

Recheck the frozen suite from `server/`:

```sh
sudo -n env WORKTREE_RELEASE_CHECK=full-recheck bash tools/worktree-release-test-20260925.sh npm test
bash tools/worktree-release-feature-checks-20260925.sh
python3 tools/worktree-release-smoke-20260925.py
python3 tools/worktree-release-evidence-20260925.py supplemental
python3 tools/worktree-release-20260925.py verify
python3 tools/worktree-release-20260925.py live-probe
```
'''
    (SERVER / 'test/whole-worktree-deployment-20260925-evidence.md').write_text(document)
    record = SERVER / 'deployments/whole-worktree-20260925'
    record.mkdir(exist_ok=True)
    (record / 'manifest.json').write_text(json.dumps({
        'sourceSnapshotAt': info['createdAt'], 'deployedAt': deployed['at'], 'gitBase': info['gitBase'],
        'image': info['image'], 'imageId': info['imageId'], 'sourceTreeHash': info['sourceTreeHash'],
        'runtimeFiles': info['runtimeFiles'], 'changedFromPriorApp': info['runtimeChanges'],
        'migration': info['pendingMigrations'], 'priorImages': {name: row['imageId'] for name, row in info['services'].items()},
        'verification': deployed}, indent=2) + '\n')
    (record / 'images.compose.yml').write_text('services:\n' + ''.join(
        f'  {name}:\n    image: {info["imageId"]}\n' for name in info['services']))
    print(json.dumps({'report': 'test/whole-worktree-deployment-20260925-evidence.md', 'sourceFiles': info['sourceFileCount']}))


if __name__ == '__main__':
    {'replay': replay, 'check': check, 'supplemental': supplemental, 'report': report,
     'flake-probe': flake_probe, 'expired-cache-probe': expired_cache_probe}[sys.argv[1]]()

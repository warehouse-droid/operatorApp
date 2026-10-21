"""Reproduce and verify the local removal lock fix in disposable bounded tests."""
import difflib
import importlib.util
import io
import json
from pathlib import Path
import random
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import time

SERVER = Path(__file__).resolve().parents[2]
ROOT = SERVER.parent
OUT = SERVER / 'test-artifacts/special-removal-lock-20261016'
RELEASE = SERVER / 'deployments/special-removal-lock-20261016'
PROJECT = 'mbbs-special-removal-lock-20261016'
FILES = ['src/special-stock-local-adjustments.js', 'src/special-stock-request-repository.js']
NEW_UNIT = 'test/mbt/unit/special-local-adjustment-lock.test.js'
INTEGRATION = 'test/mbt/integration/special-local-adjustments.test.js'
UNITS = [NEW_UNIT, 'test/mbt/unit/special-local-adjustments.test.js',
    'test/mbt/unit/special-workflow-quantity-service.test.js',
    'test/mbt/unit/special-workflow-quantity-transition.test.js',
    'test/mbt/unit/special-workflow-quantity-adapter.test.js',
    'test/mbt/unit/special-workflow-adjustments.test.js',
    'test/mbt/unit/special-fulfillment-adapter.test.js',
    'test/mbt/unit/special-approval-fulfillment.test.js']
KNOWN_FAILURES = {
    'all-line removal remains local and completed requests stay locked',
    'property: a real unapproved PO remains Confirmed until approval, except terminal stages'}
spec = importlib.util.spec_from_file_location('removal_release_core', SERVER / 'tools/delivery-scm-release.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
OUT.mkdir(parents=True, exist_ok=True)


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def capture():
    RELEASE.mkdir(parents=True, exist_ok=False)
    before = RELEASE / 'before'
    before.mkdir()
    state = {'app': core.metadata(core.APP), 'dependencies': [core.metadata(n) for n in core.DEPENDENCIES]}
    archive = core.docker('exec', core.APP, 'tar', '-cf', '-', '-C', '/app',
        'src', 'public', 'migrations', 'package.json', 'package-lock.json', 'netsuite-smart-scm-picking-ticket-restlet.js')
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(before, filter='data')
    assert core.metadata(core.APP) == state['app']
    state['beforeTree'] = core.files_at(before)
    save(RELEASE / 'manifest.json', state)
    print(json.dumps({'captured': True, 'image': state['app']['imageId'], 'files': len(state['beforeTree'])}), flush=True)


def stage():
    candidate = RELEASE / 'candidate'
    if candidate.exists():
        shutil.rmtree(candidate)
    shutil.copytree(RELEASE / 'before', candidate)
    patch = ''.join(''.join(difflib.unified_diff(
        (OUT / 'workspace-before' / name).read_text().splitlines(True),
        (SERVER / name).read_text().splitlines(True), fromfile='a/' + name, tofile='b/' + name)) for name in FILES)
    (RELEASE / 'changes.patch').write_text(patch)
    result = subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-d', str(candidate)],
        input=patch, text=True, capture_output=True, check=True)
    (RELEASE / 'patch.log').write_text(result.stdout + result.stderr)
    for p in candidate.rglob('*.orig'):
        p.unlink()
    state = json.loads((RELEASE / 'manifest.json').read_text())
    state['candidateTree'] = core.files_at(candidate)
    changed = sorted(n for n in state['beforeTree'] if state['beforeTree'][n] != state['candidateTree'][n])
    assert changed == sorted(FILES)
    state['sourceHashes'] = {n: state['candidateTree'][n] for n in FILES}
    state['workspaceHashes'] = {n: core.sha((SERVER / n).read_bytes()) for n in FILES}
    save(RELEASE / 'manifest.json', state)
    print(json.dumps({'staged': True, 'files': changed}), flush=True)


def rebase():
    previous = json.loads((RELEASE / 'manifest.json').read_text())
    state = {'app': core.metadata(core.APP), 'dependencies': [core.metadata(n) for n in core.DEPENDENCIES]}
    assert state['dependencies'] == previous['dependencies']
    fresh = RELEASE / 'fresh-before'
    fresh.mkdir(exist_ok=False)
    archive = core.docker('exec', core.APP, 'tar', '-cf', '-', '-C', '/app',
        'src', 'public', 'migrations', 'package.json', 'package-lock.json', 'netsuite-smart-scm-picking-ticket-restlet.js')
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(fresh, filter='data')
    state['beforeTree'] = core.files_at(fresh)
    assert core.metadata(core.APP) == state['app']
    assert all(state['beforeTree'][name] == previous['beforeTree'][name] for name in FILES), 'Target files changed; manual merge required'
    saved = RELEASE / ('previous-capture-' + str(time.time_ns()))
    saved.mkdir()
    for name in ['before', 'candidate', 'manifest.json', 'changes.patch', 'patch.log']:
        shutil.move(RELEASE / name, saved / name)
    shutil.move(fresh, RELEASE / 'before')
    save(RELEASE / 'manifest.json', state)
    stage()
    print(json.dumps({'rebased': True, 'image': state['app']['imageId']}), flush=True)


def check(mode):
    source = RELEASE / ('before' if mode == 'red' else 'candidate')
    runout = OUT / mode
    if runout.exists():
        archive = OUT / 'attempts' / (mode + '-' + str(time.time_ns()))
        archive.parent.mkdir(exist_ok=True)
        shutil.move(runout, archive)
    runout.mkdir()
    labels = {'com.mbbs.lifecycle': 'disposable-test', 'com.mbbs.task': PROJECT}
    mounts = [f'{source / p}:/app/{p}:ro' for p in ['src', 'public', 'migrations', 'package.json', 'netsuite-smart-scm-picking-ticket-restlet.js']]
    mounts += [f'{SERVER / p}:/app/{p}:ro' for p in ['test', 'tools', 'contracts']]
    mounts += [f'{SERVER / "test-artifacts/driver-upload-reliability/toolchain/node_modules"}:/app/node_modules:ro']
    service = {'image': 'mbbs-to-yard-test-browser:20261009', 'pull_policy': 'never',
        'working_dir': '/app', 'user': '1000:1000', 'labels': labels, 'volumes': mounts,
        'environment': {'DATABASE_URL': 'postgres://mbt_test:mbt_test_password@db:5432/mbt_test',
            'PLAYWRIGHT_BROWSERS_PATH': '/ms-playwright', 'XDG_CONFIG_HOME': '/tmp/removal-config',
            'XDG_CACHE_HOME': '/tmp/removal-cache'}}
    config = runout / 'compose.json'
    save(config, {'services': {'db': {'labels': labels}, 'test': service, 'migrate': service}})
    compose = ['docker', 'compose', '--project-name', PROJECT, '--project-directory', str(ROOT),
        '-f', str(ROOT / 'docker-compose.mbt-test.yml'), '-f', str(config)]
    results = {}

    def run(label, args, expected=0):
        with (runout / (label + '.log')).open('w') as log:
            result = subprocess.run(args, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
        results[label] = result.returncode
        print(json.dumps({'check': label, 'exit': result.returncode}), flush=True)
        if result.returncode != expected:
            print((runout / (label + '.log')).read_text()[-5000:], flush=True)
        assert result.returncode == expected, label + ' failed'

    def node(label, args, expected=0, extra=()):
        run(label, compose + ['run', '--rm', '--no-deps', '-T', *extra, 'test', 'node', *args], expected)

    def failures(label, expected):
        actual = set(re.findall(r'^not ok \d+ - (.+)$', (runout / (label + '.log')).read_text(), re.M))
        assert actual == expected, label + ': unexpected test failures ' + str(actual ^ expected)
        save(runout / (label + '-failures.json'), {'failures': sorted(actual), 'newFailures': []})

    try:
        run('resource-policy', ['python3', 'docker/verify-memory-limits.py'])
        run('db', compose + ['up', '-d', '--wait', '--wait-timeout', '45', '--no-build', '--pull', 'never', 'db'])
        run('migrate', compose + ['run', '--rm', '--no-deps', '-T', 'migrate'])
        if mode == 'red':
            node('red-unit', ['--test', NEW_UNIT], expected=1)
            node('red-integration', ['--test', '--test-name-pattern=unprepared delivery failure', INTEGRATION], expected=1)
            node('red-http', ['--test', '--test-name-pattern=unprepared delivery failure',
                'test/mbt/integration/special-workflow-pricing-http.test.js'], expected=1)
            node('baseline', ['--test', '--test-concurrency=1', *UNITS[1:], INTEGRATION,
                'test/mbt/integration/special-approval-fulfillment.test.js'], expected=1)
            failures('baseline', KNOWN_FAILURES | {'unprepared delivery failure permits local removal through SCM while preserving the failed journal and issued orders'})
            return
        tests = [*UNITS, INTEGRATION, 'test/mbt/integration/special-approval-fulfillment.test.js']
        coverage_dir = 'test-artifacts/special-removal-lock-20261016/' + mode + '/coverage'
        node('suite', ['node_modules/c8/bin/c8.js', '--include=src/special-stock-local-adjustments.js',
            '--include=src/special-stock-request-repository.js', '--temp-directory=/tmp/removal-coverage',
            '--report-dir=' + coverage_dir, '--reporter=json', '--reporter=text',
            'node', '--test', '--test-concurrency=1', *tests], expected=1)
        failures('suite', KNOWN_FAILURES)
        node('http', ['--test', '--test-name-pattern=local issued request removal|unprepared delivery failure',
            'test/mbt/integration/special-workflow-pricing-http.test.js'])
        node('syntax', ['--check', FILES[0]])
        node('repository-syntax', ['--check', FILES[1]])
        node('types', ['node_modules/typescript/bin/tsc', '--allowJs', '--checkJs', '--noEmit', '--skipLibCheck',
            '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2023', FILES[0]])
        node('lint', ['node_modules/eslint/bin/eslint.js', '--config',
            'tools/special-local-adjustments-20261013/eslint.config.js', '--max-warnings=0', *FILES, NEW_UNIT, INTEGRATION])
        changed_coverage(source, runout)
        mutants = [
            ('block-unprepared', "(!localOnly || Boolean(change.plan))", 'true'),
            ('allow-saved-plan', "(!localOnly || Boolean(change.plan))", '!localOnly'),
            ('allow-applying', "change?.status === 'applying'", 'false'),
            ('unlock-remote', "(!localOnly || Boolean(change.plan))", 'Boolean(change.plan)')]
        original = (source / FILES[0]).read_text()
        mutation_results = []
        for name, old, new in mutants:
            assert original.count(old) == 1, name
            mutant = runout / (name + '.js')
            mutant.write_text(original.replace(old, new))
            mount = ['-v', str(mutant) + ':/app/' + FILES[0] + ':ro']
            node('mutant-' + name, ['--test', NEW_UNIT], expected=1, extra=mount)
            node('property-mutant-' + name, ['--test', '--test-name-pattern=property:', NEW_UNIT], expected=1, extra=mount)
            if name in ('allow-applying', 'allow-saved-plan'):
                node('integration-mutant-' + name, ['--test', '--test-name-pattern=delivery locks remain enforced', INTEGRATION], expected=1, extra=mount)
            mutation_results.append({'name': name, 'killed': True, 'propertyKilled': True})
        save(runout / 'mutations.json', mutation_results)
        shuffled = tests.copy()
        random.Random(631016).shuffle(shuffled)
        node('suite-order', ['--test', '--test-concurrency=1', *shuffled], expected=1)
        failures('suite-order', KNOWN_FAILURES)
        node('versions', ['--input-type=module', '-e',
            "import fs from 'node:fs'; console.log(JSON.stringify({node:process.version,...Object.fromEntries(['fast-check','c8','typescript','eslint'].map(n=>[n,JSON.parse(fs.readFileSync('node_modules/'+n+'/package.json')).version]))}))"])
        state = json.loads((RELEASE / 'manifest.json').read_text())
        assert core.files_at(source) == state['candidateTree']
        save(runout / 'verified.json', {'passed': True, 'sourceHashes': state['sourceHashes'], 'checks': results,
            'testHashes': {n: core.sha((SERVER / n).read_bytes()) for n in tests}, 'shuffleSeed': 631016})
    finally:
        run('teardown', compose + ['--profile', '*', 'down', '--volumes', '--remove-orphans'])
        active = core.docker('ps', '--format', '{{.Names}} {{.Status}}').decode()
        all_containers = core.docker('ps', '-a', '--format', '{{.Names}} {{.Status}}').decode()
        (runout / 'docker-ps.log').write_text(active)
        (runout / 'docker-ps-a.log').write_text(all_containers)
        cleanup = {'containers': core.docker('ps', '-a', '--filter', 'label=com.mbbs.lifecycle=disposable-test', '--format', '{{.Names}}').decode().strip(),
            'networks': core.docker('network', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}').decode().strip(),
            'volumes': core.docker('volume', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}').decode().strip(),
            'productionHealth': core.docker('inspect', '--format', '{{.State.Health.Status}}', core.APP).decode().strip()}
        save(runout / 'cleanup.json', cleanup)
        save(runout / 'checks.json', results)
        assert not cleanup['containers'] and not cleanup['networks'] and not cleanup['volumes']
        assert cleanup['productionHealth'] == 'healthy'


def changed_coverage(source, runout):
    data = json.loads((runout / 'coverage/coverage-final.json').read_text())
    measured, uncovered = [], []
    for name in FILES:
        before = (RELEASE / 'before' / name).read_text().splitlines()
        after = (source / name).read_text().splitlines()
        changed = set()
        for tag, _a, _b, c, d in difflib.SequenceMatcher(None, before, after).get_opcodes():
            if tag in ('insert', 'replace'):
                changed.update(range(c + 1, d + 1))
        cov = data['/app/' + name]
        for line in sorted(changed):
            hits = [cov['s'][key] for key, span in cov['statementMap'].items()
                if span['start']['line'] <= line <= span['end']['line']]
            if not hits or not after[line - 1].strip() or after[line - 1].lstrip().startswith(('/**', '*', '//')):
                continue
            (measured if any(hits) else uncovered).append(name + ':' + str(line))
    save(runout / 'changed-coverage.json', {'covered': measured, 'uncovered': uncovered})
    assert not uncovered, 'Changed code is untested: ' + str(uncovered)


def interrupted(_signal, _frame):
    raise KeyboardInterrupt('Remove disposable tests before exiting')


signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
if __name__ == '__main__':
    mode = sys.argv[1]
    if mode == 'capture':
        capture()
    elif mode == 'stage':
        stage()
    elif mode == 'rebase':
        rebase()
    else:
        check(mode)

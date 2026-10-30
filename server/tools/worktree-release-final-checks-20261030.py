"""Focused gauntlet plus actual-image startup/rollback, with unconditional teardown."""
import difflib
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import time

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('release_checks', HERE / 'worktree-release-checks-20261030.py')
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)
ROOT, SERVER, ARTIFACT = checks.ROOT, checks.SERVER, checks.ARTIFACT
OUT = SERVER / 'deployments/whole-worktree-20261030'


def run(*args, **kw):
    return subprocess.run(args, cwd=ROOT, check=True, capture_output=True, **kw).stdout


def smoke(compose, candidate, before):
    images = {'candidate': {'app': candidate, 'webhook-worker': candidate},
              'rollback': {'app': before[0]['Image'], 'webhook-worker': before[1]['Image']}}
    results = []
    for mode, services in images.items():
        override = ARTIFACT / (mode + '-smoke.json')
        override.write_text(json.dumps({'services': {
            'app': {'image': services['app'], 'mem_limit': '1g', 'memswap_limit': '1g', 'mem_reservation': '256m',
                    'labels': {'com.mbbs.lifecycle': 'disposable-test'}},
            'webhook-worker': {'image': services['webhook-worker'], 'mem_limit': '768m', 'memswap_limit': '768m',
                    'mem_reservation': '256m', 'labels': {'com.mbbs.lifecycle': 'disposable-test'}}}}))
        command = checks.COMPOSE + ['-f', str(override)]
        code, output = checks.logged(command + ['up', '-d', '--no-build', '--no-deps', '--wait', 'app', 'webhook-worker'], mode + '-startup', 180)
        if code: raise RuntimeError(output[-6000:])
        time.sleep(5)
        ids = run(*command, 'ps', '-q', 'app', 'webhook-worker').decode().split()
        rows = json.loads(run('docker', 'inspect', *ids))
        assert len(rows) == 2
        app = next(r for r in rows if r['Config']['Labels']['com.docker.compose.service'] == 'app')
        worker = next(r for r in rows if r['Config']['Labels']['com.docker.compose.service'] == 'webhook-worker')
        for name, row in [('app', app), ('webhook-worker', worker)]:
            assert row['Image'] == services[name] and row['State']['Running'] and row['RestartCount'] == 0
        health_script = "const r=await fetch('http://127.0.0.1:3000/health');const body=await r.json();if(r.status!==200||body.ok!==true)throw Error('Health failed');const a=await fetch('http://127.0.0.1:3000/api/operator/preferences');if(![401,403].includes(a.status))throw Error('Anonymous API boundary failed: '+a.status);console.log(JSON.stringify({health:r.status,anonymousApi:a.status}));"
        health = json.loads(run('docker', 'exec', app['Id'], 'node', '--input-type=module', '-e', health_script))
        logs = subprocess.run(['docker', 'logs', worker['Id']], capture_output=True, text=True, check=True)
        assert 'NetSuite order webhook serial worker' in logs.stdout + logs.stderr
        detail = {'mode': mode, 'appStarted': True, 'workerStarted': True, **health}
        if mode == 'candidate':
            actual_env = dict(entry.split('=', 1) for entry in worker['Config']['Env'])
            assert actual_env.get('PLAYWRIGHT_BROWSERS_PATH') == '/ms-playwright'
            detail['workerImageEnvironmentDefaults'] = {'PLAYWRIGHT_BROWSERS_PATH': '/ms-playwright'}
            manifest = json.loads((OUT / 'manifest.json').read_text())
            hash_js = "const fs=require('fs'),crypto=require('crypto');process.stdout.write(JSON.stringify(Object.fromEntries(JSON.parse(fs.readFileSync(0,'utf8')).map(p=>[p,crypto.createHash('sha256').update(fs.readFileSync('/app/'+p)).digest('hex')]))));"
            for row in [app, worker]:
                hashes = json.loads(run('docker', 'exec', '-i', row['Id'], 'node', '-e', hash_js,
                    input=json.dumps(list(manifest['runtimeHashes'])).encode()))
                assert hashes == manifest['runtimeHashes']
            detail['runtimeFilesPerService'] = len(manifest['runtimeHashes'])
        results.append(detail)
        checks.emit(detail)
    return results


def main():
    signal.signal(signal.SIGTERM, checks.interrupt)
    signal.signal(signal.SIGINT, checks.interrupt)
    ARTIFACT.chmod(0o777)
    command = checks.config(SERVER, 'focused')
    manifest = json.loads((OUT / 'manifest.json').read_text())
    before = json.loads((OUT / 'containers.before.private.json').read_text())
    completed = False
    try:
        run('python3', 'docker/verify-memory-limits.py')
        code, output = checks.logged(command + ['up', '-d', '--wait', 'db'], 'database', 120)
        if code: raise RuntimeError(output[-5000:])
        code, output = checks.logged(command + ['run', '--rm', '--no-deps', '-T', 'migrate'], 'migrate', 600)
        if code: raise RuntimeError(output[-5000:])
        if os.environ.get('WORKTREE_SMOKE_ONLY') == '1':
            results = smoke(command, manifest['imageId'], before)
            (OUT / 'smoke.json').write_text(json.dumps({'passed': True, 'imageId': manifest['imageId'],
                'scenarios': results}, indent=2) + '\n')
            completed = True
            return
        code, output = checks.logged(command + ['run', '--rm', '--no-deps', '-T', 'test', 'node', 'tools/worktree-focused-20261030.mjs'], 'focused', 1800)
        report_path = ARTIFACT / 'focused-report.json'
        if report_path.exists():
            report = json.loads(report_path.read_text())
            coverage = report.pop('coverage', {})
            report['coverageByFile'] = {name.removeprefix('/app/'): value['lines'] for name, value in coverage.items() if name != 'total'}
            final_coverage = ARTIFACT / 'coverage/coverage-final.json'
            if final_coverage.exists():
                measured = json.loads(final_coverage.read_text())
                files = list(report['sourceHashes'])
                read_js = "const fs=require('fs');process.stdout.write(JSON.stringify(Object.fromEntries(JSON.parse(process.argv[1]).map(p=>[p,fs.readFileSync('/app/'+p,'utf8')]))));"
                previous = json.loads(run('docker', 'exec', 'mbbs-operator-app-app-1', 'node', '-e', read_js, json.dumps(files)))
                changed_coverage = {}
                for name in files:
                    data = measured.get('/app/' + name)
                    if data is None: continue
                    current_lines = (SERVER / name).read_text().splitlines()
                    changed = set()
                    for kind, _, _, first, last in difflib.SequenceMatcher(a=previous[name].splitlines(), b=current_lines, autojunk=False).get_opcodes():
                        if kind in ['insert', 'replace']: changed.update(range(first + 1, last + 1))
                    hits = {}
                    for key, statement in data['statementMap'].items():
                        line = statement['start']['line']
                        hits[line] = max(hits.get(line, 0), data['s'][key])
                    executable = [line for line in sorted(changed) if line in hits and current_lines[line - 1].strip()
                                  and not current_lines[line - 1].lstrip().startswith(('//', '/*', '*'))]
                    changed_coverage[name] = {'covered': sum(hits[line] > 0 for line in executable),
                                             'total': len(executable), 'uncoveredLines': [line for line in executable if hits[line] == 0]}
                report['changedLineCoverage'] = changed_coverage
            (SERVER / 'test/whole-worktree-deployment-20261030-focused.json').write_text(json.dumps(report, indent=2) + '\n')
        if code: raise RuntimeError(output[-9000:])
        previous_smoke = OUT / 'smoke.json'
        prior_result = json.loads(previous_smoke.read_text()) if previous_smoke.exists() else {}
        if prior_result.get('passed') and prior_result.get('imageId') == manifest['imageId']:
            results = prior_result['scenarios']
        else:
            results = smoke(command, manifest['imageId'], before)
        result = {'passed': True, 'imageId': manifest['imageId'], 'scenarios': results}
        (OUT / 'smoke.json').write_text(json.dumps(result, indent=2) + '\n')
        completed = True
    finally:
        # Include runtime-profile services created with separate overrides.
        cleanup = subprocess.run(command + ['--profile', 'runtime', '--profile', 'webhook-stress',
            'down', '--volumes', '--remove-orphans'], cwd=ROOT, capture_output=True, text=True)
        leftovers = []
        for kind in ['container', 'volume', 'network']:
            args = ['docker', kind, 'ls', '-q'] + (['-a'] if kind == 'container' else [])
            leftovers += run(*args, '--filter', 'label=com.docker.compose.project=' + checks.PROJECT).decode().split()
        for args in [['docker', 'ps'], ['docker', 'ps', '-a']]:
            print(run(*args, '--format', '{{.Names}} {{.Status}}').decode(), flush=True)
        run('curl', '-fsS', '-o', '/dev/null', 'http://127.0.0.1:3000/health')
        assert cleanup.returncode == 0 and not leftovers, 'Test cleanup failed'
        checks.emit({'finalChecksPassed': completed, 'testCleanupPassed': True})


if __name__ == '__main__':
    main()

"""Publish the aggregate schedule labels as a three-file UI overlay."""
import difflib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('reconciliation_operations', Path(__file__).with_name('reconciliation-blockers-deploy.py'))
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)
ops.STATE = ROOT / 'server/deployments/aggregate-nightly-labels-20261022'
ops.TAG = 'mbbs-operator-app:aggregate-nightly-labels-20261022'
ops.ROLLBACK = 'mbbs-operator-app:aggregate-nightly-labels-rollback-20261022'
FILES = ['public/control.js', 'public/admin.html', 'public/control.html']
VERSION = '20261022-aggregate-nightly-labels-v1'


def prepare():
    before = ops.inspect(ops.APP)
    ops.save('release-before.private.json', before)
    ops.save('other-services.private.json', [ops.inspect(name) for name in [
        'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1']])
    candidate = ops.STATE / 'candidate'
    candidate.mkdir()
    changes = []
    for name in FILES:
        target = candidate / name
        target.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(['docker', 'cp', f'{ops.APP}:/app/{name}', str(target)], check=True)
        previous = (ops.STATE / 'workspace-before' / name).read_text()
        current = (ROOT / 'server' / name).read_text()
        changes.extend(difflib.unified_diff(previous.splitlines(True), current.splitlines(True),
                                            fromfile='a/' + name, tofile='b/' + name))
    patch = ''.join(changes)
    (ops.STATE / 'application.patch').write_text(patch)
    subprocess.run(['patch', '--batch', '--forward', '--fuzz=0', '-p1', '-d', str(candidate)], input=patch, text=True, check=True)
    # The rendered reconciliation section must be exactly the validated workspace section.
    def section(path):
        text = path.read_text()
        return text[text.index('function renderAggregateNightlySettings()'):text.index('function renderScmReconciliationSyncLink()')]
    assert section(candidate / FILES[0]) == section(ROOT / 'server' / FILES[0])
    subprocess.run(['docker', 'tag', before['Image'], ops.ROLLBACK], check=True)
    (ops.STATE / 'Dockerfile').write_text(f'FROM {ops.ROLLBACK}\nCOPY --chown=node:node candidate/ /app/\n')
    (ops.STATE / '.dockerignore').write_text('*\n!Dockerfile\n!candidate/\n!candidate/**\n')
    subprocess.run(['docker', 'build', '--network=none', '-t', ops.TAG, str(ops.STATE)], check=True)
    for kind, image in [('release', ops.TAG), ('rollback', ops.ROLLBACK)]:
        ops.save(f'compose.{kind}.json', {'services': {'app': {'image': image, 'pull_policy': 'never'}}})
    configured = json.loads(ops.run(ops.compose(before, 'compose.release.json') + ['config', '--format', 'json']))
    ops.save('compose.resolved.private.json', configured)
    environment = dict(value.split('=', 1) for value in ops.inspect(ops.TAG)['Config']['Env'])
    environment.update({key: str(value) for key, value in configured['services']['app'].get('environment', {}).items()})
    assert environment == dict(value.split('=', 1) for value in before['Config']['Env']), 'Runtime configuration changed'
    ops.save('manifest.json', {'baseImage': before['Image'], 'image': ops.inspect(ops.TAG)['Id'],
                             'hashes': {name: ops.digest(candidate / name) for name in FILES},
                             'workspaceHashes': {name: ops.digest(ROOT / 'server' / name) for name in FILES}})
    print('Prepared three-file UI overlay with unchanged runtime configuration.', flush=True)


def verify():
    ops.verify()
    manifest = json.loads((ops.STATE / 'manifest.json').read_text())
    results = []
    for origin in ['http://127.0.0.1:3000', 'https://test.mbbsoperation.com']:
        for path, name in [('/admin/reconciliation', 'public/admin.html'),
                           ('/control.html', 'public/control.html'),
                           ('/control.js?v=' + VERSION, 'public/control.js')]:
            served = subprocess.check_output(['curl', '-fsS', '--max-time', '20', origin + path])
            import hashlib
            assert hashlib.sha256(served).hexdigest() == manifest['hashes'][name], 'Served UI mismatch: ' + origin + path
            results.append({'url': origin + path, 'hashMatches': True})
    ops.save('http-verification.json', results)
    print('Verified updated UI and script version on local and public URLs.', flush=True)


def deploy():
    validation = json.loads((ops.STATE / 'validation.json').read_text())
    assert validation['passed'] and validation['cleanupVerified']
    manifest = json.loads((ops.STATE / 'manifest.json').read_text())
    assert validation['workspaceHashes'] == manifest['workspaceHashes']
    assert manifest['workspaceHashes'] == {name: ops.digest(ROOT / 'server' / name) for name in FILES}
    before = json.loads((ops.STATE / 'release-before.private.json').read_text())
    assert ops.inspect(ops.APP)['Image'] == before['Image'], 'Live image changed; rebase before deployment'
    result = ops.sql("BEGIN READ ONLY; SET LOCAL statement_timeout='10s'; SELECT json_build_object('reconciliation',(SELECT count(*) FROM scm_reconciliation_runs WHERE status IN ('queued','running')),'posting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing'))); COMMIT;")
    active = next(json.loads(line) for line in result.splitlines() if line.startswith('{'))
    assert active == {'reconciliation': 0, 'posting': 0}, f'Active work: {active}'
    ops.save('active-before-release.json', active)
    try:
        subprocess.run(ops.compose(before, 'compose.release.json') + ['up', '-d', '--no-deps', '--no-build', 'app'], check=True)
        for _ in range(55):
            if ops.inspect(ops.APP)['State'].get('Health', {}).get('Status') == 'healthy':
                break
            time.sleep(1)
        else:
            raise RuntimeError('App did not become healthy')
        verify()
    except BaseException:
        subprocess.run(ops.compose(before, 'compose.rollback.json') + ['up', '-d', '--no-deps', '--no-build', 'app'], check=True)
        raise


if __name__ == '__main__':
    os.umask(0o077)
    {'prepare': prepare, 'deploy': deploy, 'verify': verify}[sys.argv[1]]()

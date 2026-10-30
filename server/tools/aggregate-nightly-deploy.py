"""Apply only the tested nightly/Operator delta over the current live image."""
import difflib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('reconciliation_operations', Path(__file__).with_name('reconciliation-blockers-deploy.py'))
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)
ops.STATE = ROOT / 'server/deployments/aggregate-nightly-20261022'
ops.TAG = 'mbbs-operator-app:aggregate-nightly-20261022'
ops.ROLLBACK = 'mbbs-operator-app:aggregate-nightly-rollback-20261022'
NEW = ['src/aggregate-reconciliation.js', 'src/aggregate-reconciliation-repository.js',
       'src/aggregate-reconciliation-service.js', 'src/applied-sales-order-billing.js',
       'migrations/305_aggregate_nightly_reconciliation.sql']


def evidence():
    result = json.loads((ROOT / 'server/test/aggregate-nightly-evidence.json').read_text())
    assert result['suite']['fail'] == 0 and result['suite']['skipped'] == 0
    assert result['lint']['added'] == 0 and all(row['killed'] for row in result['mutation'])
    for name, expected in result['sourceHashes'].items():
        assert ops.digest(ROOT / 'server' / name) == expected, f'Untested change: {name}'


def prepare():
    evidence()
    before = ops.inspect(ops.APP)
    ops.save('release-before.private.json', before)
    ops.save('other-services.private.json', [ops.inspect(name) for name in [
        'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1']])
    candidate = ops.STATE / 'candidate'
    assert not candidate.exists(), 'A prepared release already exists'
    names = list(json.loads((ops.STATE / 'source-before.json').read_text()))
    changes = []
    for name in names:
        target = candidate / name
        target.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(['docker', 'cp', f'{ops.APP}:/app/{name}', str(target)], check=True)
        old = (ops.STATE / 'workspace-before' / name).read_text()
        final = (ROOT / 'server' / name).read_text()
        changes.extend(difflib.unified_diff(old.splitlines(True), final.splitlines(True), fromfile='a/'+name, tofile='b/'+name))
    patch = ''.join(changes)
    (ops.STATE / 'application.patch').write_text(patch)
    subprocess.run(['patch', '--batch', '--forward', '--fuzz=0', '-p1', '-d', str(candidate)], input=patch, text=True, check=True)
    for name in NEW:
        (candidate / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / 'server' / name, candidate / name)
    subprocess.run(['docker', 'tag', before['Image'], ops.ROLLBACK], check=True)
    (ops.STATE / 'Dockerfile').write_text(f'FROM {ops.ROLLBACK}\nCOPY --chown=node:node candidate/ /app/\n')
    (ops.STATE / '.dockerignore').write_text('*\n!Dockerfile\n!candidate/\n!candidate/**\n')
    subprocess.run(['docker', 'build', '-t', ops.TAG, str(ops.STATE)], check=True)
    for kind, image in [('release', ops.TAG), ('rollback', ops.ROLLBACK)]:
        ops.save(f'compose.{kind}.json', {'services': {'app': {'image': image, 'pull_policy': 'never'}}})
    configured = json.loads(ops.run(ops.compose(before, 'compose.release.json') + ['config', '--format', 'json']))
    ops.save('compose.resolved.private.json', configured)
    environment = dict(value.split('=', 1) for value in ops.inspect(ops.TAG)['Config']['Env'])
    environment.update({key: str(value) for key, value in configured['services']['app'].get('environment', {}).items()})
    assert environment == dict(value.split('=', 1) for value in before['Config']['Env']), 'Runtime configuration changed'
    ops.save('manifest.json', {'baseImage': before['Image'], 'image': ops.inspect(ops.TAG)['Id'],
                             'hashes': {name: ops.digest(candidate / name) for name in names + NEW}})
    print('Prepared scoped overlay with unchanged configuration and rollback image.', flush=True)


def deploy():
    evidence()
    before = json.loads((ops.STATE / 'release-before.private.json').read_text())
    assert ops.inspect(ops.APP)['Image'] == before['Image'], 'Live release changed; rebase before deployment'
    result = ops.sql("BEGIN READ ONLY; SET LOCAL statement_timeout='10s'; SELECT json_build_object('reconciliation',(SELECT count(*) FROM scm_reconciliation_runs WHERE status IN ('queued','running')),'posting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing'))); COMMIT;")
    active = next(json.loads(line) for line in result.splitlines() if line.startswith('{'))
    assert active == {'reconciliation': 0, 'posting': 0}, f'Active work: {active}'
    ops.save('settings-before.json', json.loads(next(line for line in ops.sql('SELECT row_to_json(s) FROM scm_reconciliation_settings s;').splitlines() if line.startswith('{'))))
    migration = (ops.STATE / 'candidate' / NEW[-1]).read_text()
    ops.sql("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='20s';\n" + migration
            + "\nINSERT INTO schema_migrations(filename) VALUES ('305_aggregate_nightly_reconciliation.sql'); COMMIT;")
    try:
        subprocess.run(ops.compose(before, 'compose.release.json') + ['up', '-d', '--no-deps', '--no-build', 'app'], check=True)
        for _ in range(55):
            if ops.inspect(ops.APP)['State'].get('Health', {}).get('Status') == 'healthy':
                break
            time.sleep(1)
        else:
            raise RuntimeError('New app did not become healthy')
        ops.verify()
    except Exception:
        subprocess.run(ops.compose(before, 'compose.rollback.json') + ['up', '-d', '--no-deps', '--no-build', 'app'], check=True)
        raise


def enable():
    ops.verify()
    program = (ROOT / 'server/tools/aggregate-nightly-enable.mjs').read_text().replace("from '../src/", "from './src/")
    output = ops.run(['docker', 'exec', '-i', '-w', '/app', ops.APP, 'node', '--input-type=module'], input=program)
    result = json.loads(output)
    ops.save('enabled.json', result)
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    os.umask(0o077)
    {'prepare': prepare, 'deploy': deploy, 'verify': ops.verify, 'enable': enable}[sys.argv[1]]()

"""Deploy the response-sharing fix over the exact live image, with rollback."""
import datetime
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
ops.STATE = ROOT / 'server/deployments/reconciliation-run-5825-20261022'
ops.TAG = 'mbbs-operator-app:reconciliation-run-5825-20261022'
ops.ROLLBACK = 'mbbs-operator-app:reconciliation-run-5825-rollback-20261022'
FILES = ['src/server.js', 'src/shared-json-read.js']


def evidence():
    result = json.loads((ROOT / 'server/test/reconciliation-run-5825-evidence.json').read_text())
    assert result['suite']['fail'] == 0 and result['suite']['skipped'] == 0
    assert result['lint']['added'] == 0 and all(row['killed'] for row in result['mutation'])
    for name, expected in result['sourceHashes'].items():
        assert ops.digest(ROOT / 'server' / name) == expected, f'Untested change: {name}'
    return result


def prepare():
    evidence()
    before = ops.inspect(ops.APP)
    ops.save('release-before.private.json', before)
    ops.save('other-services.private.json', [ops.inspect(name) for name in [
        'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1']])
    candidate = ops.STATE / 'candidate'
    assert not candidate.exists(), 'Prepared release already exists'
    (candidate / 'src').mkdir(parents=True)
    subprocess.run(['docker', 'cp', f'{ops.APP}:/app/src/server.js', str(candidate / 'src/server.js')], check=True)
    live = (candidate / 'src/server.js').read_text()
    assert 'createSharedJsonRead' not in live
    route = 'app.get("/api/dispatch/planned-assignments", async (req, res, next) => {'
    old = '    res.json(await listDispatchPlannedAssignments({ includeSnapshots: req.query.includeSnapshots !== "false" }));'
    new = '    const response = await readPlannedAssignmentsResponse(req.query.includeSnapshots !== "false");\n    res.set("Content-Type", "application/json; charset=utf-8");\n    res.set("ETag", response.etag).send(response.body);'
    assert live.count(route) == 1 and live.count(old) == 1
    changed = 'import { createSharedJsonRead } from "./shared-json-read.js";\n' + live.replace(
        route, 'const readPlannedAssignmentsResponse = createSharedJsonRead(listDispatchPlannedAssignments);\n\n' + route).replace(old, new)
    (candidate / 'src/server.js').write_text(changed)
    shutil.copy2(ROOT / 'server/src/shared-json-read.js', candidate / 'src/shared-json-read.js')
    (ops.STATE / 'application.patch').write_text(''.join(difflib.unified_diff(live.splitlines(True), changed.splitlines(True), fromfile='a/src/server.js', tofile='b/src/server.js')))
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
                             'hashes': {name: ops.digest(candidate / name) for name in FILES}})
    print('Prepared two-file overlay; runtime configuration preserved; rollback ready.', flush=True)


def deploy():
    evidence()
    before = json.loads((ops.STATE / 'release-before.private.json').read_text())
    assert ops.inspect(ops.APP)['Image'] == before['Image'], 'Live release changed; rebase before deployment'
    result = ops.sql("BEGIN READ ONLY; SET LOCAL statement_timeout='10s'; SELECT json_build_object('reconciliation',(SELECT count(*) FROM scm_reconciliation_runs WHERE status IN ('queued','running')),'posting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing'))); COMMIT;")
    active = next(json.loads(line) for line in result.splitlines() if line.startswith('{'))
    assert active == {'reconciliation': 0, 'posting': 0}, f'Active work: {active}'
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


if __name__ == '__main__':
    os.umask(0o077)
    {'prepare': prepare, 'deploy': deploy, 'verify': ops.verify}[sys.argv[1]]()

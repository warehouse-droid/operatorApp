"""One-file history lookup release, with source checks and app-only rollback."""
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

sys.dont_write_bytecode = True
SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
RELEASE = SERVER / 'deployments/custom-order-movement-yard-20261026'
IMAGE = 'mbbs-operator-app:custom-order-movement-yard-20261026'
ROLLBACK = IMAGE + '-rollback'
FILE = 'src/yard-movement-repository.js'
PRIOR_HASH = '4e751659f37daf83dd640d6b1cf0a5d3831e1bc7243fce24cfc5dbc916247180'
spec = importlib.util.spec_from_file_location('custom_yard_release_base', SERVER / 'tools/count-sheet-variance-release.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
core = base.core
core.RELEASE = RELEASE


def dependency_graph(name):
    seen = set()

    def visit(path):
        path = path.resolve()
        if path in seen:
            return
        seen.add(path)
        for reference in re.findall(r'''(?:from\s*|import\s*\()?["'](\.{1,2}/[^"']+\.js)["']''', path.read_text()):
            child = (path.parent / reference).resolve()
            if child.is_file():
                visit(child)

    visit(SERVER / name)
    return sorted(str(path.relative_to(SERVER)) for path in seen)


def current(data):
    assert core.metadata(core.APP) == data['app'], 'Live app changed; recapture required'
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    assert json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)) == data['beforeTree']
    assert core.sha((SERVER / FILE).read_bytes()) == data['candidateTree'][FILE]
    assert core.sha((RELEASE / 'candidate' / FILE).read_bytes()) == data['candidateTree'][FILE]


def capture():
    RELEASE.mkdir(parents=True, exist_ok=True)
    assert not (RELEASE / 'manifest.json').exists(), 'Already captured'
    app = core.metadata(core.APP)
    dependencies = [core.metadata(name) for name in core.DEPENDENCIES]
    before = json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT))
    assert before[FILE] == PRIOR_HASH
    source = (SERVER / FILE).read_bytes()
    graph = dependency_graph(FILE)
    for name in graph:
        if name != FILE:
            assert core.sha((SERVER / name).read_bytes()) == before[name], 'Untested runtime dependency: ' + name
    assert core.sha((SERVER / 'package-lock.json').read_bytes()) == before['package-lock.json'], 'Lockfile differs'
    live_package = json.loads(core.docker('exec', core.APP, 'cat', '/app/package.json'))
    workspace_package = json.loads((SERVER / 'package.json').read_text())
    for field in ['dependencies', 'devDependencies']:
        assert live_package.get(field) == workspace_package.get(field), 'Dependency manifest differs: ' + field
    prior = RELEASE / 'before' / FILE
    prior.parent.mkdir(parents=True)
    prior.write_bytes(core.docker('exec', core.APP, 'cat', '/app/' + FILE))
    candidate = RELEASE / 'candidate' / FILE
    candidate.parent.mkdir(parents=True)
    candidate.write_bytes(source)
    after = dict(before, **{FILE: core.sha(source)})
    assert after[FILE] != before[FILE]
    data = {'capturedAt': core.now(), 'authorization': 'Correction of reported missing RP-PER-CAM-1022 history',
            'app': app, 'dependencies': dependencies, 'files': [FILE], 'beforeTree': before,
            'candidateTree': after, 'testedDependencyGraph': graph}
    core.save('manifest.json', data)
    current(data)
    print(json.dumps({'captured': True, 'files': [FILE], 'matchedRuntimeDependencies': len(graph)-1}), flush=True)


def build():
    data = core.state()
    current(data)
    check = json.loads((RELEASE / 'validation-passed.json').read_text())
    assert check['passed'] and check['hashes'][FILE] == data['candidateTree'][FILE]
    core.docker('tag', data['app']['imageId'], ROLLBACK)
    stage = RELEASE / 'stage'
    overlay = stage / 'overlay' / FILE
    overlay.parent.mkdir(parents=True, exist_ok=True)
    overlay.write_bytes((RELEASE / 'candidate' / FILE).read_bytes())
    (stage / 'Dockerfile').write_text('FROM ' + ROLLBACK + '\nCOPY --chown=node:node overlay/ /app/\n')
    for mode, image in [('release', IMAGE), ('rollback', ROLLBACK)]:
        (RELEASE / ('compose.' + mode + '.yml')).write_text('services:\n  app:\n    image: ' + image + '\n    pull_policy: never\n')
    with (RELEASE / 'build.log').open('wb') as output:
        subprocess.run(['docker', 'build', '--network=none', '--pull=false', '-t', IMAGE, str(stage)],
                       stdout=output, stderr=subprocess.STDOUT, check=True, timeout=120)
    data['candidateImageId'] = core.docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    core.save('manifest.json', data)
    core.config_check(data)
    current(data)
    print(json.dumps({'built': True, 'image': IMAGE, 'sourceHash': data['candidateTree'][FILE]}), flush=True)


def refresh():
    data = core.state()
    assert 'candidateImageId' not in data, 'Cannot change a built release'
    assert core.metadata(core.APP) == data['app']
    assert json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)) == data['beforeTree']
    source = (SERVER / FILE).read_bytes()
    data['candidateTree'][FILE] = core.sha(source)
    (RELEASE / 'candidate' / FILE).write_bytes(source)
    core.save('manifest.json', data)
    current(data)
    print(json.dumps({'candidateRefreshed': True, 'sourceHash': data['candidateTree'][FILE]}), flush=True)


def rebase_rollback():
    data = core.state()
    assert json.loads((RELEASE / 'rollback-result.json').read_text())['priorImageRestored']
    app = core.metadata(core.APP)
    assert app['imageId'] == data['app']['imageId']
    assert app['configuration'] == data['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    assert json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)) == data['beforeTree']
    data.setdefault('rollbackBaselines', []).append({'at': core.now(), 'app': data['app'],
        'reason': 'Restored original image after a transient verification HTTP timeout'})
    data['app'] = app
    data['authorization'] = 'User explicitly requested deploy and short cutover'
    core.save('manifest.json', data)
    current(data)
    print(json.dumps({'rollbackBaselineVerified': True, 'candidateImageUnchanged': True}), flush=True)


def verify():
    data = core.state()
    core.ready(data['candidateImageId'])
    assert core.metadata(core.APP)['configuration'] == data['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    actual = json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT))
    assert actual == data['candidateTree'], 'Deployed source differs from reviewed one-file overlay'
    script = r"""
import assert from 'node:assert/strict';
import {listYardMovements,getYardMovementDetail,listYardMovementCsvRows} from './src/yard-movement-repository.js';
import {closeDb} from './src/db.js';
try {
  const filter={from:'2026-10-22',to:'2026-10-22',yard:'1',direction:'outbound',orderType:'custom_order',search:'RP-PER-CAM-1022'};
  const rows=await listYardMovements(filter);
  assert.equal(rows.length,1);const row=rows[0];
  assert.equal(row.tranid,'RP-PER-CAM-1022');assert.equal(Number(row.yard_location_id),1);
  assert.equal(row.driver_record_count,2);assert.equal(row.photo_count,6);
  const detail=await getYardMovementDetail({...filter,orderId:row.order_id,allowedYardLocationIds:[1]});
  assert.equal(detail.driverRecords.length,2);assert.equal(detail.driverPhotos.length,6);
  assert.deepEqual(await listYardMovements({...filter,allowedSalesStoreLocationIds:[28]}),[]);
  const csv=await listYardMovementCsvRows(filter);assert(csv.length>0);assert(csv.every(r=>r.order_ref===row.tranid));
  const endpoints=['/api/dispatch/loaded-orders','/api/control/loaded-orders','/api/sales/in-outbound-records'];
  const http=[];
  for(const path of endpoints) {
    for(let attempt=1;attempt<=3;attempt++) {
      let response;
      try {
        response=await fetch('http://127.0.0.1:3000'+path,{signal:AbortSignal.timeout(5000)});
        await response.text();
      } catch(error) {
        if(error.name!=='TimeoutError'||attempt===3) throw error;
        continue;
      }
      assert.equal(response.status,401,path);
      http.push({path,status:response.status,attempt});break;
    }
  }
  console.log(JSON.stringify({reference:row.tranid,yard:Number(row.yard_location_id),status:row.movement_status,
    driverRecords:detail.driverRecords.length,photos:detail.driverPhotos.length,csvRows:csv.length,anonymousDenied:http.length,http}));
} finally {await closeDb();}
"""
    observation = json.loads(core.docker('exec', '-i', '-e', 'PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=15000',
                                        core.APP, 'node', '--input-type=module', input=script.encode(), timeout=90))
    containers = {}
    for label, args in [('running', ['ps']), ('all', ['ps', '-a'])]:
        rows = core.docker(*args, '--format', '{{.Names}} {{.Status}}').decode().splitlines()
        assert {row.split()[0] for row in rows} == {core.APP, *core.DEPENDENCIES}
        containers[label] = rows
    result = {'deployed': True, 'at': core.now(), 'image': IMAGE, 'files': [FILE], 'sourceHash': actual[FILE],
              'configurationPreserved': True, 'dependenciesUnchanged': True, 'databaseMigration': False,
              'runtimeFilesVerified': len(actual), 'record': observation, 'containers': containers}
    core.save('deployment-result.json', result)
    print(json.dumps(result), flush=True)


def image_check():
    assert os.environ.get('MBBS_TEST_ARTIFACT_DIR'), 'Use the disposable retention runner'
    data = core.state()
    current(data)
    name = 'mbbs-custom-yard-image-' + str(os.getpid())
    try:
        actual = json.loads(core.bounded(data['candidateImageId'], name, 'node', '-e', core.HASH_SCRIPT))
        assert actual == data['candidateTree'], 'Candidate image contains an unexpected source change'
    finally:
        subprocess.run(['docker', 'rm', '-fv', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        for args in [['ps'], ['ps', '-a']]:
            rows = core.docker(*args, '--format', '{{.Names}} {{.Status}}').decode().splitlines()
            assert {row.split()[0] for row in rows} == {core.APP, *core.DEPENDENCIES}
            print('\n'.join(rows), flush=True)
        core.ready(data['app']['imageId'])
    result = {'passed': True, 'imageId': data['candidateImageId'], 'runtimeFilesVerified': len(actual),
              'files': [FILE], 'sourceHash': actual[FILE]}
    core.save('image-check.json', result)
    print(json.dumps(result), flush=True)


def deploy():
    data = core.state()
    current(data)
    check = json.loads((RELEASE / 'image-check.json').read_text())
    assert check['passed'] and check['imageId'] == data['candidateImageId']
    assert core.docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip() == data['candidateImageId']
    core.config_check(data)
    active = core.preflight()
    active['automaticFulfillment'] = int(core.sql("SELECT count(*) FROM dispatch_sales_order_if_candidates WHERE status='posting';"))
    core.assert_no_active_operations(active)
    args = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
    start = time.monotonic()
    samples, stop = [], threading.Event()

    def probe():
        while not stop.is_set():
            stamp = time.monotonic()
            try:
                with urllib.request.urlopen('http://127.0.0.1:3000/health', timeout=0.5) as response:
                    ok = response.status == 200
            except (OSError, urllib.error.URLError):
                ok = False
            samples.append({'seconds': round(stamp-start, 3), 'ok': ok})
            stop.wait(0.2)

    watcher = threading.Thread(target=probe, daemon=True)
    watcher.start()
    try:
        with (RELEASE / 'publish.log').open('wb') as output:
            subprocess.run(core.compose(data, 'release') + args, cwd=ROOT, stdout=output,
                           stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
        core.save('cutover-timing.json', {'secondsThroughVerification': round(time.monotonic()-start, 3)})
    except BaseException:
        with (RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(core.compose(data, 'rollback') + args, cwd=ROOT, stdout=output,
                           stderr=subprocess.STDOUT, check=True, timeout=60)
        core.ready(data['app']['imageId'])
        core.save('rollback-result.json', {'at': core.now(), 'priorImageRestored': True})
        raise
    finally:
        stop.set()
        watcher.join(timeout=2)
        failed = [row['seconds'] for row in samples if not row['ok']]
        recovered = [row['seconds'] for row in samples if row['ok'] and failed and row['seconds']>max(failed)]
        core.save('cutover-observation.json', {'secondsThroughVerification': round(time.monotonic()-start, 3),
            'observedInterruptionSeconds': round(min(recovered)-min(failed), 3) if recovered else (0 if not failed else None),
            'samples': samples})


if __name__ == '__main__':
    os.umask(0o077)
    signal.signal(signal.SIGTERM, lambda signum, _: sys.exit(128+signum))
    {'capture': capture, 'refresh': refresh, 'rebase-rollback': rebase_rollback, 'build': build,
     'image-check': image_check, 'deploy': deploy, 'verify': verify}[sys.argv[1]]()

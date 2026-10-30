"""Deploy only the validated hourly linked pickup SO refresh."""
import datetime
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('hourly_release', SERVER / 'tools/dispatch-source-save-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE = SERVER / 'deployments/stock-request-hourly-refresh-20261028'
release.EXISTING = ['src/server.js', 'public/regular-stock-status.js', 'public/regular-stock-status-ui.js',
                    'public/regular-stock-ui.js', 'public/sales-stock-requests.html', 'public/scm-stock-requests.html']
release.FILES = release.EXISTING + ['src/stock-request-so-refresh-domain.js', 'src/stock-request-so-refresh-repository.js', 'src/stock-request-so-refresh.js']
release.IMAGE = 'mbbs-operator-app:stock-request-hourly-refresh-20261028'
release.ROLLBACK = 'mbbs-operator-app:rollback-stock-request-hourly-refresh-20261028'


def prepare():
    proof = json.loads((release.RELEASE / 'verified.json').read_text())
    assert proof['passed'], 'Passing isolated checks are required'
    info = {'app': release.core.metadata(release.APP), 'dependencies': [release.core.metadata(name) for name in release.DEPENDENCIES], 'files': proof['files']}
    assert info['app']['imageId'] == proof['baseImage'], 'Live image changed; revalidate against it'
    release.current(info)
    live = release.docker('exec', release.APP, 'sha256sum', *['/app/' + name for name in release.EXISTING]).decode().splitlines()
    assert {row.split()[1].removeprefix('/app/'): row.split()[0] for row in live} == {name: release.digest(release.RELEASE / 'live-before' / name) for name in release.EXISTING}, 'Live source changed'
    release.docker('tag', info['app']['imageId'], release.ROLLBACK)
    stage = release.RELEASE / 'candidate'
    (stage / 'Dockerfile').write_text('FROM ' + release.ROLLBACK + '\n' + ''.join('COPY --chown=node:node ' + name + ' /app/' + name + '\n' for name in release.FILES))
    with (release.RELEASE / 'build.log').open('wb') as output:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network=none', '--pull=false', '-t', release.IMAGE, str(stage)], stdout=output, stderr=subprocess.STDOUT, check=True)
    info['imageId'] = release.docker('image', 'inspect', '--format', '{{.Id}}', release.IMAGE).decode().strip()
    for name, image in [('compose.release.yml', release.IMAGE), ('compose.rollback.yml', release.ROLLBACK)]:
        (release.RELEASE / name).write_text('services:\n  app:\n    image: ' + image + '\n')
    release.save('manifest.json', info)
    release.current(info)
    print(json.dumps({'prepared': True, 'baseImage': info['app']['imageId'], 'imageId': info['imageId'], 'files': release.FILES}))


def verify():
    info = release.state()
    release.core.ready(info['imageId'])
    assert release.core.metadata(release.APP)['configuration'] == info['app']['configuration'], 'App configuration changed'
    assert [release.core.metadata(name) for name in release.DEPENDENCIES] == info['dependencies'], 'Dependency changed'
    rows = release.docker('exec', release.APP, 'sha256sum', *['/app/' + name for name in release.FILES]).decode().splitlines()
    assert {row.split()[1].removeprefix('/app/'): row.split()[0] for row in rows} == info['files']
    script = r"""
import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from './src/db.js';
import {readFileSync} from 'node:fs';
import {STOCK_REQUEST_SO_REFRESH_INTERVAL_MS} from './src/stock-request-so-refresh-domain.js';
import {listStockRequestSalesOrders} from './src/stock-request-so-refresh-repository.js';
try {
 assert.equal(STOCK_REQUEST_SO_REFRESH_INTERVAL_MS,3600000);
 assert.match(readFileSync('src/server.js','utf8'),/startStockRequestSalesOrderRefresh\(\{operationalSyncRunning:anyNetSuiteSyncRunning/);
 const observed=await withTransaction(async()=>{
  await query('SET TRANSACTION READ ONLY');await query("SET LOCAL statement_timeout='20s'");
  const candidates=await listStockRequestSalesOrders();
  const runs=(await query("SELECT action,created_at,details FROM delivery_audit_log WHERE action IN ('stock_request.so_refresh.started','stock_request.so_refresh.finished') ORDER BY created_at DESC,id DESC LIMIT 2")).rows;
  return {candidateCount:candidates.length,runs};
 });
 const health=await fetch('http://127.0.0.1:3000/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
 for(const asset of ['regular-stock-ui.js','regular-stock-status-ui.js','regular-stock-status.js'])assert.equal((await fetch('http://127.0.0.1:3000/'+asset+'?hourlySO=20261028')).status,200);
 console.log(JSON.stringify({intervalMinutes:60,health:200,assets:200,readOnly:true,...observed}));
} finally {await closeDb();}
"""
    checked = json.loads(release.docker('exec', '-i', release.APP, 'node', '--input-type=module', input=script.encode()))
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'imageId': info['imageId'], 'files': info['files'], 'configurationPreserved': True, 'dependenciesUnchanged': True, **checked}
    release.save('deployment-result.json', result)
    print(json.dumps(result), flush=True)


release.verify = verify
if __name__ == '__main__':
    {'prepare': prepare, 'apply': release.apply, 'verify': verify}[sys.argv[1]]()

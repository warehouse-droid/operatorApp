"""Publish the tested allocation overlay and missing dependencies to the worker."""
import json
import sys
import time

import deploy as release

release.APP = 'mbbs-operator-app-webhook-worker-1'
release.SERVICE = 'webhook-worker'
release.DEPENDENCIES = ['mbbs-operator-app-app-1', 'mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1']
release.RELEASE = release.RELEASE.parent / 'release-worker-v2'
release.OUT = release.OUT / 'worker-v2'
release.OUT.mkdir(parents=True, exist_ok=True)
release.BASE = 'mbbs-operator-app:stocking-line-actions-worker-base-20261006'
release.IMAGE = 'mbbs-operator-app:stocking-line-actions-worker-v2-20261006'
release.FILES = ['src/regular-stock-purchase-repository.js', 'src/regular-stock-line-actions.js',
                 'src/regular-stock-domain.js', 'public/regular-stock-input.js']


def verify_existing_dependency():
    evidence = json.loads(release.EVIDENCE_FILE.read_text())
    file = 'src/stock-request-domain.js'
    assert release.sha(release.docker('exec', release.APP, 'cat', '/app/' + file)) == evidence['dependencyManifest'][file]


def prepare():
    verify_existing_dependency()
    release.prepare()


def verify():
    state = json.loads((release.RELEASE / 'state.json').read_text())
    manifest = json.loads((release.RELEASE / 'manifest.json').read_text())
    current = release.metadata(release.APP)
    assert current['image'] == manifest['candidateImage'] and current['configHash'] == state['configHash']
    assert all(release.sha(release.docker('exec', release.APP, 'cat', '/app/' + file)) == expected
               for file, expected in manifest['files'].items())
    verify_existing_dependency()
    time.sleep(1)
    assert release.docker('inspect', '--format', '{{.State.Running}}', release.APP).decode().strip() == 'true'
    script = b"""import assert from 'node:assert/strict';
    import {reconcilePurchaseStockAllocations} from './src/regular-stock-purchase-repository.js';
    import {refreshStockingReplyStatus} from './src/regular-stock-line-actions.js';
    import {query,withTransaction,closeDb} from './src/db.js';
    try{assert.equal(typeof reconcilePurchaseStockAllocations,'function');assert.equal(typeof refreshStockingReplyStatus,'function');
      await withTransaction(async()=>{await query('SET TRANSACTION READ ONLY');await query('SELECT 1');});
      console.log(JSON.stringify({modulesLoaded:true,databaseReadable:true}));}finally{await closeDb();}"""
    probe = json.loads(release.docker('exec', '-i', '-w', '/app', release.APP, 'node', '--input-type=module', input=script))
    health = json.loads(release.docker('exec', 'mbbs-operator-app-app-1', 'node', '-e',
        "fetch('http://127.0.0.1:3000/health').then(r=>r.json()).then(v=>console.log(JSON.stringify(v)))"))
    assert health['ok'] is True
    result = {'deployed': True, 'service': 'webhook-worker', 'image': current['image'],
              'configurationPreserved': True, 'files': manifest['files'], 'applicationHealth': 'healthy', **probe}
    (release.OUT / 'deployed.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result), flush=True)


release.verify = verify
if __name__ == '__main__':
    {'prepare': prepare, 'apply': release.apply, 'verify': verify}[sys.argv[1]]()

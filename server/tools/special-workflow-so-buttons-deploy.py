"""Deploy the three reviewed frontend files; keep the worker and database intact."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

spec = importlib.util.spec_from_file_location('enquiry_release', Path(__file__).with_name('special-workflow-enquiry-deploy.py'))
enquiry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(enquiry)
base = enquiry.base
base.RELEASE = Path('/home/ubuntu/operatorapp-deploy-backups/special-workflow-so-buttons-20260925-v2')
base.ART = base.SERVER / 'test-artifacts/special-workflow-so-buttons'
enquiry.ORIGINAL = Path('/home/ubuntu/operatorapp-investigations/special-workflow-so-buttons-20260925/baseline')
enquiry.NEW = []
enquiry.VERSION = 'special-workflow-so-buttons-20260925-v2'
SCOPE = ['public/sales-special-stock-requests.js', 'public/sales-stock-requests.html', 'public/stock-requests.css']


def source_gate():
    hashes = json.loads((base.ART / 'final/source-manifest.json').read_text())
    for file, sha in hashes.items():
        assert base.digest((base.SERVER / file).read_bytes()) == sha, 'Verified source changed: ' + file
    tests = (base.ART / 'final/tests-coverage.txt').read_text()
    assert '# fail 0\n' in tests and '# skipped 0\n' in tests
    for file in ['browser/results.json', 'mutations.json']:
        checks = json.loads((base.ART / file).read_text())
        assert checks and all(row.get('passed', row.get('killed')) for row in checks)
    coverage = json.loads((base.ART / 'changed-line-coverage.json').read_text())
    assert coverage['covered'] == coverage['total'] and coverage['total'] > 0
    return SCOPE


base.source_gate = source_gate
enquiry.source_gate = source_gate


def build():
    base.build()
    manifest = base.read('manifest.json')
    worker = manifest['services']['worker']
    assert not worker['files']
    # A FROM-only Docker build can add image metadata. Keep the original worker
    # image itself, as well as its running container, for this frontend release.
    base.docker('tag', worker['baseImageId'], worker['image'])
    worker['imageId'] = worker['baseImageId']
    base.save('manifest.json', manifest)
    print(json.dumps({'retainedWorkerImage': worker['imageId']}), flush=True)


def verify():
    result = enquiry.verify()
    before = base.read('containers.before.private.json')[1]
    worker = base.inspect(base.SERVICES['worker'])[0]
    assert (worker['Id'], worker['Image'], worker['State']['StartedAt']) == (before['Id'], before['Image'], before['State']['StartedAt'])
    script = """import {getSpecialStockCase} from './src/special-stock-request-repository.js';import {closeDb,withTransaction,query} from './src/db.js';
try{const result=await withTransaction(async()=>{await query('SET TRANSACTION READ ONLY');const row=(await query(\"SELECT id FROM sales_stock_requests WHERE request_ref='SPREQ-000005'\")).rows[0];const d=await getSpecialStockCase(row.id,{audience:'sales'});return {requestRef:d.requestRef,revision:d.revision,stage:d.stage,quantityReviewPending:d.quantityReviewPending,reviewStatus:d.quantityReview?.status,salesOrderCreated:Boolean(d.salesOrderId||d.salesOrderSkipped),readOnly:true};});console.log(JSON.stringify(result));}finally{await closeDb();}"""
    result['reportedRequest'] = json.loads(base.docker('exec', base.SERVICES['app'], 'node', '--input-type=module', '-e', script))
    result.update(workerUnchanged=True, databaseMigrationApplied=False)
    base.save('deployment-result.json', result)
    return result


def apply():
    base.current()
    manifest, checked = base.read('manifest.json'), base.read('verified.json')
    assert checked['passed'] and checked['images'] == {role: row['imageId'] for role, row in manifest['services'].items()}
    assert not manifest['services']['worker']['files']
    assert manifest['services']['worker']['imageId'] == manifest['services']['worker']['baseImageId']
    base.config_gate()
    state = base.preflight()
    base.save('preflight.json', state)
    assert not any(state[key] for key in ['operatorPosting', 'webhooksRunning', 'specialCreating', 'quantityApplying']), 'Retry when in-flight operations finish'
    base.current()
    # No database writes or migration are needed for this frontend-only release.
    try:
        with (base.RELEASE / 'app-cutover.log').open('wb') as output:
            subprocess.run([*base.compose('app', 'release'), 'up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'], cwd=base.ROOT, stdout=output, stderr=subprocess.STDOUT, check=True)
        verify()
    except Exception:
        with (base.RELEASE / 'app-rollback.log').open('wb') as output:
            subprocess.run([*base.compose('app', 'rollback'), 'up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'], cwd=base.ROOT, stdout=output, stderr=subprocess.STDOUT, check=True)
        base.ready({role: row['baseImageId'] for role, row in manifest['services'].items()})
        raise


SERVER, ROOT, RELEASE, ART = base.SERVER, base.ROOT, base.RELEASE, base.ART
current, read, save, inspect, docker, config_gate = base.current, base.read, base.save, base.inspect, base.docker, base.config_gate
if __name__ == '__main__':
    os.umask(0o077)
    {'snapshot': enquiry.snapshot, 'prepare': enquiry.prepare, 'build': build, 'config': config_gate, 'apply': apply, 'verify': verify}[sys.argv[1]]()

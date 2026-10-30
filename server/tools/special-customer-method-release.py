"""Release the validated Special delivery-method patch over the current live image."""
import datetime
import importlib.util
import json
from pathlib import Path
import sys

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('patch_release', SERVER / 'tools/dispatch-pending-approval-release.py')
patch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patch)
release = patch.release
release.RELEASE = SERVER / 'deployments/special-customer-method-20261027'
release.FILES = ['src/special-stock-request-repository.js', 'src/special-stock-logistics.js',
                 'public/special-stock-fulfillment.js', 'public/sales-special-stock-requests.js',
                 'public/sales-stock-requests.html']
release.EXISTING = release.FILES
release.IMAGE = 'mbbs-operator-app:special-customer-method-20261027'
release.ROLLBACK = 'mbbs-operator-app:rollback-special-customer-method-20261027'


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
import {getSpecialStockCase} from './src/special-stock-request-repository.js';
import {canEditSpecialFulfillment,specialFulfillmentMethods} from './public/special-stock-fulfillment.js';
try {
 const cases=await withTransaction(async()=>{
  await query('SET TRANSACTION READ ONLY');await query("SET LOCAL statement_timeout='15s'");
  const d=await getSpecialStockCase(199,{audience:'sales'});
  assert.equal(d.requestRef,'SPREQ-000080');assert.equal(d.fulfillmentMethod,'yard_pickup');
  assert.equal(d.stage,'completed');assert.equal(d.operationallyComplete,true);assert.equal(canEditSpecialFulfillment(d),false);
  const methods=specialFulfillmentMethods(d).map(([method])=>method);assert.deepEqual(methods,['yard_pickup','mbt_delivery']);
  return {requestRef:d.requestRef,method:d.fulfillmentMethod,stage:d.stage,editable:false,allowedAfterArrival:methods};
 });
 const health=await fetch('http://127.0.0.1:3000/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
 const helper=await fetch('http://127.0.0.1:3000/special-stock-fulfillment.js?v=20261027-planned-method-v2');assert.equal(helper.status,200);assert.match(await helper.text(),/fulfillmentExecutionStarted/);
 const controller=await fetch('http://127.0.0.1:3000/sales-special-stock-requests.js?plannedMethod=20261027-v2');assert.equal(controller.status,200);assert.match(await controller.text(),/special-stock-fulfillment\.js\?v=20261027-planned-method-v2/);
 console.log(JSON.stringify({cases,health:200,assets:200,readOnly:true}));
} finally {await closeDb();}
"""
    checked = json.loads(release.docker('exec', '-i', release.APP, 'node', '--input-type=module', input=script.encode()))
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'imageId': info['imageId'], 'files': info['files'], 'configurationPreserved': True,
              'dependenciesUnchanged': True, **checked}
    release.save('deployment-result.json', result)
    print(json.dumps(result), flush=True)


release.verify = verify
if __name__ == '__main__':
    {'prepare': patch.prepare, 'apply': release.apply, 'verify': verify}[sys.argv[1]]()

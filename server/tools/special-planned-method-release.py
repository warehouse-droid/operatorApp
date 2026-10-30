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
release.RELEASE = SERVER / 'deployments/special-planned-delivery-method-20261027'
release.FILES = ['src/special-stock-request-repository.js', 'src/special-stock-logistics.js',
                 'public/special-stock-fulfillment.js', 'public/sales-special-stock-requests.js',
                 'public/sales-stock-requests.html']
release.EXISTING = release.FILES
release.IMAGE = 'mbbs-operator-app:special-planned-method-20261027'
release.ROLLBACK = 'mbbs-operator-app:rollback-special-planned-method-20261027'


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
import {canEditSpecialFulfillment} from './public/special-stock-fulfillment.js';
try {
 const cases=await withTransaction(async()=>{
  await query('SET TRANSACTION READ ONLY');
  await query("SET LOCAL statement_timeout='15s'");
  const rows=(await query("SELECT request_id FROM sales_special_stock_cases WHERE workflow_kind='special' AND close_status='active' AND sales_order_netsuite_id IS NOT NULL ORDER BY request_id DESC LIMIT 25")).rows;
  const result={inspected:0,planned:0,editablePlanned:0,executionLocked:0};
  for(const row of rows){
   const detail=await getSpecialStockCase(row.request_id,{audience:'sales'});
   result.inspected++;
   if(detail.fulfillmentExecutionStarted){assert.equal(canEditSpecialFulfillment(detail),false);result.executionLocked++;}
   if(detail.dispatchPlanning?.anyPlanned||detail.dispatchPlanned||detail.handoff?.status==='planned'){
    result.planned++;
    if(!detail.fulfillmentExecutionStarted&&!detail.operationallyComplete&&!['closed','completed'].includes(detail.stage)&&!['in_progress','completed'].includes(detail.handoff?.status)){
     assert.equal(canEditSpecialFulfillment(detail),true);result.editablePlanned++;
    }
   }
  }
  return result;
 });
 const health=await fetch('http://127.0.0.1:3000/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
 const helper=await fetch('http://127.0.0.1:3000/special-stock-fulfillment.js?v=20261027-planned-method-v1');assert.equal(helper.status,200);assert.match(await helper.text(),/fulfillmentExecutionStarted/);
 const controller=await fetch('http://127.0.0.1:3000/sales-special-stock-requests.js?plannedMethod=20261027-v1');assert.equal(controller.status,200);assert.match(await controller.text(),/special-stock-fulfillment\.js\?v=20261027-planned-method-v1/);
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

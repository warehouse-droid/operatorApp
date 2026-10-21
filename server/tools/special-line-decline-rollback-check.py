"""Exercise rollback order guards against the isolated database using the previous app."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess

server = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('decline_release', server / 'tools/special-line-decline-deploy.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
release = deploy.release
state = release.state()
assert state.get('rollbackImageId')
directory = release.RELEASE / 'checks-rollback'
shutil.copytree(release.RELEASE / 'before-app', directory, dirs_exist_ok=True)
shutil.copytree(server / 'test', directory / 'test', dirs_exist_ok=True)
shutil.copy2(release.RELEASE / 'rollback-compatible/src/special-stock-request-repository.js', directory / 'src/special-stock-request-repository.js')
assert release.digest((directory / 'src/special-stock-request-repository.js').read_bytes()) == release.digest((release.RELEASE / 'rollback-compatible/src/special-stock-request-repository.js').read_bytes())
prefix = (server / 'test/mbt/integration/special-line-decline-http.test.js').read_text().split("test('decline/revoke preserves", 1)[0]
probe = """
test('previous app keeps decision review locked until its SO draft is saved again', async () => {
  const d = await reviewedCase();
  await query(`UPDATE sales_special_stock_cases SET line_edit_state='{"orderReviewRequired":true}' WHERE request_id=$1`, [d.id]);
  for (const orderKind of ['sales_order','purchase_order']) await assert.rejects(repo.claimSpecialOrderOperation(d.id,
    {expectedRevision:d.revision,orderKind,operationId:crypto.randomUUID()}), {code:'SPECIAL_DECISION_REVIEW_REQUIRED'});
  await assert.rejects(repo.linkSpecialSalesOrder(d.id,{expectedRevision:d.revision,salesOrderId:123,salesOrderRef:'TEST-SO'},context()), {code:'SPECIAL_DECISION_REVIEW_REQUIRED'});
  const flag = (await query("SELECT enabled FROM mbt_feature_flags WHERE flag_key='special_stock_request_test_skip_orders'")).rows[0].enabled;
  try {
    await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_test_skip_orders'");
    for (const orderKind of ['sales_order','purchase_order']) await assert.rejects(repo.skipSpecialOrderCreation(d.id,
      {expectedRevision:d.revision,orderKind},context()), {code:'SPECIAL_DECISION_REVIEW_REQUIRED'});
  } finally {await query("UPDATE mbt_feature_flags SET enabled=$1 WHERE flag_key='special_stock_request_test_skip_orders'",[flag]);}
  await repo.saveSpecialSalesOrderDraft(d.id,{expectedRevision:d.revision,customerId:8899397,operationalYardLocationId:1,
    fulfillmentMethod:'yard_pickup',palletTotal:3,palletRate:40,materialLines:d.lines.map((l,i)=>({caseLineId:l.id,itemId:2055,
    description:'Old item '+i+' Grey 80mm Smooth',quantity:6,packageQuantity:3,conversionToPc:2,uom:'PC',rate:12.25,discountPercent:10}))},context());
  assert.deepEqual((await query('SELECT line_edit_state FROM sales_special_stock_cases WHERE request_id=$1',[d.id])).rows[0].line_edit_state,{});
});
"""
(directory / 'test/mbt/integration/special-line-decline-http.test.js').write_text(prefix + probe)
runner, remote = 'mbbs-special-review-runner', '/tmp/special-line-decline-rollback-check'
release.docker('exec', runner, 'node', '-e', "const f=require('fs');f.rmSync(process.argv[1],{recursive:true,force:true});f.mkdirSync(process.argv[1]);", remote)
release.docker('cp', str(directory) + '/.', runner + ':' + remote)
release.docker('exec', runner, 'node', '-e', "require('fs').symlinkSync('/app/node_modules',process.argv[1]+'/node_modules','dir');", remote)
result = subprocess.run(['sudo','-n','docker','exec','-e','MBT_TEST_ISOLATED=1','-e','NETSUITE_DIRECT_ACCESS_ENABLED=false',
 '-e','DATABASE_URL=postgres://mbt_test:stock_updates_test_only@mbbs-special-updates-db-20261002:5432/mbt_verify',
 '-w',remote,runner,'node','--test','test/mbt/integration/special-line-decline-http.test.js'], capture_output=True, text=True, timeout=60)
log = result.stdout + result.stderr
(release.EVIDENCE / 'rollback-compatibility.log').write_text(log)
assert result.returncode == 0, log[-4000:]
release.save('rollback-compatibility.json', {'passed': True, 'image': state['rollbackImageId'], 'tests': 1, 'orderReviewRequiredUntilDraftSaved': True})
print(json.dumps({'rollbackCompatibilityPassed': True, 'tests': 1}))

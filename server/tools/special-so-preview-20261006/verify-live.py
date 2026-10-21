"""Read-only completion checks for the deployed fix, recovered reference, and cleanup."""
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'test-artifacts/special-so-preview-20261006'
PRIVATE = Path('/home/ubuntu/operatorapp-investigations/special-so-preview-20261006/private')
APP = 'mbbs-operator-app-app-1'
PROJECT = 'mbbs-special-so-preview-20261006'
PRODUCTION = [APP, 'mbbs-operator-app-db-1', 'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-ollama-1']

def docker(*args, **kwargs):
    return subprocess.check_output(['docker', *args], **kwargs)

subprocess.run(['python3', str(ROOT / 'tools/special-so-preview-20261006/deploy.py'), 'verify'], check=True)
script = """import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from './src/db.js';
import {getSpecialStockCase} from './src/special-stock-request-repository.js';
import {specialOrderSnapshot} from './src/special-stock-documents.js';
try {
  const result=await withTransaction(async()=>{
    await query('SET TRANSACTION READ ONLY');
    const contexts=[{audience:'sales',authorizedStoreLocationIds:[1],dispatchPlans:[]},{audience:'scm',dispatchPlans:[]}];
    const views=[];
    for(const context of contexts){
      const detail=await getSpecialStockCase(106,context);
      assert.equal(detail.requestRef,'SPREQ-000030');assert.equal(detail.salesOrderRef,'SOB122131');
      assert.equal(detail.salesOrderId,1041956);assert.equal(detail.salesOrderOperationStatus,'linked');
      assert.equal(detail.salesOrderSource,'manual_link');assert.equal(detail.attention,false);
      const snapshot=specialOrderSnapshot(detail,'sales_order',context.audience);
      assert.equal(snapshot.id,1041956);assert.equal(snapshot.source,'netsuite-native');
      views.push({audience:context.audience,revision:detail.revision,previewAvailable:true});
    }
    const audits=await query("SELECT count(*)::int AS count FROM sales_special_stock_events WHERE request_id=106 AND event_type='special_sales_order_existing_reference_recovery'");
    assert.equal(audits.rows[0].count,1);
    return {requestRef:'SPREQ-000030',salesOrderRef:'SOB122131',views,recoveryAuditCount:audits.rows[0].count,applicationWrites:0};
  });
  console.log(JSON.stringify(result));
}finally{await closeDb();}
"""
recovered = json.loads(docker('exec', '-i', '-w', '/app', APP, 'node', '--input-type=module', input=script.encode()))
pdf = (PRIVATE / 'SOB122131.pdf').read_bytes()
recovery = json.loads((OUT / 'recovery-apply.log').read_text())
assert pdf.startswith(b'%PDF-') and len(pdf) == recovery['preview']['bytes']
assert hashlib.sha256(pdf).hexdigest() == recovery['preview']['sha256']
recovered['actualPdf'] = recovery['preview']
(OUT / 'live-completion.json').write_text(json.dumps(recovered, indent=2))
cleanup = {
    'dockerPs': docker('ps', '--format', '{{.Names}}\t{{.Status}}').decode(),
    'dockerPsA': docker('ps', '-a', '--format', '{{.Names}}\t{{.Status}}').decode(),
    'testContainers': docker('ps', '-a', '--filter', 'label=com.mbbs.lifecycle=disposable-test', '--format', '{{.Names}}').decode().strip(),
    'taskContainers': docker('ps', '-a', '--filter', 'label=com.mbbs.task=' + PROJECT, '--format', '{{.Names}}').decode().strip(),
    'taskNetworks': docker('network', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}').decode().strip(),
    'taskVolumes': docker('volume', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}').decode().strip(),
    'production': {},
}
for name in PRODUCTION:
    state = json.loads(docker('inspect', '--format', '{{json .State}}', name))
    status = {'running': state['Running'], 'health': state.get('Health', {}).get('Status', 'not configured')}
    assert status['running'] and status['health'] in ['healthy', 'not configured'], 'Production health failed: ' + name
    cleanup['production'][name] = status
(OUT / 'cleanup-completion.json').write_text(json.dumps(cleanup, indent=2))
assert not any(cleanup[key] for key in ['testContainers', 'taskContainers', 'taskNetworks', 'taskVolumes']), 'Disposable tests remain; inspect completion evidence'
print(json.dumps({'completion': recovered, 'cleanup': 'complete', 'productionHealthy': True}))

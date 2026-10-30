"""Deploy the tested Backorder PO routing changes over the exact captured live image."""
import datetime
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('child_po_release', SERVER / 'tools/dispatch-source-save-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE = SERVER / 'deployments/backorder-po-routing-20261029'
release.FILES = json.loads((release.RELEASE / 'files.json').read_text())
release.IMAGE = 'mbbs-operator-app:backorder-po-routing-20261029'
release.ROLLBACK = 'mbbs-operator-app:rollback-backorder-po-routing-20261029'


def prepare():
    evidence = json.loads((release.RELEASE / 'final-result.json').read_text())
    proof = json.loads((release.RELEASE / 'tested-inputs.json').read_text())
    assert evidence['passed'], 'Fresh passing isolated verification required'
    assert all(proof['files'][name] == value for name, value in evidence['hashes'].items()), 'Verified sources changed'
    info = {'app': release.core.metadata(release.APP),
            'dependencies': [release.core.metadata(name) for name in release.DEPENDENCIES], 'files': proof['files']}
    assert info['app']['imageId'] == proof['baseImage'], 'Live app changed; rerun isolated verification'
    release.current(info)
    release.docker('tag', info['app']['imageId'], release.ROLLBACK)
    build_base = info['app']['imageId']
    initial_deployment = release.RELEASE / 'initial-deployment-result.json'
    if initial_deployment.exists() and json.loads(initial_deployment.read_text())['imageId'] == build_base:
        # Rebuild this same scoped release over its original parent, avoiding a
        # second patch layer. Any intervening unrelated image uses its own base.
        build_base = json.loads((release.RELEASE / 'initial-manifest.json').read_text())['app']['imageId']
    build_tag = 'mbbs-operator-app:backorder-po-routing-build-base-20261029'
    release.docker('tag', build_base, build_tag)
    info['buildBaseImage'] = build_base
    stage = release.RELEASE / 'candidate'
    context = release.RELEASE / 'image-context'
    if context.exists():
        shutil.rmtree(context)
    for name in release.FILES:
        target = context / 'payload' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(stage / name, target)
    # The live image already has many release layers; add this scoped patch in one.
    (context / 'Dockerfile').write_text('FROM ' + build_tag + '\nCOPY --chown=node:node payload/ /app/\n')
    (stage / 'Dockerfile').unlink(missing_ok=True)
    with (release.RELEASE / 'build.log').open('wb') as output:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network=none', '--pull=false', '-t', release.IMAGE, str(context)],
                       stdout=output, stderr=subprocess.STDOUT, check=True)
    shutil.rmtree(context)
    info['imageId'] = release.docker('image', 'inspect', '--format', '{{.Id}}', release.IMAGE).decode().strip()
    for name, tag in [('compose.release.yml', release.IMAGE), ('compose.rollback.yml', release.ROLLBACK)]:
        (release.RELEASE / name).write_text('services:\n  app:\n    image: ' + tag + '\n')
    release.save('manifest.json', info)
    release.save('verified.json', {**proof, 'passed': True})
    release.current(info)
    print(json.dumps({'prepared': True, 'imageId': info['imageId'], 'files': len(release.FILES)}))


def verify():
    info = release.state()
    release.core.ready(info['imageId'])
    assert release.core.metadata(release.APP)['configuration'] == info['app']['configuration'], 'App configuration changed'
    assert [release.core.metadata(name) for name in release.DEPENDENCIES] == info['dependencies'], 'Dependency changed'
    rows = release.docker('exec', release.APP, 'sha256sum', *['/app/' + name for name in release.FILES]).decode().splitlines()
    assert {row.split()[1].removeprefix('/app/'): row.split()[0] for row in rows} == info['files']
    script = """
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
 const response=await fetch(base+'/health');assert.equal(response.status,200);assert.equal((await response.json()).ok,true);
 for(const [file,expected] of Object.entries(FILES)) {
  const asset=await fetch(base+'/'+file.replace('public/','')+'?poRouting=20261029-v1');
  assert.equal(asset.status,200);assert.equal(createHash('sha256').update(Buffer.from(await asset.arrayBuffer())).digest('hex'),expected);
 }
 assert.equal((await fetch(base+'/api/scm/stock-requests/290/backorder/purchase-order/splits')).status,401);
}
console.log(JSON.stringify({health:200,assets:'verified',anonymousAccess:401}));
"""
    assets = {file: digest for file, digest in info['files'].items() if file.startswith('public/')}
    result = json.loads(release.docker('exec', '-i', release.APP, 'node', '--input-type=module',
                                     input=script.replace('FILES', json.dumps(assets)).encode()))
    live_script = """
import assert from 'node:assert/strict';
import {getBackorderRequest} from './src/backorder-request-service.js';
import {listSpecialPurchaseOrderSplits} from './src/special-stock-request-repository.js';
import {withBackorderWorkflow} from './src/stock-case-workflow.js';
import {getScmPurchaseOrderCatalogOrder} from './src/scm-purchase-order-catalog-repository.js';
import {specialPoRoutingHtml} from './public/special-stock-po-routing.js';
import {query,pool} from './src/db.js';
try {
 const detail=await getBackorderRequest(290,{audience:'scm'});
 const choices=await withBackorderWorkflow(()=>listSpecialPurchaseOrderSplits(290));
 assert.equal(detail.purchaseOrderRef,'POB04147');assert.equal(detail.purchaseOrderSplitId,null);
 assert.deepEqual(choices.splits.map(row=>row.ref),['SN1403563','SN1403624']);
 const order=await getScmPurchaseOrderCatalogOrder('POB04147',{includeRestricted:true});
 const html=specialPoRoutingHtml(detail,{ref:detail.purchaseOrderRef,order,splits:choices.splits},{backorder:true});
 assert.match(html,/class="scm-mini-panel" data-backorder-po-routing-form/);
 assert.match(html,/Whole PO/);assert.match(html,/SN1403563/);assert.match(html,/SN1403624/);
 const splits=(await query(`SELECT split.id,split.split_po_ref,split.revision,schedule.status,schedule.packing_slip_ref
 FROM dispatch_scm_po_splits split LEFT JOIN scm_transport_schedule schedule ON schedule.order_ref=split.split_po_ref
 WHERE split.source_po_ref=$1 ORDER BY split.id`,['POB04147'])).rows;
 assert.deepEqual(splits,EXPECTED);
 console.log(JSON.stringify({requestRef:detail.requestRef,wholePo:detail.purchaseOrderRef,selectedChild:null,
   childOptions:choices.splits.map(row=>row.ref),existingSplitsUnchanged:true,miniPanel:true}));
} finally {await pool.end();}
"""
    before = json.loads((release.RELEASE / 'live-case-before.json').read_text())
    result['liveCase'] = json.loads(release.docker('exec', '-i', release.APP, 'node', '--input-type=module',
        input=live_script.replace('EXPECTED', json.dumps(before['splits'])).encode()))
    result.update({'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                   'imageId': info['imageId'], 'configurationPreserved': True, 'dependenciesUnchanged': True})
    release.save('deployment-result.json', result)
    print(json.dumps(result))


release.verify = verify
if __name__ == '__main__':
    {'prepare': prepare, 'apply': release.apply, 'verify': verify}[sys.argv[1]]()

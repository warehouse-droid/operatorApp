"""Read-only live Receiving and deployment checks; redact runtime configuration."""
import datetime
import importlib.util
import json
import os
import pathlib
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('to_release', ROOT / 'server/tools/operator-to-yard-flow-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

SOURCE = r"""
import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from './src/db.js';
import {config} from './src/config.js';
import {listReceivingOrders,getReceivingOrder,getReceivableReceivingOrder,listReceivingSources,searchReceivingItems} from './src/receiving-repository.js';
import {listDeliveryOrders} from './src/delivery-repository.js';
config.netsuite.directAccessEnabled=false;
try {
  const result=await withTransaction(async()=>{
    await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const checked=[];
    for(const expected of [
      {ref:'TOB01134',yard:1,quantities:{2065:104.91,1784:1}},
      {ref:'TOB01200',yard:28,quantities:{426:1}},
      {ref:'TOB01224',yard:28,quantities:{8472:1568,1784:16}}
    ]) {
      const list=await listReceivingOrders({orderType:'transfer_order',destinationLocationId:expected.yard,search:expected.ref});
      const order=list.find(row=>row.tranid===expected.ref);
      assert.ok(order,expected.ref+' must be listed in its destination Receiving yard');
      const detail=await getReceivingOrder(order.netsuite_id,{destinationLocationId:expected.yard});
      const quantities=Object.fromEntries(detail.lines.map(line=>[String(line.item_id),Number(line.quantity)]));
      assert.deepEqual(quantities,expected.quantities,expected.ref+' capacity must match verified physical shipment');
      const wrongYard=expected.yard===1?28:1;
      assert.equal((await listReceivingOrders({orderType:'transfer_order',destinationLocationId:wrongYard,search:expected.ref})).length,0);
      await assert.rejects(()=>getReceivingOrder(order.netsuite_id,{destinationLocationId:wrongYard}),error=>error.status===403);
      assert.ok((await listReceivingSources({destinationLocationId:expected.yard})).some(row=>String(row.source_location_id)===String(detail.source_location_id)));
      const searched=detail.lines[0];
      assert.ok((await searchReceivingItems({orderType:'transfer_order',destinationLocationId:expected.yard,search:searched.item_name})).some(row=>String(row.item_id)===String(searched.item_id)));
      checked.push({orderRef:expected.ref,destinationLocationId:expected.yard,destinationYard:detail.destination_location,listed:true,quantities,wrongYardHidden:true});
    }
    const unloaded=(await query("SELECT netsuite_id,to_location_id FROM transfer_orders WHERE tranid='TOB01221'")).rows[0];
    assert.equal((await listReceivingOrders({orderType:'transfer_order',destinationLocationId:unloaded.to_location_id,search:'TOB01221'})).length,0);
    await assert.rejects(()=>getReceivableReceivingOrder(unloaded.netsuite_id),error=>error.code==='TRANSFER_NOT_LOADED');
    const outbound=[];
    for(const [ref,yard] of [['TOB01200',1],['TOB01221',15]]) {
      const list=await listDeliveryOrders({orderType:'transfer_order',locationId:yard,status:'open,preparing,packed,partial_loaded'});
      assert.ok(list.some(row=>row.tranid===ref),ref+' local outbound must remain available');
      outbound.push({orderRef:ref,listed:true});
    }
    const activeOutbound=await listDeliveryOrders({orderType:'transfer_order'});
    const historicalOutbound=activeOutbound.filter(row=>row.status==='G');
    assert.equal(historicalOutbound.length,0,'Historical completed TOs must remain absent from open outbound work');
    const audits=(await query("SELECT action,COUNT(*)::int AS count FROM delivery_audit_log WHERE action IN ('operator.to.reconcile','operator.to.legacy_receiving_enabled') GROUP BY action ORDER BY action")).rows;
    return {at:new Date().toISOString(),receiving:checked,unloadedTransferHidden:true,outbound,historicalCompletionsHiddenFromOpenWork:true,audits,netSuiteWrites:0};
  });
  console.log(JSON.stringify(result));
} finally {await closeDb();}
"""


if __name__ == '__main__':
    os.umask(0o077)
    data = json.loads(release.run(release.DOCKER + ['exec', '-i', '-w', '/app', release.SERVICES['app'], 'node', '--input-type=module'], input=SOURCE))
    release.save(release.ARTIFACT / 'live-receiving-check.json', data)
    print(json.dumps(data, indent=2))
    first = json.loads((release.ARTIFACT / 'manifest.json').read_text())
    legacy = json.loads((release.ARTIFACT / 'legacy-manifest.json').read_text())
    before = json.loads((release.STATE / 'before.private.json').read_text())
    legacy_before = json.loads((release.STATE / 'legacy-before.private.json').read_text())
    partial_active = (release.ARTIFACT / 'partial-deployed.json').exists()
    terminal_active = (release.ARTIFACT / 'terminal-deployed.json').exists()
    prefix = 'terminal' if terminal_active else 'partial' if partial_active else 'legacy'
    latest = json.loads((release.ARTIFACT / f'{prefix}-manifest.json').read_text())
    app_candidate = release.STATE / f'{prefix}-candidate/app'
    latest_before = json.loads((release.STATE / f'{prefix}-before.private.json').read_text())
    result = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'services': {}}
    for service, container in release.SERVICES.items():
        current = release.inspect(container)
        expected_image = latest['candidateImage'] if service == 'app' else latest_before[service]['Image']
        assert current['Image'] == expected_image, f'{service} live image changed'
        names = list(first[service]['changes'])
        hashes = release.runtime_hashes(container, names)
        expected = {name: change['after'] for name, change in first[service]['changes'].items()}
        if service == 'app':
            expected.update({name: change['after'] for name, change in legacy['changes'].items()})
            if partial_active:
                partial = json.loads((release.ARTIFACT / 'partial-manifest.json').read_text())
                expected.update({name: change['after'] for name, change in partial['changes'].items()})
            expected.update({name: change['after'] for name, change in latest['changes'].items()})
        mismatches = [name for name in names if hashes[name] != expected[name]]
        assert set(mismatches) <= {'src/server.js'}, 'Unexpected changes to deployed TO sources'
        candidate = app_candidate if service == 'app' else release.STATE / 'candidate/webhook-worker'
        assert hashes == {name: release.digest(candidate / name) for name in names}, 'Live source differs from its exact tested candidate'
        environment_unchanged = dict(value.split('=', 1) for value in current['Config']['Env']) == dict(
            value.split('=', 1) for value in latest_before[service]['Config']['Env'])
        assert environment_unchanged
        result['services'][service] = {'image': current['Image'], 'running': current['State']['Running'],
                                       'health': current['State'].get('Health', {}).get('Status'),
                                       'environmentUnchanged': environment_unchanged,
                                       'sourceMatchesCandidate': True,
                                       'sourceHashes': hashes, 'changedSinceFirstRelease': mismatches}
        assert current['State']['Running']
    for service in ['db', 'ollama']:
        current = release.inspect(f'mbbs-operator-app-{service}-1')
        assert current['Id'] == before[service]['Id']
        assert current['State']['Health']['Status'] == 'healthy'
        result['services'][service] = {'containerUnchanged': True, 'health': 'healthy'}
    with urllib.request.urlopen('http://127.0.0.1:3000/health', timeout=5) as response:
        assert response.status == 200 and json.load(response)['ok']
    result['httpHealth'] = 'ok'
    assert result['services']['app']['health'] == 'healthy'
    release.save(release.ARTIFACT / 'live-release-check.json', result)
    print(json.dumps({'httpHealth': 'ok', 'changedSinceFirstRelease': {
        name: row.get('changedSinceFirstRelease', []) for name, row in result['services'].items()}}, indent=2))

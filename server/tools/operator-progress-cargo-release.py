"""One-file release for accounting rows incorrectly blocking dispatch splits."""
import importlib.util
import json
from pathlib import Path
import sys

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('cargo_release', SERVER / 'tools/dispatch-start-travel-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE = SERVER / 'deployments/operator-progress-cargo-20261022'
release.core.RELEASE = release.RELEASE
release.IMAGE = 'mbbs-operator-app:operator-progress-cargo-20261022'
release.ROLLBACK = release.IMAGE + '-rollback'
release.FILES = ['src/operator-order-progress-repository.js']


def order_state():
    script = """import {pool,query,withTransaction} from './src/db.js';
import {getDispatchSplitPreview} from './src/dispatch-split-preview-repository.js';
try { await withTransaction(async()=>{
 await query('SET TRANSACTION READ ONLY'); await query("SET LOCAL statement_timeout='15s'");
 const preview=await getDispatchSplitPreview({orderRef:'SOA10414',type:'SO'});
 const state=(await query(`SELECT s.operator_status,s.local_yard_order_status,
   (SELECT md5(jsonb_agg(to_jsonb(l) ORDER BY l.id)::text) FROM sales_order_lines l WHERE l.sales_order_id=s.netsuite_id) AS line_digest
   FROM sales_orders s WHERE s.tranid='SOA10414'`)).rows[0];
 console.log(JSON.stringify({orderRef:preview.id,operatorStatus:preview.operatorStatus,
   yardStatus:preview.localYardOrderStatus,itemCount:preview.items.length,canonical:state}));
}); } finally {await pool.end();} """
    return json.loads(release.core.docker('exec', '-i', release.core.APP, 'node', '--input-type=module', input=script.encode()))


def checked():
    data = release.core.state()
    evidence = json.loads((SERVER / 'test/dispatch/specs/operator-progress-cargo-20261022-evidence.json').read_text())
    assert evidence['passed'] and evidence['newFailures'] == 0
    assert evidence['sourceHashes'] == data['candidateHashes'] == release.hashes(SERVER) == release.hashes(release.RELEASE / 'candidate')
    assert evidence['mutations']['killed'] == evidence['mutations']['total']
    return data


def verify():
    data = checked()
    core = release.core
    core.ready(data['candidateImageId'])
    actual = core.metadata(core.APP)
    assert actual['configuration'] == data['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    for name in release.FILES:
        assert core.sha(core.docker('exec', core.APP, 'cat', '/app/' + name)) == data['candidateHashes'][name]
    state = order_state()
    before = data['orderBefore']
    if state['canonical'] == before['canonical']:
        assert state['operatorStatus'] == 'open' and state['yardStatus'] == 'Open', state
    containers = {key: core.docker(*args, '--format', '{{.Names}} {{.Status}}').decode().splitlines()
        for key, args in [('running', ['ps']), ('all', ['ps', '-a'])]}
    for rows in containers.values():
        assert {row.split()[0] for row in rows} == {core.APP, *core.DEPENDENCIES}
    result = {'deployed': True, 'at': core.now(), 'image': release.IMAGE, 'imageId': actual['imageId'],
        'healthy': True, 'configurationPreserved': True, 'dependenciesUnchanged': True,
        'filesVerified': len(release.FILES), 'rollbackImage': release.ROLLBACK,
        'order': state, 'orderDataUnchanged': state['canonical'] == before['canonical']}
    core.save('containers.json', containers)
    core.save('deployed.json', result)
    print(json.dumps(result))


release.checked = checked
release.verify = verify

if __name__ == '__main__':
    if sys.argv[1] == 'capture':
        release.capture()
        data = release.core.state()
        data['authorization'] = 'User reports SOA10414 still Split Blocked after release; scoped correction of the false loaded status.'
        release.core.save('manifest.json', data)
    elif sys.argv[1] == 'prepare':
        release.prepare()
        data = release.core.state()
        data['orderBefore'] = order_state()
        release.core.save('manifest.json', data)
    else:
        {'prepare': release.prepare, 'build': release.build, 'deploy': release.deploy, 'verify': release.verify}[sys.argv[1]]()

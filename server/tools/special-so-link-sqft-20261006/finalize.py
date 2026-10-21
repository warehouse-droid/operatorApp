"""Persist the committed link readback, health and disposable-resource cleanup."""
import datetime
import json
from pathlib import Path
import subprocess

SERVER = Path(__file__).resolve().parents[2]
OUT = SERVER / 'test-artifacts/special-so-link-sqft-20261006'
PROJECT = 'mbbs-special-so-link-20261006'
PRODUCTION = {'mbbs-operator-app-app-1', 'mbbs-operator-app-db-1',
              'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-ollama-1'}

def docker(*args, **kwargs):
    return subprocess.check_output(['sudo', '-n', 'docker', *args], **kwargs)

for args, filename in [(['ps'], 'final-docker-ps.log'), (['ps', '-a'], 'final-docker-ps-all.log')]:
    output = docker(*args, '--format', '{{.Names}} {{.Status}}').decode()
    (OUT / filename).write_text(output)
    assert {line.split()[0] for line in output.splitlines()} == PRODUCTION
    print(output, end='')
for resource in ['network', 'volume']:
    remaining = docker(resource, 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT,
                       '--format', '{{.Name}}').decode().strip()
    assert not remaining, 'Disposable test ' + resource + ' remains'
health = {}
for name in sorted(PRODUCTION):
    state = json.loads(docker('inspect', name))[0]['State']
    assert state['Running']
    status = state.get('Health', {}).get('Status', 'running')
    assert status in ['healthy', 'running']
    health[name] = status
script = b"""import {closeDb} from './src/db.js';
import {getSpecialStockCase} from './src/special-stock-request-repository.js';
try{const d=await getSpecialStockCase(127,{audience:'sales',authorizedStoreLocationIds:[1]});
console.log(JSON.stringify({requestRef:d.requestRef,revision:d.revision,salesOrderId:d.salesOrderId,
salesOrderRef:d.salesOrderRef,netsuiteCustomerId:d.netsuiteCustomerId,customerId:d.customerId,
customerName:d.customerName,attention:d.attention,lines:d.lines.map(l=>({id:l.id,quantity:l.quantity,uom:l.uom}))}));}
finally{await closeDb();}"""
detail = json.loads(docker('exec', '-i', '-w', '/app', 'mbbs-operator-app-app-1',
                           'node', '--input-type=module', input=script))
assert detail['requestRef'] == 'SPREQ-000043' and detail['salesOrderRef'] == 'SOB122110'
assert detail['salesOrderId'] == 1041475 and detail['netsuiteCustomerId'] == 12712
assert detail['customerId'] == 3435 and detail['customerName'] == 'Beneworks Construction'
assert detail['revision'] >= 8 and not detail['attention']
result = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'committedLink': detail,
          'productionHealth': health, 'cleanup': 'complete; only four production containers remain',
          'testNetworksAndVolumes': 0}
(OUT / 'final-readback.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))

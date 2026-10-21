"""Verify the existing pickup release and the completed disposable-test cleanup."""
import importlib.util
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
ARTIFACT = ROOT / 'server/test-artifacts/customer-pickup-lookup-access'
STATE = pathlib.Path('/home/ubuntu/operatorapp-deploy-backups/operator-pack-quantities-20261010')
module_spec = importlib.util.spec_from_file_location('pickup_release_core', ROOT / 'server/tools/operator-to-yard-flow-deploy.py')
core = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(core)
manifest = json.loads((ROOT / 'server/test-artifacts/operator-posting-pack-quantities/manifest.json').read_text())
app = core.inspect('mbbs-operator-app-app-1')
assert app['Image'] == manifest['candidateImage']
assert app['State']['Health']['Status'] == 'healthy'
assert core.runtime_hashes('mbbs-operator-app-app-1', list(manifest['changes'])) == {
    name: evidence['after'] for name, evidence in manifest['changes'].items()
}
assets = {name: row['after'] for name, row in manifest['changes'].items() if name.startswith('public/')}
program = """import assert from 'node:assert/strict';import crypto from 'node:crypto';
const assets=ASSETS;
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
 for(const [name,expected] of Object.entries(assets)){
  const response=await fetch(base+'/'+name.replace('public/',''),{headers:{'Cache-Control':'no-cache'}});
  assert.equal(response.status,200);
  assert.equal(crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),expected);
 }
 const health=await fetch(base+'/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
}
console.log(JSON.stringify({at:new Date().toISOString(),localHealth:200,publicHealth:200,assetsVerified:Object.keys(assets).length}));
""".replace('ASSETS', json.dumps(assets))
result = json.loads(core.run(core.DOCKER + ['exec', '-i', '-w', '/app', 'mbbs-operator-app-app-1',
                                          'node', '--input-type=module'], input=program))
result.update({'appImage': app['Image'], 'runtimeChanges': 0, 'deployedSourcesVerified': len(manifest['changes'])})
for args, name in [(['ps', '--format', '{{.Names}} {{.Status}}'], 'docker-running.log'),
                   (['ps', '-a', '--format', '{{.Names}} {{.Status}}'], 'docker-all.log'),
                   (['network', 'ls', '--format', '{{.Name}}'], 'docker-networks.log'),
                   (['volume', 'ls', '--format', '{{.Name}}'], 'docker-volumes.log')]:
    output = core.run(core.DOCKER + args)
    (ARTIFACT / name).write_text(output)
    assert 'mbbs-to-yard-test-' not in output
production = {'mbbs-operator-app-app-1', 'mbbs-operator-app-db-1', 'mbbs-operator-app-webhook-worker-1',
              'mbbs-operator-app-ollama-1'}
assert {line.split()[0] for line in (ARTIFACT / 'docker-all.log').read_text().splitlines()} == production
for container in production:
    current = core.inspect(container)
    assert current['State']['Running']
    if container != 'mbbs-operator-app-webhook-worker-1':
        assert current['State']['Health']['Status'] == 'healthy'
result['testCleanupVerified'] = True
core.save(ARTIFACT / 'release.json', result)
source = (ROOT / 'server/tools/customer-pickup-lookup-access-live.mjs').read_text()
live = json.loads(core.run(core.DOCKER + ['exec', '-i', '-w', '/app', 'mbbs-operator-app-app-1',
                                       'node', '--input-type=module'], input=source))
core.save(ARTIFACT / 'live.json', live)
print(json.dumps(result))

"""Read-only live asset checks and final disposable-test cleanup verification."""
import json
from pathlib import Path
import subprocess

SERVER = Path(__file__).resolve().parents[1]
RELEASE = SERVER / 'deployments/backorder-already-ordered-20261008'
PRODUCTION = ['mbbs-operator-app-app-1', 'mbbs-operator-app-db-1',
              'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-ollama-1']


def docker(*args, **kwargs):
    return subprocess.check_output(['docker', *args], **kwargs)


result = docker('exec', '-i', PRODUCTION[0], 'node', '--input-type=module',
                input=(SERVER / 'tools/backorder-already-ordered-live.mjs').read_bytes(), timeout=150)
live = json.loads(result)
assert live['passed']
(RELEASE / 'live-check.json').write_text(json.dumps(live, indent=2) + '\n')
containers = {}
for args, name in [(['ps'], 'running'), (['ps', '-a'], 'all')]:
    output = docker(*args, '--format', '{{.Names}}|{{.Status}}').decode()
    (RELEASE / ('final-docker-' + name + '.log')).write_text(output)
    containers[name] = [line.split('|')[0] for line in output.splitlines()]
assert set(containers['all']) == set(PRODUCTION), containers
leftovers = {}
for mode in ['red', 'final', 'proofs', 'probe']:
    label = 'label=com.docker.compose.project=mbbs-already-ordered-' + mode
    for kind in ['network', 'volume']:
        values = docker(kind, 'ls', '-q', '--filter', label).decode().splitlines()
        assert not values, (mode, kind, values)
        leftovers[mode + '-' + kind] = values
health = {}
for name in PRODUCTION:
    running = docker('inspect', '--format', '{{.State.Running}}', name).decode().strip() == 'true'
    assert running
    status = 'running' if 'webhook-worker' in name else docker('inspect', '--format', '{{.State.Health.Status}}', name).decode().strip()
    assert status in ['running', 'healthy']
    health[name] = status
cleanup = {'noTestContainers': True, 'noTaskTestNetworksOrVolumes': True, 'productionHealthy': True,
           'containers': containers, 'testResources': leftovers, 'health': health}
(RELEASE / 'final-cleanup.json').write_text(json.dumps(cleanup, indent=2) + '\n')
print(json.dumps({'livePassed': True, 'noTestContainers': True, 'noTestNetworksOrVolumes': True, 'productionHealthy': True}))

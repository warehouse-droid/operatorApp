"""Verify host cleanup after the correction, preserving operational audit files."""
import json
from pathlib import Path
import subprocess
import urllib.request

SERVER = Path(__file__).resolve().parents[2]
RELEASE = SERVER / 'deployments/return-pallet-balance-sync-20261008'
PRODUCTION = {'mbbs-operator-app-app-1', 'mbbs-operator-app-db-1',
              'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-ollama-1'}

def rows(*args):
    output = subprocess.check_output(['docker', *args, '--format', '{{json .}}']).decode()
    return [json.loads(line) for line in output.splitlines()]

status = {'dockerPs': rows('ps'), 'dockerPsA': rows('ps', '-a'),
          'testContainers': rows('ps', '-a', '--filter', 'label=com.mbbs.lifecycle=disposable-test')}
assert {row['Names'] for row in status['dockerPs']} == PRODUCTION
assert {row['Names'] for row in status['dockerPsA']} == PRODUCTION
assert not status['testContainers']
status['taskResources'] = {}
for mode in ['red', 'green', 'final', 'deployment']:
    project = 'mbbs-return-pallet-balance-' + mode
    result = {'networks': rows('network', 'ls', '--filter', 'label=com.docker.compose.project=' + project),
              'volumes': rows('volume', 'ls', '--filter', 'label=com.docker.compose.project=' + project)}
    assert not any(result.values())
    status['taskResources'][project] = result
with urllib.request.urlopen('http://127.0.0.1:3000/health', timeout=10) as response:
    status['productionHealthy'] = json.load(response)['ok'] is True
assert status['productionHealthy']
(RELEASE / 'cleanup-complete.json').write_text(json.dumps(status, indent=2))
print(json.dumps({'productionHealthy': True, 'productionContainers': 4,
                  'testContainersRemaining': 0, 'taskNetworksRemaining': 0, 'taskVolumesRemaining': 0}))

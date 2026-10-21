"""Verify disposable cleanup and production health without touching other work."""
import datetime
import json
from pathlib import Path
import subprocess
import urllib.request

server = Path(__file__).resolve().parents[2]
release = server / 'deployments/receipt-extra-charges-20261019'
def docker(*args):
    return subprocess.check_output(['docker', *args], text=True).strip()

prefixes = ('mbbs-receipt-extra-charges', 'mbbs-pob04042')
running = docker('ps', '--format', '{{.Names}} {{.Status}}').splitlines()
all_containers = docker('ps', '-a', '--format', '{{.Names}} {{.Status}}').splitlines()
(release / 'final-docker-ps.log').write_text('\n'.join(running) + '\n')
(release / 'final-docker-ps-a.log').write_text('\n'.join(all_containers) + '\n')
assert not any(row.startswith(prefixes) for row in all_containers), 'Task test container remains'
resources = {}
for project in ['mbbs-receipt-extra-charges-test', 'mbbs-pob04042-ir-test']:
    resources[project] = {kind: docker(kind, 'ls', '--filter', f'label=com.docker.compose.project={project}', '--format', '{{.Name}}')
        for kind in ['network', 'volume']}
    assert not any(resources[project].values()), 'Task test network or volume remains'
health = {}
for name in ['mbbs-operator-app-app-1', 'mbbs-operator-app-db-1', 'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-ollama-1']:
    health[name] = json.loads(docker('inspect', '--format', '{{json .State}}', name))
    assert health[name]['Status'] == 'running'
    if 'Health' in health[name]:
        assert health[name]['Health']['Status'] == 'healthy'
    health[name] = {'status': health[name]['Status'], 'health': health[name].get('Health', {}).get('Status')}
with urllib.request.urlopen('http://127.0.0.1:3000/health', timeout=5) as response:
    assert response.status == 200 and json.load(response)['ok']
result = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'taskTestResourcesRemoved': True,
    'resources': resources, 'productionHealth': health,
    'otherActiveTestContainersPreserved': [row for row in all_containers if 'test' in row]}
(release / 'final-cleanup.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))

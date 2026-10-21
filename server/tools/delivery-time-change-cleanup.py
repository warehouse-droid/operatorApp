"""Verify owned disposable resources were removed, without stopping other tasks."""
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

server = Path(__file__).resolve().parents[1]
artifact = server / 'test-artifacts/delivery-time-change-20261008'
release = server / 'deployments/delivery-time-change-20261008'
manifest = json.loads((release / 'manifest.json').read_text())
deployed = (release / 'deployment-result.json').exists()


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True).strip()


production = {'mbbs-operator-app-app-1', 'mbbs-operator-app-db-1',
              'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-ollama-1'}
running = docker('ps', '--format', '{{.Names}} {{.Status}}').splitlines()
all_containers = docker('ps', '-a', '--format', '{{.Names}} {{.Status}}').splitlines()
assert production <= {line.split()[0] for line in running}
resources = {}
for suffix in ['red', 'green', 'red-additions', 'delivery-test', 'po-sales-test']:
    project = 'mbbs-delivery-time-change-' + suffix
    resources[project] = {
        'containers': docker('ps', '-a', '--filter', 'label=com.docker.compose.project=' + project, '--format', '{{.Names}}'),
        **{kind: docker(kind, 'ls', '--filter', 'label=com.docker.compose.project=' + project, '--format', '{{.Name}}')
           for kind in ['network', 'volume']}
    }
    assert all(not value for value in resources[project].values()), resources[project]
for name in ['mbbs-delivery-time-change-baseline-reader', 'mbbs-delivery-time-change-image-check']:
    assert not docker('ps', '-a', '--filter', 'name=^/' + name + '$', '--format', '{{.Names}}')
other = [line for line in all_containers if line.split()[0] not in production]
assert all(line.startswith('mbbs-request-loading-') for line in other), 'Unrecognized test resources require review: ' + repr(other)
health = docker('inspect', '--format', '{{.Name}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}', *sorted(production)).splitlines()
assert all('running healthy' in line if 'webhook-worker' not in line else 'running' in line for line in health), health
live_image = docker('inspect', '--format', '{{.Image}}', 'mbbs-operator-app-app-1')
assert live_image == (manifest['candidateImageId'] if deployed else manifest['app']['imageId']), 'Unexpected live image'
record = {
    'at': datetime.now(timezone.utc).isoformat(), 'allThisTaskTestResourcesRemoved': True,
    'runningContainers': running, 'allContainers': all_containers, 'remainingOwnedResources': resources,
    'separateActiveTaskContainers': other,
    'separateTaskCleanup': 'Request-loading projects use the same registered cleanup wrapper; not interrupted.',
    'productionHealth': health, 'liveImage': live_image,
    'candidateImage': manifest['candidateImageId'], 'deployed': deployed
}
(artifact / 'final-cleanup.json').write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps({'thisTaskCleanupPassed': True, 'separateTaskContainers': len(other), 'productionHealth': health, 'deployed': deployed}))

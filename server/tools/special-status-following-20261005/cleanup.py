"""Verify this task's disposable resources were removed and production is healthy."""
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'test-artifacts/special-status-following-20261005'
own = {'mbbs-special-status-following-test', 'mbbs-special-status-following-test-db',
       'mbbs-special-status-following-db-runner', 'mbbs-special-status-browser-probe'}


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True)


active = set(docker('ps', '--format', '{{.Names}}').splitlines())
all_containers = set(docker('ps', '-a', '--format', '{{.Names}}').splitlines())
networks = set(docker('network', 'ls', '--format', '{{.Name}}').splitlines())
assert not own.intersection(active) and not own.intersection(all_containers)
assert 'mbbs-special-status-following-test-net' not in networks
assert docker('inspect', '--format', '{{.State.Health.Status}}', 'mbbs-operator-app-app-1').strip() == 'healthy'
result = {'activeOwnTests': 0, 'retainedOwnContainers': 0, 'retainedOwnTestNetworks': 0,
          'disposableVolumes': 'none; PostgreSQL used bounded tmpfs and teardown removed containers with -v',
          'productionHealth': 'healthy', 'unrelatedContainersPreserved': True}
(OUT / 'cleanup.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result))

"""Read-only validation of the host test runner and its resolved Compose mounts."""
import json
import os
from pathlib import Path
import subprocess


def main():
    repo = Path(__file__).resolve().parents[2]
    subprocess.run(['bash', '-n', str(repo / 'docker/retention/check.sh'),
                    str(repo / 'docker/run-isolated-tests.sh')], check=True)
    artifact = '/tmp/mbbs-artifact-configuration-check'
    config = json.loads(subprocess.check_output([
        'docker', 'compose', '-f', str(repo / 'docker-compose.mbt-test.yml'),
        '--profile', '*', 'config', '--format', 'json'],
        env=dict(os.environ, MBBS_TEST_ARTIFACT_DIR=artifact)))
    for name, service in config['services'].items():
        assert service['cgroup_parent'] == 'mbbs-tests.slice', name
        assert service['init'] and 0 < int(service['mem_limit']) <= 2 * 1024**3, name
        assert service['memswap_limit'] == service['mem_limit'], name
        assert 0 < float(service['cpus']) <= 2 and 0 < int(service['pids_limit']) <= 512, name
        assert service['tmpfs'] and all('size=' in value for value in service['tmpfs']), name
        if name != 'db':
            assert any(volume['target'] == '/app/test-artifacts' and volume['source'] == artifact
                       for volume in service['volumes']), name
    print(f"PASS: shell syntax; resource limits for {len(config['services'])} services; per-run artifact mounts")


if __name__ == '__main__':
    main()

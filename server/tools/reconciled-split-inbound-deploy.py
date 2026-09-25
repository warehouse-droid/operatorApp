"""Layer the tested calculation helper over each service's existing image."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
BACKUP = Path('/home/ubuntu/operatorapp-deploy-backups/reconciled-split-inbound-20260917')
ARTIFACT = ROOT / 'server/test-artifacts/reconciled-split-inbound'
FILE = 'src/smart-scm-split-inbound-sql.js'
SERVICES = {'app': 'mbbs-operator-app-app-1', 'webhook-worker': 'mbbs-operator-app-webhook-worker-1'}


def command(*args):
    return subprocess.check_output(args, text=True)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def metadata(container):
    return json.loads(command('docker', 'inspect', '--format',
        '{"image":{{json .Config.Image}},"imageId":{{json .Image}},"configFiles":{{json (index .Config.Labels "com.docker.compose.project.config_files")}}}', container))


def live_hash(container):
    return command('docker', 'exec', container, 'sha256sum', '/app/' + FILE).split()[0]


if sys.argv[1] == 'prepare':
    BACKUP.mkdir(parents=True, exist_ok=True)
    assert not (BACKUP / 'manifest.json').exists(), 'Prepared deployment already exists'
    services = {service: metadata(container) for service, container in SERVICES.items()}
    before = digest(ROOT / 'server/test/support/reconciled-split-inbound-baseline.js')
    after = digest(ROOT / 'server' / FILE)
    for service, container in SERVICES.items():
        assert live_hash(container) == before, 'Live helper changed; rebase first'
        stage = BACKUP / service
        (stage / 'src').mkdir(parents=True)
        shutil.copy2(ROOT / 'server' / FILE, stage / FILE)
        subprocess.run(['docker', 'cp', container + ':/app/' + FILE, str(stage / 'before.js')], check=True)
        (stage / 'Dockerfile').write_text('FROM ' + services[service]['image'] + '\nCOPY ' + FILE + ' /app/' + FILE + '\n')
        image = 'mbbs-operator-app:reconciled-split-inbound-20260917-' + service
        services[service]['nextImage'] = image
        subprocess.run(['docker', 'build', '--network', 'none', '--pull=false', '-t', image, str(stage)], check=True)
    (BACKUP / 'compose.release.yml').write_text('services:\n' + ''.join(
        '  ' + service + ':\n    image: ' + info['nextImage'] + '\n' for service, info in services.items()))
    (BACKUP / 'compose.rollback.yml').write_text('services:\n' + ''.join(
        '  ' + service + ':\n    image: ' + info['image'] + '\n' for service, info in services.items()))
    (BACKUP / 'manifest.json').write_text(json.dumps({'services': services, 'before': before, 'after': after}, indent=2))
    print(json.dumps({'prepared': True, 'after': after}))
elif sys.argv[1] == 'apply':
    manifest = json.loads((BACKUP / 'manifest.json').read_text())
    assert digest(ROOT / 'server' / FILE) == manifest['after']
    static = json.loads((ARTIFACT / 'static.json').read_text())
    assert static['sha256'] == manifest['after'] and static['coverage']['lines']['pct'] == 100
    assert all(row['killed'] for row in json.loads((ARTIFACT / 'mutations.json').read_text()))
    suite = json.loads((ARTIFACT / 'suite.json').read_text())
    for row in suite:
        assert row['failures'] == json.loads((ARTIFACT / ('baseline-' + row['order'] + '.json')).read_text())
    assert '# pass 3\n' in (ARTIFACT / 'refresh.log').read_text() and '# fail 0\n' in (ARTIFACT / 'refresh.log').read_text()
    for service, container in SERVICES.items():
        saved = {k: v for k, v in manifest['services'][service].items() if k != 'nextImage'}
        assert metadata(container) == saved and live_hash(container) == manifest['before'], 'Deployment changed; rebase first'
    compose = ['sudo', '-n', 'docker', 'compose', '-p', 'mbbs-operator-app']
    for config in manifest['services']['app']['configFiles'].split(','):
        compose += ['-f', config]
    compose += ['-f', str(BACKUP / 'compose.release.yml'), 'up', '-d', '--no-build', '--no-deps', *SERVICES]
    subprocess.run(compose, cwd=ROOT, check=True)
    health = None
    for _ in range(50):
        try:
            with urlopen('http://127.0.0.1:3000/health', timeout=2) as response:
                health = json.load(response)
                break
        except Exception:
            time.sleep(0.5)
    assert health is not None, 'Application health did not recover'
    for container in SERVICES.values():
        assert live_hash(container) == manifest['after']
    result = {'health': health, 'after': manifest['after'], 'services': {key: metadata(value) for key, value in SERVICES.items()}}
    (BACKUP / 'deployment-result.json').write_text(json.dumps(result, indent=2))
    print(json.dumps({'deployed': True, 'health': health, 'sha256': manifest['after']}))
else:
    raise ValueError('Expected prepare or apply')

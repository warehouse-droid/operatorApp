"""Deploy only the grouped identity fixes over the current app image."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
ARTIFACT = ROOT / 'server/test-artifacts/group-load-identity'
BACKUP = Path('/home/ubuntu/operatorapp-deploy-backups/group-load-identity-20260917')
APP = 'mbbs-operator-app-app-1'
WORKER = 'mbbs-operator-app-webhook-worker-1'
FILES = ['src/co-source-packing-handoff.js', 'src/delivery-repository.js']
INBOUND = 'src/smart-scm-split-inbound-sql.js'
IMAGE = 'mbbs-operator-app:group-load-identity-20260917'


def command(*args):
    return subprocess.check_output(args, text=True)


def metadata(container):
    return json.loads(command('docker', 'inspect', '--format',
        '{"image":{{json .Config.Image}},"imageId":{{json .Image}},"configFiles":{{json (index .Config.Labels "com.docker.compose.project.config_files")}}}', container))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def live_hash(file):
    return command('docker', 'exec', APP, 'sha256sum', '/app/' + file).split()[0]


def compose(manifest, override):
    args = ['sudo', '-n', 'docker', 'compose', '-p', 'mbbs-operator-app']
    for config in manifest['app']['configFiles'].split(','):
        args += ['-f', config]
    args += ['-f', str(BACKUP / override), 'up', '-d', '--no-build', '--no-deps', 'app']
    subprocess.run(args, cwd=ROOT, check=True)


def health():
    for _ in range(60):
        try:
            with urlopen('http://127.0.0.1:3000/health', timeout=1) as response:
                return json.load(response)
        except Exception:
            time.sleep(0.5)
    raise RuntimeError('Application health did not recover')


if sys.argv[1] in ['prepare', 'refresh']:
    if sys.argv[1] == 'refresh':
        previous = json.loads((BACKUP / 'manifest.json').read_text())
        assert not (BACKUP / 'deployment-result.json').exists(), 'Already deployed'
        assert metadata(APP) == previous['app'], 'App changed; rebase first'
    else:
        assert not (BACKUP / 'manifest.json').exists(), 'Deployment already prepared'
    stage = BACKUP / 'stage'
    (stage / 'src').mkdir(parents=True, exist_ok=True)
    (BACKUP / 'before/src').mkdir(parents=True, exist_ok=True)
    manifest = {'app': metadata(APP), 'worker': metadata(WORKER), 'before': {}, 'after': {},
                'preservedInboundHash': live_hash(INBOUND), 'image': IMAGE}
    for file in FILES:
        before = digest(ARTIFACT / 'baseline' / file)
        assert live_hash(file) == before, 'Live module changed: ' + file
        manifest['before'][file] = before
        manifest['after'][file] = digest(ROOT / 'server' / file)
        shutil.copy2(ROOT / 'server' / file, stage / file)
        subprocess.run(['docker', 'cp', APP + ':/app/' + file, str(BACKUP / 'before' / file)], check=True)
    (stage / 'Dockerfile').write_text('FROM ' + manifest['app']['image'] + '\n' + ''.join(
        'COPY ' + file + ' /app/' + file + '\n' for file in FILES))
    subprocess.run(['docker', 'build', '--network', 'none', '--pull=false', '-t', IMAGE, str(stage)], check=True)
    (BACKUP / 'compose.release.yml').write_text('services:\n  app:\n    image: ' + IMAGE + '\n')
    (BACKUP / 'compose.rollback.yml').write_text('services:\n  app:\n    image: ' + manifest['app']['image'] + '\n')
    (BACKUP / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    print(json.dumps({'prepared': True, 'sourceHashes': manifest['after']}))
elif sys.argv[1] == 'apply':
    manifest = json.loads((BACKUP / 'manifest.json').read_text())
    assert metadata(APP) == manifest['app'], 'App changed; rebase first'
    assert metadata(WORKER) == manifest['worker'], 'Worker changed; recheck deployment scope'
    for file in FILES:
        assert live_hash(file) == manifest['before'][file]
        assert digest(ROOT / 'server' / file) == manifest['after'][file]
    for evidence in ['suite', 'static', 'coverage', 'mutations']:
        result = json.loads((ARTIFACT / (evidence + '.json')).read_text())
        assert result['sourceHashes'] == manifest['after'], evidence + ': stale source hashes'
        if evidence == 'suite':
            assert len(result['summary']) == 2 and all(not row['failures'] for row in result['summary'])
        elif evidence == 'static':
            assert result['newFindings'] == 0
        elif evidence == 'coverage':
            assert all(row['total'] == row['executed'] and not row['missing'] for row in result['changed'].values())
        else:
            assert len(result['results']) == 5 and all(row['killed'] for row in result['results'])
    red = (ARTIFACT / 'red.log').read_text()
    assert 'invalid input syntax for type bigint: "GOA-8601-8604"' in red and 'invalid input syntax for type bigint: "GRPLINE-' in red
    try:
        compose(manifest, 'compose.release.yml')
        status = health()
        assert all(live_hash(file) == manifest['after'][file] for file in FILES)
        assert live_hash(INBOUND) == manifest['preservedInboundHash']
        assert metadata(WORKER) == manifest['worker']
    except Exception:
        compose(manifest, 'compose.rollback.yml')
        health()
        raise
    result = {'deployed': True, 'health': status, 'sourceHashes': manifest['after'],
              'preservedInboundHash': live_hash(INBOUND), 'workerUnchanged': True, 'app': metadata(APP)}
    (BACKUP / 'deployment-result.json').write_text(json.dumps(result, indent=2))
    print(json.dumps({key: value for key, value in result.items() if key != 'app'}))
else:
    raise ValueError('Expected prepare or apply')

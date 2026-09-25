"""Release verified app modules and queue worker modules on their respective live bases."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
ARTIFACT = ROOT / 'server/test-artifacts/load-followup'
BACKUP = Path('/home/ubuntu/operatorapp-deploy-backups/load-followup-20260917')
APP = 'mbbs-operator-app-app-1'
WORKER = 'mbbs-operator-app-webhook-worker-1'
EXISTING = json.loads((ARTIFACT / 'files.json').read_text())
NEW = ['src/operator-load-state.js', 'src/operator-load-state-repository.js']
FILES = EXISTING + NEW
QUEUE = ['src/netsuite-order-webhook-queue-policy.js', 'src/netsuite-order-webhook-queue-repository.js']
PRESERVED = ['src/receiving-repository.js', 'src/receiving-receipt-progress.js', 'src/operator-netsuite-posting-targets.js',
             'src/operator-netsuite-posting-stored-lines.js', 'src/operator-background-photos.js',
             'src/smart-scm-split-inbound-sql.js', 'public/operator.css', 'public/operator-photo-outbox.js',
             'public/i18n.js', 'public/operator-receiving-confirmation.css']
IMAGES = {'app': 'mbbs-operator-app:load-followup-20260917',
          'worker': 'mbbs-operator-app:load-followup-20260917-webhook-worker'}


def command(*args):
    return subprocess.check_output(args, text=True)


def metadata(container):
    return json.loads(command('docker', 'inspect', '--format',
        '{"image":{{json .Config.Image}},"imageId":{{json .Image}},"configFiles":{{json (index .Config.Labels "com.docker.compose.project.config_files")}}}', container))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source(file):
    return (ARTIFACT / 'release' if file.startswith('public/') else ROOT / 'server') / file


def live_hash(file, container=APP):
    if subprocess.run(['docker', 'exec', container, 'test', '-f', '/app/' + file]).returncode:
        return None
    return command('docker', 'exec', container, 'sha256sum', '/app/' + file).split()[0]


def compose_args(metadata):
    args = ['sudo', '-n', 'docker', 'compose', '-p', 'mbbs-operator-app']
    for config in metadata['configFiles'].split(','):
        args += ['-f', config]
    return args


def compose(manifest, override):
    subprocess.run(compose_args(manifest['app']) + ['-f', str(BACKUP / override), 'up', '-d',
        '--no-build', '--no-deps', 'app', 'webhook-worker'], cwd=ROOT, check=True)


def health():
    for _ in range(60):
        try:
            with urlopen('http://127.0.0.1:3000/health', timeout=1) as response:
                return json.load(response)
        except Exception:
            time.sleep(0.5)
    raise RuntimeError('Application health did not recover')


def verified_evidence():
    expected = {file: digest(ROOT / 'server' / file) for file in FILES if file.startswith('src/')}
    for name in ['suite', 'static', 'coverage', 'mutations', 'shuffle', 'full-comparison']:
        report = json.loads((ARTIFACT / (name + '.json')).read_text())
        for file, value in expected.items():
            assert report['sourceHashes'][file] == value, name + ': stale ' + file
        if name == 'suite':
            assert report['status'] == 0
        elif name == 'static':
            assert not report['newLint'] and not report['newTypes']
        elif name == 'coverage':
            assert not report['missing'], 'Changed backend lines need coverage'
        elif name == 'mutations':
            assert len(report['results']) == 9 and all(row['killed'] for row in report['results'])
        elif name == 'shuffle':
            assert all('# fail 0' in row['counts'] for row in report['results'])
        elif name == 'full-comparison':
            assert not report['newFailures']
    browser = json.loads((ARTIFACT / 'browser.json').read_text())
    assert browser['sourceHashes'] == {file: digest(source(file)) for file in FILES if file.startswith('public/')}
    assert len(browser['results']) == 17 and all(not row['errors'] for row in browser['results'])
    repair = json.loads((ARTIFACT / 'repair-dry-run.json').read_text())
    assert repair['beforeHash'] == repair['afterHash'] and repair['result']['completed']


mode = sys.argv[1]
if mode == 'prepare':
    assert not (BACKUP / 'manifest.json').exists(), 'Release already prepared'
    manifest = {'app': metadata(APP), 'worker': metadata(WORKER), 'before': {}, 'after': {},
        'workerBefore': {}, 'preserved': {file: live_hash(file) for file in PRESERVED}, 'images': IMAGES}
    assert manifest['app'] == json.loads((ARTIFACT / 'live-before.json').read_text()), 'App base changed'
    assert manifest['worker'] == json.loads((ARTIFACT / 'worker-before.json').read_text()), 'Worker base changed'
    for kind, files, container in [('app', FILES, APP), ('worker', QUEUE, WORKER)]:
        stage = BACKUP / ('stage-' + kind)
        for file in files:
            baseline = ARTIFACT / ('live-before' if kind == 'app' else 'worker-before') / file
            before = None if file in NEW else digest(baseline)
            assert live_hash(file, container) == before, 'Live module changed: ' + kind + '/' + file
            (manifest['before'] if kind == 'app' else manifest['workerBefore'])[file] = before
            manifest['after'][file] = digest(source(file))
            (stage / file).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source(file), stage / file)
            if before:
                destination = BACKUP / ('before-' + kind) / file
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(baseline, destination)
        assert command('docker', 'image', 'inspect', '--format', '{{.Id}}', manifest[kind]['image']).strip() == manifest[kind]['imageId']
        (stage / 'Dockerfile').write_text('FROM ' + manifest[kind]['image'] + '\n' + ''.join(
            'COPY ' + file + ' /app/' + file + '\n' for file in files))
        subprocess.run(['docker', 'build', '--network', 'none', '--pull=false', '-t', IMAGES[kind], str(stage)], check=True)
    for name, images in [('release', IMAGES), ('rollback', {kind: manifest[kind]['image'] for kind in IMAGES})]:
        (BACKUP / ('compose.' + name + '.yml')).write_text('services:\n  app:\n    image: ' + images['app'] +
            '\n  webhook-worker:\n    image: ' + images['worker'] + '\n')
    old_worker = json.loads(command(*compose_args(manifest['worker']), 'config', '--format', 'json'))['services']['webhook-worker']
    new_config = json.loads(command(*compose_args(manifest['app']), '-f', str(BACKUP / 'compose.release.yml'), 'config', '--format', 'json'))
    new_worker = new_config['services']['webhook-worker']
    old_worker.pop('image'); new_worker.pop('image')
    assert old_worker == new_worker, 'Worker configuration changed beyond its image'
    (BACKUP / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    print(json.dumps({'prepared': True, 'images': IMAGES, 'sourceHashes': manifest['after']}))
elif mode == 'apply':
    manifest = json.loads((BACKUP / 'manifest.json').read_text())
    assert metadata(APP) == manifest['app'], 'App base changed'
    assert metadata(WORKER) == manifest['worker'], 'Worker base changed'
    for file in FILES:
        assert live_hash(file) == manifest['before'][file]
        assert digest(source(file)) == manifest['after'][file]
    for file in QUEUE:
        assert live_hash(file, WORKER) == manifest['workerBefore'][file]
    verified_evidence()
    try:
        compose(manifest, 'compose.release.yml')
        status = health()
        assert all(live_hash(file) == manifest['after'][file] for file in FILES)
        assert all(live_hash(file, WORKER) == manifest['after'][file] for file in QUEUE)
        assert all(live_hash(file) == value for file, value in manifest['preserved'].items())
        assert command('docker', 'inspect', '--format', '{{.State.Running}}', WORKER).strip() == 'true'
        with urlopen('http://127.0.0.1:3000/operator') as response:
            assert b'20260917-load-followup-v1' in response.read()
    except Exception:
        compose(manifest, 'compose.rollback.yml')
        health()
        raise
    result = {'deployed': True, 'health': status, 'sourceHashes': manifest['after'],
        'preserved': manifest['preserved'], 'app': metadata(APP), 'worker': metadata(WORKER)}
    (BACKUP / 'deployment-result.json').write_text(json.dumps(result, indent=2))
    print(json.dumps({'deployed': True, 'health': status, 'images': IMAGES}))
else:
    raise ValueError('Expected prepare or apply')

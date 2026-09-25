"""Release only the verified receiving modules and popup over the current app."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
ARTIFACT = ROOT / 'server/test-artifacts/receiving-followup'
BACKUP = Path('/home/ubuntu/operatorapp-deploy-backups/receiving-followup-20260917')
APP = 'mbbs-operator-app-app-1'
WORKER = 'mbbs-operator-app-webhook-worker-1'
BACKEND = ['src/receiving-repository.js', 'src/operator-netsuite-posting-targets.js', 'src/receiving-receipt-progress.js']
FRONTEND = ['public/operator.js', 'public/operator.html', 'public/service-worker.js', 'public/operator-receiving-confirmation.css']
FILES = BACKEND + FRONTEND
ADDED = {'src/receiving-receipt-progress.js', 'public/operator-receiving-confirmation.css'}
PRESERVED = ['src/smart-scm-split-inbound-sql.js', 'src/co-source-packing-handoff.js', 'src/delivery-repository.js',
             'src/operator-netsuite-posting-stored-lines.js', 'public/operator.css', 'public/i18n.js']
IMAGE = 'mbbs-operator-app:receiving-followup-20260917'


def command(*args):
    return subprocess.check_output(args, text=True)


def metadata(container):
    return json.loads(command('docker', 'inspect', '--format',
        '{"image":{{json .Config.Image}},"imageId":{{json .Image}},"configFiles":{{json (index .Config.Labels "com.docker.compose.project.config_files")}}}', container))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source(file):
    return (ARTIFACT / 'release' if file in FRONTEND else ROOT / 'server') / file


def live_hash(file):
    exists = subprocess.run(['docker', 'exec', APP, 'test', '-f', '/app/' + file]).returncode == 0
    return command('docker', 'exec', APP, 'sha256sum', '/app/' + file).split()[0] if exists else None


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
    manifest = {'app': metadata(APP), 'worker': metadata(WORKER), 'before': {}, 'after': {},
                'preserved': {file: live_hash(file) for file in PRESERVED}, 'image': IMAGE}
    for file in FILES:
        baseline = (ARTIFACT / ('live-before' if file in FRONTEND else 'baseline')) / file
        before = None if file in ADDED else digest(baseline)
        assert live_hash(file) == before, 'Live file changed; rebase first: ' + file
        manifest['before'][file] = before
        manifest['after'][file] = digest(source(file))
        (stage / file).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source(file), stage / file)
        if before:
            destination = BACKUP / 'before' / file
            destination.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(['docker', 'cp', APP + ':/app/' + file, str(destination)], check=True)
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
    assert metadata(WORKER) == manifest['worker'], 'Worker changed; review scope'
    for file in FILES:
        assert live_hash(file) == manifest['before'][file]
        assert digest(source(file)) == manifest['after'][file]
    expected_backend = {file: manifest['after'][file] for file in BACKEND}
    for evidence in ['suite', 'static', 'coverage', 'mutations', 'property-mutations', 'shuffle', 'full-comparison', 'live-candidate']:
        result = json.loads((ARTIFACT / (evidence + '.json')).read_text())
        assert result['sourceHashes'] == expected_backend, evidence + ': stale source hashes'
        if evidence == 'suite':
            assert all(not row['failures'] for row in result['summary'])
        elif evidence == 'static':
            assert result['newFindings'] == 0
        elif evidence == 'coverage':
            assert all(row['total'] == row['executed'] and not row['missing'] for row in result['changed'].values())
        elif evidence == 'mutations':
            assert len(result['results']) == 6 and all(row['killed'] for row in result['results'])
        elif evidence == 'shuffle':
            assert len(result['results']) == 18 and all('# fail 0' in row['counts'] for row in result['results'])
        elif evidence == 'full-comparison':
            assert result['candidate']['files'] == result['baseline']['files'] + 3 and not result['newFailures']
        elif evidence == 'live-candidate':
            assert result['readOnly'] and not result['receiptSubmitted']
    browser = json.loads((ARTIFACT / 'browser.json').read_text())
    assert browser['sourceHashes'] == {file: manifest['after'][file] for file in FRONTEND}
    assert len(browser['results']) == 4 and all(row['browserErrors'] == row['receiptSubmissions'] == 0 for row in browser['results'])
    assert browser['changedLineCoverage']['executed'] > 0 and not browser['changedLineCoverage']['missing']
    red = (ARTIFACT / 'red.log').read_text()
    assert re.search(r'# fail [1-9]\d*', red) and 'IR14645 leaves only the 28-pallet line visible' in red
    try:
        compose(manifest, 'compose.release.yml')
        status = health()
        assert all(live_hash(file) == manifest['after'][file] for file in FILES)
        assert all(live_hash(file) == value for file, value in manifest['preserved'].items())
        assert metadata(WORKER) == manifest['worker']
        with urlopen('http://127.0.0.1:3000/operator') as response:
            assert b'20260917-receiving-followup-v1' in response.read()
    except Exception:
        compose(manifest, 'compose.rollback.yml')
        health()
        raise
    result = {'deployed': True, 'health': status, 'sourceHashes': manifest['after'],
              'preserved': manifest['preserved'], 'workerUnchanged': True, 'app': metadata(APP)}
    (BACKUP / 'deployment-result.json').write_text(json.dumps(result, indent=2))
    print(json.dumps({key: value for key, value in result.items() if key != 'app'}))
else:
    raise ValueError('Expected prepare or apply')

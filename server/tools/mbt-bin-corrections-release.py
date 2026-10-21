#!/usr/bin/env python3
"""Prepare, validate and release only the BIN pricing, delivery readiness and planning corrections over the live app."""
import difflib
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time

SERVER = Path(__file__).resolve().parents[1]
REPO = SERVER.parent
OUT = SERVER / 'test-artifacts/mbt-bin-corrections-20261015'
RELEASE = SERVER / 'deployments/mbt-bin-corrections-20261015'
APP = 'mbbs-operator-app-app-1'
DB = 'mbbs-operator-app-db-1'
WORKER = 'mbbs-operator-app-webhook-worker-1'
IMAGE = 'mbbs-operator-app:mbt-bin-corrections-20261015'
TEST_IMAGE = 'mbbs-operator-app:mbt-bin-corrections-browser-test-20261015'
BASE_IMAGE = 'mbbs-operator-app:mbt-bin-corrections-rollback-20261015'
OLD = ['public/mbt-frontdesk.js', 'public/mbt-frontdesk.html', 'public/mbt-planning.js',
       'src/mbt/frontdesk-service.js', 'src/mbt/customer-charge-request-service.js',
       'src/mbt/customer-charge-calculator.js', 'src/mbt/bin-dispatch-service.js']
NEW = ['src/mbt/frontdesk-bin-readiness.js']


def docker(*args, data=None):
    return subprocess.check_output(['sudo', '-n', 'docker', *args], input=data).decode().strip()

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + '\n')

def metadata(name):
    row = json.loads(docker('inspect', name))[0]
    config = {key: row['Config'][key] for key in ['Env', 'User', 'Entrypoint', 'Cmd', 'WorkingDir']}
    config['Env'] = sorted(config['Env'])
    host = dict(row['HostConfig'])
    host['Binds'] = sorted(host.get('Binds') or [])
    digest = hashlib.sha256(json.dumps({'config': config, 'host': host}, sort_keys=True).encode()).hexdigest()
    return {'imageId': row['Image'], 'imageRef': row['Config']['Image'], 'configurationHash': digest,
            'compose': row['Config']['Labels']}

def compose(state, override):
    labels = state['app']['compose']
    args = ['sudo', '-n', 'docker', 'compose', '-p', labels['com.docker.compose.project'],
            '--project-directory', labels['com.docker.compose.project.working_dir']]
    if labels.get('com.docker.compose.project.environment_file'):
        args += ['--env-file', labels['com.docker.compose.project.environment_file']]
    for filename in labels['com.docker.compose.project.config_files'].split(','):
        args += ['-f', filename]
    return args + ['-f', str(override)]

def logged(label, args):
    with (OUT / (label + '.log')).open('w') as log:
        result = subprocess.run(args, cwd=REPO, stdout=log, stderr=subprocess.STDOUT, timeout=600)
    if result.returncode:
        print((OUT / (label + '.log')).read_text()[-5000:])
    assert result.returncode == 0, label + ' failed'

def health():
    for _ in range(45):
        result = subprocess.run(['curl', '-fsS', '--max-time', '3', 'http://127.0.0.1:3000/health'], capture_output=True)
        if result.returncode == 0 and json.loads(result.stdout).get('ok'):
            return True
        time.sleep(1)
    return False

def db(sql):
    return docker('exec', '-i', DB, 'sh', '-c',
        'psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"', data=sql.encode())

def prepare():
    OUT.mkdir(parents=True, exist_ok=True)
    assert json.loads((OUT / 'validation.all.json').read_text())['passed'], 'Complete the gauntlet first'
    RELEASE.mkdir(parents=True, exist_ok=True)
    state_path = RELEASE / 'state.json'
    if state_path.exists():
        state = json.loads(state_path.read_text())
        assert metadata(APP) == state['app'], 'The live app changed; rebase preparation before release'
    else:
        state = {'app': metadata(APP), 'worker': metadata(WORKER), 'db': metadata(DB)}
        for filename in OLD:
            target = RELEASE / 'before' / filename
            target.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(['sudo', '-n', 'docker', 'cp', APP + ':/app/' + filename, str(target)], check=True)
        save(state_path, state)
    context = RELEASE / 'context'
    context.mkdir(parents=True, exist_ok=True)
    patches = []
    for filename in OLD:
        before = RELEASE / 'before' / filename
        baseline = OUT / 'baseline' / filename
        assert sha(before) == docker('exec', APP, 'sha256sum', '/app/' + filename).split()[0]
        result = subprocess.run(['git', 'merge-file', '-p', str(before), str(baseline), str(SERVER / filename)], capture_output=True)
        assert result.returncode == 0, 'Source merge requires review: ' + filename
        target = context / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(result.stdout)
        patches.extend(difflib.unified_diff(before.read_text().splitlines(keepends=True), target.read_text().splitlines(keepends=True),
            fromfile='production/' + filename, tofile='candidate/' + filename))
    for filename in NEW:
        target = context / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(SERVER / filename, target)
    docker('tag', state['app']['imageId'], BASE_IMAGE)
    (context / '.dockerignore').write_text('/Dockerfile\n/.dockerignore\n')
    (context / 'Dockerfile').write_text('FROM ' + BASE_IMAGE + '\nCOPY --link . /app/\n')
    logged('candidate-build', ['sudo', '-n', 'docker', 'build', '--network=none', '-t', IMAGE, str(context)])
    test_context = RELEASE / 'test-context'
    test_context.mkdir(exist_ok=True)
    (test_context / 'Dockerfile').write_text('FROM ' + IMAGE + ' AS runtime\nFROM mbbs-operator-app:mbr-signing-defaults-browser-test-20261014\nCOPY --from=runtime /app /app\n')
    logged('candidate-browser-build', ['sudo', '-n', 'docker', 'build', '--network=none', '-t', TEST_IMAGE, str(test_context)])
    hashes = {name: sha(context / name) for name in OLD + NEW}
    workspace = {name: sha(SERVER / name) for name in OLD + NEW}
    prepared = {'image': IMAGE, 'imageId': json.loads(docker('image', 'inspect', IMAGE))[0]['Id'],
                'testImage': TEST_IMAGE, 'testImageId': json.loads(docker('image', 'inspect', TEST_IMAGE))[0]['Id'],
                'sourceHashes': hashes, 'workspaceHashes': workspace}
    save(OUT / 'prepared.json', prepared)
    save(RELEASE / 'compose.release.json', {'services': {'app': {'image': IMAGE}}})
    save(RELEASE / 'compose.rollback.json', {'services': {'app': {'image': BASE_IMAGE}}})
    (OUT / 'production.patch').write_text(''.join(patches))
    print(json.dumps({'prepared': IMAGE, 'runtimeFiles': len(hashes), 'otherServicesPreserved': True}))

def deploy():
    state = json.loads((RELEASE / 'state.json').read_text())
    prepared = json.loads((OUT / 'prepared.json').read_text())
    validated = json.loads((OUT / 'validation.candidate.json').read_text())
    assert validated['passed'] and validated['cleanupVerified']
    assert json.loads(docker('image', 'inspect', IMAGE))[0]['Id'] == prepared['imageId']
    assert json.loads(docker('image', 'inspect', TEST_IMAGE))[0]['Id'] == prepared['testImageId']
    for name, expected in prepared['workspaceHashes'].items():
        assert sha(SERVER / name) == expected, 'Workspace changed after candidate build: ' + name
        assert validated['sourceHashes'][name] == expected, 'Source changed after candidate checks: ' + name
    for name, expected in prepared['sourceHashes'].items():
        assert sha(RELEASE / 'context' / name) == expected, 'Candidate changed after validation: ' + name
    for name, key in [(APP, 'app'), (WORKER, 'worker'), (DB, 'db')]:
        assert metadata(name) == state[key], name + ' changed since preparation'
    try:
        logged('production-deploy', compose(state, RELEASE / 'compose.release.json') + ['up', '-d', '--no-deps', '--no-build', 'app'])
        assert health(), 'Application health did not recover'
        current = metadata(APP)
        assert current['imageId'] == prepared['imageId']
        assert current['configurationHash'] == state['app']['configurationHash'], 'Application configuration changed'
        assert metadata(WORKER) == state['worker'] and metadata(DB) == state['db']
        verify()
    except BaseException:
        logged('production-rollback', compose(state, RELEASE / 'compose.rollback.json') + ['up', '-d', '--no-deps', '--no-build', 'app'])
        assert health(), 'Rollback health failed'
        raise
    save(OUT / 'deployment.json', {'image': IMAGE, 'imageId': prepared['imageId'], 'healthy': True,
        'schemaUnchanged': True, 'otherServicesPreserved': True, 'configurationPreserved': True})
    print(json.dumps({'deployed': IMAGE, 'healthy': True, 'binCorrections': True}))

def verify():
    prepared = json.loads((OUT / 'prepared.json').read_text())
    for name, expected in prepared['sourceHashes'].items():
        assert docker('exec', APP, 'sha256sum', '/app/' + name).split()[0] == expected, name
    results = []
    for path, expected in [('/health', 200), ('/mbt/frontdesk', 200), ('/mbt/planning', 200),
                           ('/mbt-frontdesk.js', 200), ('/mbt-planning.js', 200),
                           ('/api/mbt/planning?planDate=2026-10-15', 401)]:
        status = subprocess.check_output(['curl', '-sS', '--max-time', '15', '-o', '/dev/null', '-w', '%{http_code}', 'http://127.0.0.1:3000' + path], text=True)
        assert int(status) == expected, path + ': ' + status
        results.append({'path': path, 'status': int(status)})
    save(OUT / 'live-verification.json', {'sourceHashesVerified': True, 'schemaUnchanged': True, 'http': results})
    print(json.dumps({'liveVerification': 'passed', 'schemaUnchanged': True}))

if __name__ == '__main__':
    {'prepare': prepare, 'deploy': deploy, 'verify': verify}[sys.argv[1]]()

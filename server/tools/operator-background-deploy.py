"""Deploy the verified photo overlay without replacing the webhook worker."""
from pathlib import Path
import hashlib
import json
import subprocess
import sys
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[2]
ARTIFACT = ROOT / 'server/test-artifacts/operator-background-photos'
RELEASE = ARTIFACT / 'release'
APP = 'mbbs-operator-app-app-1'
WORKER = 'mbbs-operator-app-webhook-worker-1'
IMAGE = 'mbbs-operator-app:background-photos-20260917'

def command(*args):
    return subprocess.check_output(args, text=True)

def metadata(container):
    return json.loads(command('docker', 'inspect', '--format',
        '{"image":{{json .Config.Image}},"imageId":{{json .Image}},"configFiles":{{json (index .Config.Labels "com.docker.compose.project.config_files")}}}', container))

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def current(manifest):
    assert metadata(APP) == manifest['app'], 'Running app changed; repackage and verify first'
    assert metadata(WORKER) == manifest['worker'], 'Webhook worker changed; recheck release scope'
    for file, expected in manifest['after'].items():
        assert digest(RELEASE / 'stage' / file) == expected, 'Candidate changed: ' + file
        assert digest(ROOT / 'server' / file) == manifest['workspace'][file], 'Workspace changed: ' + file

def verification(manifest):
    for order in ['forward', 'reverse']:
        report = json.loads((ARTIFACT / ('suite-' + order + '.json')).read_text())
        for file, value in report['sourceHashes'].items(): assert value == manifest['after'][file], 'Stale suite: ' + file
        assert all(len(result['baselineFailures']) == 2 for result in report['results'])
    static = json.loads((ARTIFACT / 'static-diff.json').read_text())
    assert not static['newLint'] and not static['newTypes']
    coverage = json.loads((ARTIFACT / 'coverage/coverage-summary.json').read_text())['total']
    assert coverage['lines']['pct'] == 100 and coverage['branches']['pct'] >= 90
    assert all(value['killed'] for value in json.loads((ARTIFACT / 'mutations.json').read_text())['results'])
    for name in ['outbox', 'migrations', 'release-schema']:
        output = (ARTIFACT / ('final-' + name + '.log')).read_text()
        assert '# fail 0' in output and '\nnot ok ' not in output, 'Unsuccessful check: ' + name
    replay = json.loads((ROOT / 'server/test-artifacts/local-load-performance/replay/background-final-750kbps.json').read_text())
    assert replay['timings'][0]['totalMs'] < 1000 and not replay['errors']
    assert replay['timings'][1]['survivingRefresh'] and replay['timings'][1]['deviceQueueRemaining'] == 0
    for name in ['final-suite-forward.log', 'final-suite-reverse.log', 'final-static.log', 'final-coverage.log', 'final-mutations.log', 'final-outbox.log', 'final-replay.log']:
        assert (ARTIFACT / name).stat().st_mtime >= (RELEASE / 'manifest.json').stat().st_mtime, 'Stale evidence: ' + name

def database(sql):
    return subprocess.run(['docker', 'exec', '-i', 'mbbs-operator-app-db-1', 'psql', '-U', 'mbbs_app', '-d', 'mbbs_yard', '-X', '-v', 'ON_ERROR_STOP=1', '-At'],
                          input=sql, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True).stdout

def compose(manifest, override):
    args = ['sudo', '-n', 'docker', 'compose', '-p', 'mbbs-operator-app']
    for file in manifest['app']['configFiles'].split(','): args += ['-f', file]
    args += ['-f', str(RELEASE / override), 'up', '-d', '--no-build', '--no-deps', 'app']
    subprocess.run(args, cwd=ROOT, check=True)

def health():
    for _ in range(60):
        try:
            with urlopen('http://127.0.0.1:3000/health', timeout=1) as response: return json.load(response)
        except Exception: time.sleep(0.5)
    raise RuntimeError('Application health did not recover')

manifest = json.loads((RELEASE / 'manifest.json').read_text())
current(manifest)
if sys.argv[1] == 'build':
    assert command('docker', 'image', 'inspect', '--format', '{{.Id}}', manifest['app']['image']).strip() == manifest['app']['imageId']
    subprocess.run(['docker', 'build', '--network', 'none', '--pull=false', '-t', IMAGE, str(RELEASE / 'stage')], check=True)
    (RELEASE / 'compose.release.yml').write_text('services:\n  app:\n    image: ' + IMAGE + '\n')
    (RELEASE / 'compose.rollback.yml').write_text('services:\n  app:\n    image: ' + manifest['app']['image'] + '\n')
    print(json.dumps({'built': IMAGE}))
elif sys.argv[1] == 'apply':
    verification(manifest)
    filename = '204_operator_background_photos.sql'
    if not database("SELECT filename FROM schema_migrations WHERE filename='" + filename + "';").strip():
        sql = 'BEGIN;\n' + (RELEASE / 'stage/migrations' / filename).read_text() + "\nINSERT INTO schema_migrations(filename) VALUES ('" + filename + "');\nCOMMIT;\n"
        (RELEASE / 'migration-apply.log').write_text(database(sql))
    try:
        compose(manifest, 'compose.release.yml')
        status = health()
        for file, expected in manifest['after'].items():
            assert command('docker', 'exec', APP, 'sha256sum', '/app/' + file).split()[0] == expected, 'Live source mismatch: ' + file
        assert metadata(WORKER) == manifest['worker'], 'Webhook worker was changed'
        with urlopen(Request('http://127.0.0.1:3000/operator', headers={'Cache-Control': 'no-cache'})) as response:
            assert b'operator-photo-outbox.js?v=20260917-background-photos-v1' in response.read()
        try:
            urlopen('http://127.0.0.1:3000/api/operator/photo-actions/00000000-0000-4000-8000-000000000000')
            raise AssertionError('Photo action endpoint allowed an unauthenticated request')
        except HTTPError as error: assert error.code == 401
    except Exception:
        # Older code cannot resolve accepted photo aliases. Never roll back past
        # accepted device evidence; keep the durable queue for a forward repair.
        if database('SELECT count(*) FROM operator_photo_actions;').strip() == '0':
            compose(manifest, 'compose.rollback.yml')
            health()
        raise
    result = {'deployed': True, 'image': IMAGE, 'health': status, 'sourceHashes': manifest['after'], 'webhookWorkerUnchanged': True,
              'migration': filename, 'productionTestLoads': 0}
    (RELEASE / 'deployment-result.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result))
else:
    raise ValueError('Expected build or apply')

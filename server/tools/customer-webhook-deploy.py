"""Release the customer endpoint over the captured live image; retain rollback."""
import datetime
import difflib
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
SERVER = ROOT / 'server'
STATE = pathlib.Path('/home/ubuntu/operatorapp-deploy-backups/customer-webhook-20261009')
ARTIFACT = SERVER / 'deployments/customer-webhook-20261009'
APP = 'mbbs-operator-app-app-1'
OTHERS = ['mbbs-operator-app-db-1', 'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-ollama-1']
FILES = ['src/server.js', 'src/netsuite-customer-webhook.js', 'src/netsuite-customer-webhook-router.js']
TAG = 'mbbs-operator-app:customer-webhook-20261009'
ROLLBACK = 'mbbs-operator-app:customer-webhook-rollback-20261009'


def run(args, **kwargs):
    return subprocess.check_output(args, cwd=ROOT, text=True, **kwargs)


def inspect(name):
    return json.loads(run(['docker', 'inspect', name]))[0]


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')
    path.chmod(0o600)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def runtime_hashes():
    script = "const fs=require('fs'),c=require('crypto');console.log(JSON.stringify(Object.fromEntries(JSON.parse(process.argv[1]).map(n=>[n,fs.existsSync('/app/'+n)?c.createHash('sha256').update(fs.readFileSync('/app/'+n)).digest('hex'):null]))));"
    return json.loads(run(['docker', 'exec', APP, 'node', '-e', script, json.dumps(FILES)]))


def compose(before, filename):
    labels = before['app']['Config']['Labels']
    args = ['sudo', '-n', 'docker', 'compose', '--project-name', labels['com.docker.compose.project'],
            '--project-directory', labels['com.docker.compose.project.working_dir']]
    if labels.get('com.docker.compose.project.environment_file'):
        args += ['--env-file', labels['com.docker.compose.project.environment_file']]
    for path in labels['com.docker.compose.project.config_files'].split(','):
        args += ['-f', path]
    return args + ['-f', str(STATE / filename)]


def prepare():
    assert not (STATE / 'before.private.json').exists(), 'Preserve existing release capture'
    before = {'app': inspect(APP), 'others': {name: inspect(name) for name in OTHERS}}
    save(STATE / 'before.private.json', before)
    source_state = json.loads((SERVER / 'test-artifacts/customer-webhook/final/source-state.json').read_text())
    for name in FILES[1:]:
        assert digest(SERVER / name) == source_state['hashes'][name], 'New webhook source changed since validation'
    overlay = STATE / 'image/overlay/src'
    overlay.mkdir(parents=True)
    original = STATE / 'before-server.js'
    run(['docker', 'cp', f'{APP}:/app/src/server.js', str(original)])
    source = original.read_text()
    assert 'createCustomerWebhookRouter' not in source, 'Endpoint already present in captured release'
    anchor = 'app.use(express.json({'
    assert source.count(anchor) == 1, 'General JSON parser must be unique'
    candidate = "import { createCustomerWebhookRouter } from './netsuite-customer-webhook-router.js';\n" + source.replace(
        anchor, "// Customer webhooks authenticate and bound their payload before the general parser.\n"
        "app.use('/api/webhooks/netsuite/customer', createCustomerWebhookRouter());\n\n" + anchor)
    (overlay / 'server.js').write_text(candidate)
    for name in FILES[1:]:
        shutil.copy2(SERVER / name, overlay / pathlib.Path(name).name)
    (ARTIFACT / 'server.patch').write_text(''.join(difflib.unified_diff(source.splitlines(True), candidate.splitlines(True),
        fromfile='a/src/server.js', tofile='b/src/server.js')))
    run(['docker', 'tag', before['app']['Image'], ROLLBACK])
    (overlay.parent.parent / 'Dockerfile').write_text(f'FROM {ROLLBACK}\nCOPY --chown=node:node overlay/ /app/\n')
    hashes = runtime_hashes()
    manifest = {'baseImage': before['app']['Image'], 'baseContainer': before['app']['Id'], 'releaseTag': TAG,
        'rollbackTag': ROLLBACK, 'changes': {name: {'before': hashes[name], 'after': digest(STATE / 'image/overlay' / name)} for name in FILES}}
    save(ARTIFACT / 'manifest.json', manifest)
    for kind, tag in [('release', TAG), ('rollback', ROLLBACK)]:
        (STATE / f'compose.{kind}.yml').write_text(f'services:\n  app:\n    image: {tag}\n    pull_policy: never\n')
    save(ARTIFACT / 'spec.json', {
        'cause': 'The live release returned 404 and did not contain the customer router.',
        'authorization': 'User reported failure of the newly requested customer webhook; repair its live deployment.',
        'change': 'Three application source files over the current production image; no dependency, environment, schema or data changes.',
        'acceptance': ['Exact image passes customer acceptance/regression tests and full app HTTP persistence using synthetic data.',
            'Public and local customer endpoints return 401 for missing credentials and 400 for authenticated invalid bodies.',
            'Application health passes; worker, database and Ollama container identities stay unchanged.',
            'Disposable test environment is removed; rollback image and configuration retained.']})
    print('Prepared three-file customer webhook release over the current live image.')


def build():
    manifest = json.loads((ARTIFACT / 'manifest.json').read_text())
    with (ARTIFACT / 'build.log').open('w') as log:
        subprocess.run(['docker', 'build', '--network=none', '--pull=false', '-t', TAG, str(STATE / 'image')],
            cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True)
    manifest['candidateImage'] = inspect(TAG)['Id']
    save(ARTIFACT / 'manifest.json', manifest)
    print('Built candidate without network access or dependency installation.')


def review():
    before = json.loads((STATE / 'before.private.json').read_text())
    manifest = json.loads((ARTIFACT / 'manifest.json').read_text())
    assert inspect(APP)['Id'] == before['app']['Id'], 'Live app changed; recapture before deploying'
    config = json.loads(run(compose(before, 'compose.release.yml') + ['config', '--format', 'json']))
    app = config['services']['app']
    image = inspect(manifest['candidateImage'])
    env = dict(item.split('=', 1) for item in image['Config']['Env'])
    env.update({key: str(value) for key, value in app.get('environment', {}).items()})
    assert env == dict(item.split('=', 1) for item in before['app']['Config']['Env']), 'Unexpected runtime environment change'
    assert app['image'] == TAG
    assert image['Config']['Cmd'] == before['app']['Config']['Cmd']
    assert image['Config']['User'] == before['app']['Config']['User']
    save(ARTIFACT / 'configuration-review.json', {'environmentUnchanged': True, 'commandUnchanged': True,
        'userUnchanged': True, 'servicesToRecreate': ['app'], 'candidateImage': manifest['candidateImage']})
    print('Reviewed effective configuration: existing app environment, command and user preserved.')


def probe(url):
    # Cloudflare rejects Python-urllib with error 1010, even on the old 404 route.
    # Use the same client that established the public 404 baseline; retain the 401 assertion.
    return int(run(['curl', '--silent', '--show-error', '--max-time', '15', '--output', '/dev/null',
        '--write-out', '%{http_code}', '--request', 'POST', '--header', 'Content-Type: application/json',
        '--data', '{}', url]))


def adopt_rollback():
    before = json.loads((STATE / 'before.private.json').read_text())
    manifest = json.loads((ARTIFACT / 'manifest.json').read_text())
    current = inspect(APP)
    assert current['Image'] == before['app']['Image'], 'Unexpected live image after rollback'
    assert current['Config']['Image'] == ROLLBACK, 'App is not running this release rollback tag'
    assert current['State']['Health']['Status'] == 'healthy'
    assert runtime_hashes() == {name: change['before'] for name, change in manifest['changes'].items()}
    for name in OTHERS:
        assert inspect(name)['Id'] == before['others'][name]['Id']
    original = STATE / 'before-attempt-1.private.json'
    assert not original.exists(), 'Keep the original deployment snapshot'
    shutil.copy2(STATE / 'before.private.json', original)
    before['app'] = current
    save(STATE / 'before.private.json', before)
    for name in ['publish.log', 'rollback.log']:
        (ARTIFACT / name).rename(ARTIFACT / name.replace('.log', '-attempt-1.log'))
    save(ARTIFACT / 'rollback-verified.json', {'originalImageRestored': True, 'health': 'healthy',
        'otherServicesUnchanged': True, 'cause': 'Public Python-urllib probe rejected by Cloudflare error 1010. Curl reached the unchanged old route and returned 404.'})
    print('Verified own rollback and captured its healthy container for guarded redeployment.')


def deploy():
    before = json.loads((STATE / 'before.private.json').read_text())
    manifest = json.loads((ARTIFACT / 'manifest.json').read_text())
    validated = json.loads((ARTIFACT / 'candidate-validation.json').read_text())
    assert validated['candidateImage'] == manifest['candidateImage'] and validated['passed'] == 102
    assert (ARTIFACT / 'configuration-review.json').exists()
    assert inspect(TAG)['Id'] == manifest['candidateImage'], 'Candidate tag moved'
    assert inspect(APP)['Id'] == before['app']['Id'], 'Live app changed; do not overwrite a newer release'
    assert runtime_hashes() == {name: change['before'] for name, change in manifest['changes'].items()}
    try:
        with (ARTIFACT / 'publish.log').open('w') as log:
            subprocess.run(compose(before, 'compose.release.yml') + ['up', '-d', '--no-deps', '--no-build', 'app'],
                cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True)
        for _ in range(55):
            current = inspect(APP)
            if current['Image'] == manifest['candidateImage'] and current['State'].get('Health', {}).get('Status') == 'healthy':
                break
            time.sleep(1)
        else:
            raise RuntimeError('Customer webhook release did not become healthy')
        with urllib.request.urlopen('http://127.0.0.1:3000/health', timeout=5) as response:
            assert response.status == 200 and json.load(response)['ok']
        assert runtime_hashes() == {name: change['after'] for name, change in manifest['changes'].items()}
        for name in OTHERS:
            assert inspect(name)['Id'] == before['others'][name]['Id'], f'Unexpected recreation: {name}'
        local = probe('http://127.0.0.1:3000/api/webhooks/netsuite/customer')
        public = probe('https://test.mbbsoperation.com/api/webhooks/netsuite/customer')
        assert local == public == 401, f'Endpoint routing failed: local={local}, public={public}'
        # A deliberately invalid body is rejected before any customer database write.
        script = "const {config}=await import('./src/config.js'); const r=await fetch('http://127.0.0.1:3000/api/webhooks/netsuite/customer',{method:'POST',headers:{'content-type':'application/json','x-mbbs-webhook-secret':config.netsuite.webhookSecret},body:'{}'}); console.log(JSON.stringify({status:r.status}));"
        authenticated = json.loads(run(['docker', 'exec', APP, 'node', '--input-type=module', '-e', script]))
        assert authenticated['status'] == 400, 'Authenticated routing/configuration check failed'
        save(ARTIFACT / 'deployed.json', {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'image': manifest['candidateImage'], 'health': 'healthy', 'localUnauthenticatedStatus': local,
            'publicUnauthenticatedStatus': public, 'authenticatedInvalidPayloadStatus': authenticated['status'],
            'otherServicesUnchanged': True, 'productionCustomerWritesDuringVerification': 0})
        print('Deployed customer webhook: public/local routing, authentication and application health verified.')
    except BaseException:
        with (ARTIFACT / 'rollback.log').open('w') as log:
            subprocess.run(compose(before, 'compose.rollback.yml') + ['up', '-d', '--no-deps', '--no-build', 'app'],
                cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True)
        raise


os.umask(0o077)
STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
ARTIFACT.mkdir(parents=True, exist_ok=True)
{'prepare': prepare, 'build': build, 'review': review, 'adopt-rollback': adopt_rollback, 'deploy': deploy}[sys.argv[1]]()

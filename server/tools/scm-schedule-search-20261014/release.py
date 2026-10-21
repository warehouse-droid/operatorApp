#!/usr/bin/env python3
"""Deploy the authorized search delta over the live image, with rollback."""
import difflib
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import time

SERVER = Path(__file__).resolve().parents[2]
REPO = SERVER.parent
TASK = SERVER / 'test-artifacts/scm-schedule-search-20261014'
OUT = TASK / 'release'
RELEASE = SERVER / 'deployments/scm-schedule-search-20261014'
APP = 'mbbs-operator-app-app-1'
DEPENDENCIES = ['mbbs-operator-app-db-1', 'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-ollama-1']
FILES = ['src/scm-order-visibility.js', 'src/server.js', 'src/dispatch-repository.js', 'public/scm-schedule.js', 'public/scm-schedule.html']
IMAGE = 'mbbs-operator-app:scm-schedule-search-20261014'
ROLLBACK = 'mbbs-operator-app:scm-schedule-search-rollback-20261014'
DOCKER = ['sudo', '-n', 'docker']
PROJECT = 'mbbs-schedule-search-release-' + str(os.getpid())
TESTS = ['test/dispatch/frontend/scm-schedule-search.test.js', 'test/mbt/unit/scm-schedule-search-policy.test.js',
         'test/mbt/integration/scm-schedule-search.test.js']
HASH_SCRIPT = """const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const hashes={};function visit(name){const absolute=path.join('/app',name),stat=fs.lstatSync(absolute);
if(stat.isDirectory()){for(const child of fs.readdirSync(absolute).sort())visit(path.join(name,child));}
else if(stat.isFile())hashes[name]=crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');}
for(const name of ['src','public','migrations','package.json','package-lock.json'])visit(name);
console.log(JSON.stringify(hashes));"""

def docker(*args, data=None, timeout=60):
    return subprocess.check_output(DOCKER + list(args), input=data, timeout=timeout)

def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + '\n')

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def tree(root):
    return {str(path.relative_to(root)): sha(path) for path in sorted(root.rglob('*')) if path.is_file()}

def metadata(name):
    row = json.loads(docker('inspect', name))[0]
    config = {key: row['Config'][key] for key in ['Env', 'User', 'Entrypoint', 'Cmd', 'WorkingDir']}
    config['Env'] = sorted(config['Env'])
    host = dict(row['HostConfig'])
    host['Binds'] = sorted(host.get('Binds') or [])
    return {'containerId': row['Id'], 'imageId': row['Image'], 'imageRef': row['Config']['Image'],
      'configurationHash': hashlib.sha256(json.dumps({'config': config, 'host': host}, sort_keys=True).encode()).hexdigest(),
      'compose': row['Config']['Labels']}

def logged(label, args, timeout=600):
    path = OUT / (label + '.log')
    with path.open('w') as log:
        result = subprocess.run(args, cwd=REPO, stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
    print(json.dumps({'stage': label, 'exit': result.returncode}), flush=True)
    assert result.returncode == 0, label + ' failed; see ' + str(path)

def production_compose(manifest, override):
    labels = manifest['app']['compose']
    command = DOCKER + ['compose', '-p', labels['com.docker.compose.project'],
        '--project-directory', labels['com.docker.compose.project.working_dir']]
    if labels.get('com.docker.compose.project.environment_file'):
        command += ['--env-file', labels['com.docker.compose.project.environment_file']]
    for filename in labels['com.docker.compose.project.config_files'].split(','):
        command += ['-f', filename]
    return command + ['-f', str(override)]

def current(manifest):
    assert metadata(APP) == manifest['app'], 'The live application changed; rebase this candidate'
    assert {name: metadata(name) for name in DEPENDENCIES} == manifest['dependencies'], 'Another service changed'

def inputs():
    validation = json.loads((TASK / 'validation-all.json').read_text())
    assert validation['passed'] and validation['cleanupVerified']
    checks = json.loads((TASK / 'checks-all.json').read_text())
    assert checks['results']['tests']['pass'] == 27 and checks['results']['tests']['fail'] == 0
    hashes = {name: validation['sourceHashes'][name] for name in FILES}
    assert all(sha(SERVER / name) == digest for name, digest in hashes.items()), 'Verified workspace source changed'
    return hashes

def prepare():
    OUT.mkdir(parents=True, exist_ok=True)
    RELEASE.mkdir(parents=True, exist_ok=False)
    workspace = inputs()
    manifest = {'app': metadata(APP), 'dependencies': {name: metadata(name) for name in DEPENDENCIES}, 'workspaceHashes': workspace}
    archive = docker('exec', APP, 'tar', '-cf', '-', '-C', '/app', 'src', 'public', 'migrations', 'package.json', 'package-lock.json')
    before = RELEASE / 'before'
    before.mkdir()
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(before, filter='data')
    current(manifest)
    manifest['beforeTree'] = tree(before)
    candidate = RELEASE / 'candidate'
    shutil.copytree(before, candidate)
    context = RELEASE / 'context'
    context.mkdir()
    patch = []
    for name in FILES:
        original = before / name
        assert sha(original) == docker('exec', APP, 'sha256sum', '/app/' + name).decode().split()[0]
        if name == 'public/scm-schedule.html':
            desired = re.search(r'/scm-schedule\.js\?v=([^"\s]+)', (SERVER / name).read_text()).group(1)
            updated, count = re.subn(r'(/scm-schedule\.js\?v=)[^"\s]+', lambda match: match.group(1) + desired, original.read_text())
            assert count == 1, 'The live Schedule page must reference one Schedule script'
            content = updated.encode()
        else:
            result = subprocess.run(['git', 'merge-file', '-p', str(original), str(TASK / 'before' / name), str(SERVER / name)], capture_output=True)
            if result.returncode:
                (OUT / ('merge-conflict-' + name.replace('/', '_'))).write_bytes(result.stdout)
            assert result.returncode == 0, 'Scoped merge requires review: ' + name
            content = result.stdout
        target = context / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        (candidate / name).write_bytes(content)
        patch.extend(difflib.unified_diff(original.read_text().splitlines(True), content.decode().splitlines(True),
          fromfile='production/' + name, tofile='candidate/' + name))
    manifest['candidateTree'] = tree(candidate)
    changed = sorted(name for name in manifest['beforeTree'] if manifest['beforeTree'][name] != manifest['candidateTree'][name])
    assert changed == sorted(FILES), 'The release must contain only the five search runtime files'
    manifest['changedFiles'] = changed
    manifest['candidateTreeHash'] = hashlib.sha256(json.dumps(manifest['candidateTree'], sort_keys=True).encode()).hexdigest()
    docker('tag', manifest['app']['imageId'], ROLLBACK)
    (context / 'Dockerfile').write_text('FROM ' + ROLLBACK + '\nCOPY --link . /app/\n')
    (context / '.dockerignore').write_text('/Dockerfile\n/.dockerignore\n')
    logged('build', DOCKER + ['build', '--network=none', '-t', IMAGE, str(context)])
    manifest['candidateImageId'] = json.loads(docker('image', 'inspect', IMAGE))[0]['Id']
    save(RELEASE / 'manifest.json', manifest)
    save(RELEASE / 'compose.release.json', {'services': {'app': {'image': IMAGE}}})
    save(RELEASE / 'compose.rollback.json', {'services': {'app': {'image': ROLLBACK}}})
    (OUT / 'production.patch').write_text(''.join(patch))
    current(manifest)
    print(json.dumps({'prepared': IMAGE, 'changedFiles': changed, 'preservedFiles': len(manifest['beforeTree']) - len(changed)}), flush=True)

def isolated_compose():
    labels = {'com.mbbs.lifecycle': 'disposable-test', 'com.mbbs.task': PROJECT}
    candidate = RELEASE / 'candidate'
    mounts = [f'{candidate / name}:/app/{name}:ro' for name in ('src', 'public', 'migrations', 'package.json', 'package-lock.json')]
    mounts += [f'{SERVER / name}:/app/{name}:ro' for name in ('test', 'tools')]
    mounts += [f'{SERVER / "test-artifacts/mbr-contract/toolchain/node_modules"}:/app/node_modules:ro',
       f'{SERVER / "test-artifacts/mbr-contract/playwright-browsers"}:/ms-playwright:ro']
    service = {'image': 'mbbs-to-yard-test-browser:20261009', 'pull_policy': 'never', 'user': '1000:1000',
      'entrypoint': [], 'working_dir': '/app', 'labels': labels, 'cpus': '1.0', 'mem_limit': '1536m', 'memswap_limit': '1536m',
      'volumes': mounts, 'environment': {'PLAYWRIGHT_BROWSERS_PATH': '/ms-playwright',
       'XDG_CONFIG_HOME': '/tmp/schedule-search-release-config', 'XDG_CACHE_HOME': '/tmp/schedule-search-release-cache'}}
    override = OUT / 'compose.test.json'
    save(override, {'services': {
      'db': {'image': 'postgres:18-alpine', 'pull_policy': 'never', 'labels': labels, 'mem_limit': '512m', 'memswap_limit': '512m'},
      'test': service,
      'app': {'image': IMAGE, 'pull_policy': 'never', 'labels': labels, 'cpus': '1.0', 'mem_limit': '1024m', 'memswap_limit': '1024m'}}})
    return DOCKER + ['compose', '--profile', 'tools', '--profile', 'runtime', '-p', PROJECT,
      '--project-directory', str(REPO), '-f', str(REPO / 'docker-compose.mbt-test.yml'), '-f', str(override)]

def cleanup(compose):
    logged('teardown', compose + ['down', '--volumes', '--remove-orphans'], timeout=120)
    remaining = docker('ps', '-aq', '--filter', 'label=com.mbbs.task=' + PROJECT).decode().split()
    if remaining:
        docker('rm', '-f', '-v', *remaining)
        logged('teardown-final', compose + ['down', '--volumes', '--remove-orphans'], timeout=120)
    def output(*args):
        return docker(*args).decode().strip()
    data = {'dockerPs': output('ps', '--format', '{{.Names}} {{.Status}}'),
      'dockerPsA': output('ps', '-a', '--format', '{{.Names}} {{.Status}}'),
      'containers': output('ps', '-a', '--filter', 'label=com.mbbs.task=' + PROJECT, '--format', '{{.Names}}'),
      'allDisposableContainers': output('ps', '-a', '--filter', 'label=com.mbbs.lifecycle=disposable-test', '--format', '{{.Names}}'),
      'networks': output('network', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}'),
      'volumes': output('volume', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}')}
    health = subprocess.run(['curl', '-fsS', '--max-time', '10', 'http://127.0.0.1:3000/health'], capture_output=True, text=True)
    data['productionHealthy'] = health.returncode == 0 and json.loads(health.stdout).get('ok') is True
    save(OUT / 'cleanup.json', data)
    assert not any(data[key] for key in ('containers', 'networks', 'volumes')) and data['productionHealthy']
    print(json.dumps({'cleanup': 'complete', 'productionHealthy': True}), flush=True)

def validate():
    manifest = json.loads((RELEASE / 'manifest.json').read_text())
    current(manifest)
    compose = isolated_compose()
    # Register cleanup before the first test container, network or database.
    passed = False
    try:
        config = json.loads(subprocess.check_output(compose + ['config', '--format', 'json']))
        for name in ('db', 'test', 'app'):
            service = config['services'][name]
            assert service['cgroup_parent'] == 'mbbs-tests.slice' and service['init']
            assert 0 < int(service['mem_limit']) <= 2 * 1024**3 and service['memswap_limit'] == service['mem_limit']
            assert 0 < service['pids_limit'] <= 512 and 0 < float(service['cpus']) <= 2
            assert all('size=' in value for value in service['tmpfs'])
            assert service['labels']['com.mbbs.lifecycle'] == 'disposable-test'
        logged('start-db', compose + ['up', '-d', '--wait', '--no-build', '--pull', 'never', 'db'])
        logged('migrate-test-db', compose + ['run', '--rm', '--no-deps', '-T', 'test', 'node', 'src/migrate.js'])
        logged('candidate-tests', compose + ['run', '--rm', '--no-deps', '-T', 'test', 'node', '--test', '--test-concurrency=1', *TESTS])
        counts = {key: sum(int(value) for value in re.findall(r'^# ' + key + r' (\d+)$', (OUT / 'candidate-tests.log').read_text(), re.M)) for key in ('tests', 'pass', 'fail')}
        assert counts == {'tests': 27, 'pass': 27, 'fail': 0}
        logged('candidate-startup', compose + ['up', '-d', '--wait', '--no-build', '--pull', 'never', 'app'])
        container = subprocess.check_output(compose + ['ps', '-q', 'app'], text=True).strip()
        assert json.loads(docker('inspect', container))[0]['Image'] == manifest['candidateImageId']
        assert json.loads(docker('exec', container, 'node', '-e', HASH_SCRIPT)) == manifest['candidateTree']
        probe = "fetch('http://app:3000/health').then(async r=>{const d=await r.json();if(!r.ok||!d.ok)throw Error('Health failed');console.log(JSON.stringify({healthy:true}));})"
        logged('candidate-health', compose + ['run', '--rm', '--no-deps', '-T', 'test', 'node', '-e', probe])
        current(manifest)
        passed = True
    finally:
        cleanup(compose)
    if passed:
        save(OUT / 'candidate-validation.json', {'passed': True, 'cleanupVerified': True, 'candidateImageId': manifest['candidateImageId'],
          'candidateTreeHash': manifest['candidateTreeHash'], 'tests': counts, 'actualRuntimeStartupPassed': True, 'imageSourcesVerified': True})
        print(json.dumps({'candidateValidated': True, 'tests': counts}), flush=True)

def healthy():
    for _ in range(45):
        result = subprocess.run(['curl', '-fsS', '--max-time', '3', 'http://127.0.0.1:3000/health'], capture_output=True, text=True)
        if result.returncode == 0 and json.loads(result.stdout).get('ok') is True:
            return True
        time.sleep(1)
    return False

def live_http(manifest, before=False):
    stage = 'live-before' if before else 'live-after'
    root = RELEASE / ('before' if before else 'candidate')
    version = re.search(r'/scm-schedule\.js\?v=([^"\s]+)', (root / 'public/scm-schedule.html').read_text()).group(1)
    expected = {'version': version, 'scriptHash': manifest['beforeTree' if before else 'candidateTree']['public/scm-schedule.js']}
    if not before:
        expected['api'] = json.loads((OUT / 'live-before-http.json').read_text())['api']
    script = 'const expected=' + json.dumps(expected) + ';\n' + """
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const origin='http://127.0.0.1:3000',results=[];
for(const path of ['/health','/sales/schedule','/dispatch/po-to-schedule','/scm-schedule.js?v='+expected.version]) {
 const response=await fetch(origin+path,{signal:AbortSignal.timeout(15000)});
 assert.equal(response.status,200,path);const body=await response.text();
 if(path==='/health')assert.equal(JSON.parse(body).ok,true);
 if(path.includes('/schedule')||path.includes('po-to-schedule'))assert.ok(body.includes(expected.version),path);
 if(path.startsWith('/scm-schedule.js'))assert.equal(crypto.createHash('sha256').update(body).digest('hex'),expected.scriptHash);
 results.push({path,status:response.status});
}
const api={};
for(const path of ['/api/sales/schedule','/api/scm/schedule']) {
 const response=await fetch(origin+path+'?search=RELEASE-CHECK-NOMATCH-5f93a6784a&surface=dispatch',{signal:AbortSignal.timeout(15000)});
 if(expected.api)assert.equal(response.status,expected.api[path],path);
 else assert.ok([200,401].includes(response.status),path);
 if(response.status===200)assert.deepEqual(await response.json(),[]);
 api[path]=response.status;
}
console.log(JSON.stringify({passed:true,http:results,api,scriptHashVerified:true}));
"""
    # Register removal before launching this bounded, read-only HTTP probe.
    name = PROJECT + '-' + stage
    try:
        data = json.loads(docker('run', '--rm', '--init', '--name', name, '--cgroup-parent=mbbs-tests.slice',
          '--memory=256m', '--memory-swap=256m', '--pids-limit=64', '--cpus=0.25', '--read-only',
          '--tmpfs', '/tmp:uid=1000,gid=1000,mode=1777,size=64m',
          '--tmpfs', '/app/data:uid=1000,gid=1000,mode=0700,size=16m',
          '--label', 'com.mbbs.lifecycle=disposable-test', '--label', 'com.mbbs.task=' + PROJECT,
          '--network=host', '-i', 'mbbs-to-yard-test-browser:20261009', 'node', '--input-type=module', data=script.encode(), timeout=90))
        save(OUT / (stage + '-http.json'), data)
    finally:
        remaining = docker('ps', '-aq', '--filter', 'name=^/' + name + '$', '--filter', 'label=com.mbbs.task=' + PROJECT).decode().split()
        if remaining:
            docker('rm', '-f', '-v', *remaining)
        data = {'dockerPs': docker('ps', '--format', '{{.Names}} {{.Status}}').decode().strip(),
          'dockerPsA': docker('ps', '-a', '--format', '{{.Names}} {{.Status}}').decode().strip(),
          'containers': docker('ps', '-a', '--filter', 'label=com.mbbs.task=' + PROJECT, '--format', '{{.Names}}').decode().strip()}
        save(OUT / (stage + '-cleanup.json'), data)
        assert not data['containers']
    print(json.dumps({'stage': stage + '-http', 'passed': True}), flush=True)

def verify(manifest):
    live = metadata(APP)
    assert live['imageId'] == manifest['candidateImageId']
    assert live['configurationHash'] == manifest['app']['configurationHash'], 'Production configuration changed'
    assert {name: metadata(name) for name in DEPENDENCIES} == manifest['dependencies'], 'Another service changed'
    assert json.loads(docker('exec', APP, 'node', '-e', HASH_SCRIPT)) == manifest['candidateTree'], 'Live sources differ from the tested candidate'
    assert healthy(), 'Production health failed'
    live_http(manifest)
    results = json.loads((OUT / 'live-after-http.json').read_text())
    save(OUT / 'live-verification.json', {'passed': True, 'healthy': True, 'sourceTreeVerified': True,
      'configurationPreserved': True, 'otherServicesPreserved': True, 'http': results['http'], 'api': results['api']})

def deploy():
    manifest = json.loads((RELEASE / 'manifest.json').read_text())
    validation = json.loads((OUT / 'candidate-validation.json').read_text())
    assert validation['passed'] and validation['cleanupVerified'] and validation['candidateImageId'] == manifest['candidateImageId']
    assert validation['candidateTreeHash'] == manifest['candidateTreeHash']
    assert json.loads(docker('image', 'inspect', IMAGE))[0]['Id'] == manifest['candidateImageId']
    assert tree(RELEASE / 'candidate') == manifest['candidateTree']
    inputs()
    current(manifest)
    live_http(manifest, before=True)
    current(manifest)
    arguments = ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'app']
    try:
        logged('production-deploy', production_compose(manifest, RELEASE / 'compose.release.json') + arguments, timeout=90)
        assert healthy(), 'Production health did not recover'
        verify(manifest)
    except BaseException:
        try:
            image = metadata(APP)['imageId']
        except subprocess.CalledProcessError:
            image = None
        if image in (None, manifest['candidateImageId'], manifest['app']['imageId']):
            logged('production-rollback', production_compose(manifest, RELEASE / 'compose.rollback.json') + arguments, timeout=90)
            assert healthy(), 'Rollback health failed'
            save(OUT / 'rollback.json', {'restored': True, 'imageId': manifest['app']['imageId']})
        raise
    save(OUT / 'deployment.json', {'deployed': True, 'image': IMAGE, 'imageId': manifest['candidateImageId'],
      'healthy': True, 'changedFiles': manifest['changedFiles'], 'sourceTreeHash': manifest['candidateTreeHash'],
      'configurationPreserved': True, 'otherServicesPreserved': True, 'schemaChanged': False})
    print(json.dumps({'deployed': True, 'image': IMAGE, 'healthy': True}), flush=True)

def interrupted(_signal, _frame):
    raise KeyboardInterrupt('Interrupted; tests are disposable and a deployment will roll back')

if __name__ == '__main__':
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    {'prepare': prepare, 'validate': validate, 'deploy': deploy, 'verify': lambda: verify(json.loads((RELEASE / 'manifest.json').read_text()))}[sys.argv[1]]()

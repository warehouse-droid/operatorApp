"""Deploy only the tested yard milestone posting overlay, preserving the live image."""
import atexit
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tarfile
import time

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
EVIDENCE = SERVER / 'test-artifacts/transfer-yard-posting-20261021'
RELEASE = SERVER / 'deployments/transfer-yard-posting-20261021'
IMAGE = 'mbbs-operator-app:transfer-yard-posting-20261021'
ROLLBACK = IMAGE + '-rollback'
CHECK_NAME = 'mbbs-transfer-yard-posting-image-check'
DOCKER = ['sudo', '-n', 'docker']
spec = importlib.util.spec_from_file_location('release_core', SERVER / 'tools/delivery-scm-release.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE = RELEASE
core.docker = lambda *args, **kwargs: subprocess.check_output(DOCKER + list(args), **kwargs)
core.HASH_SCRIPT = """const fs=require('node:fs'),c=require('node:crypto'),result={};
function hash(p){result[p]=c.createHash('sha256').update(fs.readFileSync(p)).digest('hex');}
function walk(dir){if(!fs.existsSync(dir))return;for(const e of fs.readdirSync(dir,{withFileTypes:true})){
const p=dir+'/'+e.name;if(e.isDirectory())walk(p);else if(e.isFile())hash(p);}}
for(const dir of ['src','public','migrations','contracts'])walk(dir);
for(const p of ['package.json','package-lock.json'])hash(p);console.log(JSON.stringify(result));"""


def save(name, data):
    (RELEASE / name).write_text(json.dumps(data, indent=2) + '\n')


def tree(root):
    files = [p for directory in ['src', 'public', 'migrations', 'contracts']
             for p in (root / directory).rglob('*') if p.is_file()]
    files += [root / name for name in ['package.json', 'package-lock.json']]
    return {str(p.relative_to(root)): core.sha(p.read_bytes()) for p in sorted(files)}


def evidence():
    report = json.loads((EVIDENCE / 'evidence-report.json').read_text())
    assert report['tests']['newFailures'] == []
    assert report['tests']['current']['passed'] == 298
    assert report['changedLineCoverage']['covered'] == report['changedLineCoverage']['total'] == 37
    assert len(report['mutation']) == 5 and all(row['killed'] for row in report['mutation'])
    assert not report['lint']['newIssues'] and not report['types']['newIssues']
    hashes = report['source']['hashes']
    assert len(hashes) == 8
    for name, digest in hashes.items():
        assert core.sha((SERVER / name).read_bytes()) == digest, 'Tested source changed: ' + name
    return hashes


def current(data):
    assert core.metadata(core.APP) == data['app'], 'Live app changed; recapture required'
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies'], 'Dependency changed'
    assert json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)) == data['beforeTree']
    assert tree(RELEASE / 'candidate') == data['candidateTree'], 'Candidate source changed'
    evidence()


def capture():
    hashes = evidence()
    os.umask(0o077)
    RELEASE.mkdir(parents=True, exist_ok=False)
    before = core.metadata(core.APP)
    dependencies = [core.metadata(name) for name in core.DEPENDENCIES]
    roots = json.loads(core.docker('exec', core.APP, 'node', '-e',
        "console.log(JSON.stringify(['src','public','migrations','contracts','package.json','package-lock.json'].filter(p=>require('node:fs').existsSync(p))))"))
    archive = core.docker('exec', core.APP, 'tar', '-cf', '-', '-C', '/app', *roots)
    baseline = RELEASE / 'before'
    baseline.mkdir()
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(baseline, filter='data')
    candidate = RELEASE / 'candidate'
    shutil.copytree(baseline, candidate)
    patch = (EVIDENCE / 'changes.patch').read_text()
    core.apply_patch(candidate, patch, 'changes')
    before_tree, after_tree = tree(baseline), tree(candidate)
    changed = sorted(n for n in before_tree.keys() | after_tree.keys() if before_tree.get(n) != after_tree.get(n))
    assert changed == sorted(hashes), 'Unexpected release scope'
    data = {'capturedAt': core.now(), 'authorization': 'User requested deploy after implementation and verification',
            'app': before, 'dependencies': dependencies, 'files': changed,
            'beforeTree': before_tree, 'candidateTree': after_tree, 'sourceHashes': hashes,
            'candidateTreeHash': core.sha(json.dumps(after_tree, sort_keys=True).encode()),
            'exactTestedModules': all(after_tree[n] == digest for n, digest in hashes.items())}
    save('manifest.json', data)
    current(data)
    print(json.dumps({'captured': True, 'changedFiles': changed, 'exactTestedModules': data['exactTestedModules'],
                      'runtimeFiles': len(after_tree), 'previousImageId': before['imageId']}), flush=True)


def cleanup_check():
    subprocess.run(DOCKER + ['rm', '-fv', CHECK_NAME], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for args, filename in [(['ps'], 'docker-ps.log'), (['ps', '-a'], 'docker-ps-a.log')]:
        (RELEASE / filename).write_bytes(core.docker(*args, '--format', '{{.Names}} {{.Status}}'))
    assert not core.docker('ps', '-a', '--filter', 'name=^/' + CHECK_NAME + '$', '--format', '{{.ID}}').strip()
    for name in [core.APP, core.DB, 'mbbs-operator-app-ollama-1']:
        assert core.docker('inspect', name, '--format', '{{.State.Health.Status}}').strip() == b'healthy'
    assert core.docker('inspect', 'mbbs-operator-app-webhook-worker-1', '--format', '{{.State.Running}}').strip() == b'true'


def build():
    data = core.state()
    current(data)
    core.docker('tag', data['app']['imageId'], ROLLBACK)
    stage = RELEASE / 'stage'
    for name in data['files']:
        target = stage / 'overlay' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(RELEASE / 'candidate' / name, target)
    (stage / 'Dockerfile').write_text('FROM ' + ROLLBACK + '\nCOPY --chown=node:node overlay/ /app/\n')
    for mode, tag in [('release', IMAGE), ('rollback', ROLLBACK)]:
        (RELEASE / ('compose.' + mode + '.yml')).write_text('services:\n  app:\n    image: ' + tag + '\n')
    with (RELEASE / 'build.log').open('wb') as output:
        subprocess.run(DOCKER + ['build', '--network=none', '--pull=false', '-t', IMAGE, str(stage)],
                       stdout=output, stderr=subprocess.STDOUT, check=True, timeout=180)
    data['candidateImageId'] = core.docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    save('manifest.json', data)
    atexit.register(cleanup_check)
    try:
        actual = json.loads(core.bounded(data['candidateImageId'], CHECK_NAME, 'node', '-e', core.HASH_SCRIPT))
        assert actual == data['candidateTree'], 'Built image differs from scoped candidate'
        script = "await import('./src/server.js');console.log(JSON.stringify({serverImport:true}));process.exit(0)"
        (RELEASE / 'server-import.log').write_bytes(core.bounded(data['candidateImageId'], CHECK_NAME,
                                                               'node', '--input-type=module', '-e', script))
    finally:
        cleanup_check()
        atexit.unregister(cleanup_check)
    core.config_check(data)
    configs = [json.loads(subprocess.check_output(core.compose(data, mode) + ['config', '--format', 'json'], cwd=ROOT))
               for mode in ['release', 'rollback']]
    for config in configs:
        config['services']['app'].pop('image')
    assert configs[0] == configs[1], 'Compose configuration would change'
    current(data)
    save('image-check.json', {'passed': True, 'imageId': data['candidateImageId'], 'runtimeFiles': len(actual)})
    print(json.dumps({'built': True, 'imageId': data['candidateImageId'], 'runtimeFilesVerified': len(actual)}), flush=True)


def verify():
    data = core.state()
    core.ready(data['candidateImageId'])
    actual = core.metadata(core.APP)
    assert actual['imageId'] == data['candidateImageId']
    assert actual['configuration'] == data['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    assert json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)) == data['candidateTree']
    http = core.http_check({}, ['/api/admin/operator-netsuite-posting/attention', '/api/receiving/orders'])
    cleanup_check()
    result = {'deployed': True, 'at': core.now(), 'image': IMAGE, 'imageId': actual['imageId'],
              'changedFiles': data['files'], 'candidateTreeHash': data['candidateTreeHash'],
              'runtimeFilesVerified': len(data['candidateTree']), 'configurationPreserved': True,
              'dependenciesUnchanged': True, 'schemaChanged': False, 'http': http,
              'validation': json.loads((RELEASE / 'validation-passed.json').read_text()),
              'rollbackImage': ROLLBACK, 'rollbackImageId': data['app']['imageId']}
    save('deployment-result.json', result)
    (EVIDENCE / 'deployment-result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result), flush=True)


def apply():
    data = core.state()
    current(data)
    validation = json.loads((RELEASE / 'validation-passed.json').read_text())
    assert validation['passed'] and validation['candidateTreeHash'] == data['candidateTreeHash']
    check = json.loads((RELEASE / 'image-check.json').read_text())
    assert check['passed'] and check['imageId'] == data['candidateImageId']
    assert core.docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip() == data['candidateImageId']
    core.config_check(data)
    for attempt in range(30):
        active = core.preflight()
        try:
            core.assert_no_active_operations(active)
            break
        except AssertionError:
            if attempt == 29:
                raise
            time.sleep(2)
    current(data)
    args = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
    try:
        with (RELEASE / 'publish.log').open('wb') as output:
            subprocess.run(core.compose(data, 'release') + args, cwd=ROOT,
                           stdout=output, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except BaseException:
        with (RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(core.compose(data, 'rollback') + args, cwd=ROOT,
                           stdout=output, stderr=subprocess.STDOUT, check=True, timeout=60)
        core.ready(data['app']['imageId'])
        save('rollback-result.json', {'previousImageRestored': True})
        raise


if __name__ == '__main__':
    def interrupted(signum, _frame):
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, interrupted)
    {'capture': capture, 'build': build, 'apply': apply, 'verify': verify}[sys.argv[1]]()

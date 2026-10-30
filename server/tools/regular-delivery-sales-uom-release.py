"""Deploy the tested Delivery Sales UOM fallback with an app-only rollback."""
import difflib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tarfile

sys.dont_write_bytecode = True
SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
RELEASE = SERVER / 'deployments/regular-delivery-sales-uom-20261026T172608Z'
IMAGE = 'mbbs-operator-app:regular-delivery-sales-uom-20261026T172608Z'
ROLLBACK = IMAGE + '-rollback'
FILE = 'src/stock-request-repository.js'
BEFORE_HASH = 'bf9eeae2d66798b21b4619fc91c6efd05f05f5c37fec1a5f8ae9b246e8b5700d'
SOURCE_HASH = '054d2bb31b0a54a75984b966a159ae7363b52e80b61048462274ab925fa78644'
spec = importlib.util.spec_from_file_location('delivery_uom_release_core', SERVER / 'tools/delivery-scm-release.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE = RELEASE
core.HASH_SCRIPT = """const fs=require('node:fs'),c=require('node:crypto'),result={};
function hash(p){result[p]=c.createHash('sha256').update(fs.readFileSync(p)).digest('hex');}
function walk(d){if(!fs.existsSync(d))return;for(const e of fs.readdirSync(d,{withFileTypes:true})){
const p=d+'/'+e.name;if(e.isDirectory())walk(p);else if(e.isFile())hash(p);}}
for(const d of ['src','public','migrations','contracts'])walk(d);
for(const p of ['package.json','package-lock.json'])hash(p);console.log(JSON.stringify(result));"""


def current(data):
    assert core.metadata(core.APP) == data['app'], 'Production app changed; recapture required'
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    assert core.sha((SERVER / FILE).read_bytes()) == SOURCE_HASH, 'Tested source changed'
    assert core.sha(core.docker('exec', core.APP, 'cat', '/app/' + FILE)) == BEFORE_HASH


def validate():
    assert os.environ.get('MBBS_TEST_ARTIFACT_DIR'), 'Use the disposable retention runner'
    data = core.state()
    current(data)
    before = json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT))
    assert core.sha((SERVER / 'package-lock.json').read_bytes()) == before['package-lock.json']
    artifact = Path(os.environ['MBBS_TEST_ARTIFACT_DIR'])
    artifact.chmod(0o777)
    candidate = artifact / 'candidate'
    candidate.mkdir(mode=0o755)
    output = artifact / 'output'
    output.mkdir(mode=0o777)
    output.chmod(0o777)
    archive = core.docker('exec', core.APP, 'tar', '-cf', '-', '-C', '/app', 'src', 'public', 'migrations')
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(candidate, filter='data')
    (candidate / FILE).write_bytes((SERVER / FILE).read_bytes())
    for path in candidate.rglob('*'):
        path.chmod(0o755 if path.is_dir() else 0o644)
    candidate.chmod(0o755)
    override = artifact / 'compose.json'
    volumes = [{'type': 'bind', 'source': str(candidate / name), 'target': '/app/' + name, 'read_only': True}
               for name in ['src', 'public', 'migrations']]
    volumes += [{'type': 'bind', 'source': str(SERVER / 'test'), 'target': '/app/test', 'read_only': True},
                {'type': 'bind', 'source': str(output), 'target': '/app/test-artifacts'}]
    services = {
        name: {'labels': {'com.mbbs.lifecycle': 'disposable-test'}, 'volumes': volumes}
        for name in ['test', 'migrate']}
    services['db'] = {'labels': {'com.mbbs.lifecycle': 'disposable-test'}}
    override.write_text(json.dumps({'services': services}))
    project = 'mbbs-delivery-uom-validate-' + str(os.getpid())
    compose = ['docker', 'compose', '-p', project, '-f', str(ROOT / 'docker-compose.mbt-test.yml'), '-f', str(override)]
    tests = ['unit/stock-request-domain', 'unit/stock-request-service', 'unit/regular-stock-delivery-simple',
             'unit/regular-stock-delivery-selection', 'unit/regular-stock-pickup',
             'integration/regular-stock-delivery-conversions', 'integration/regular-stock-delivery-simple',
             'integration/regular-stock-delivery-simple-http', 'integration/stock-request-repository',
             'integration/regular-stock-pickup']
    try:
        with (artifact / 'setup.log').open('wb') as log:
            subprocess.run(compose + ['up', '-d', '--wait', 'db'], stdout=log, stderr=subprocess.STDOUT,
                           check=True, timeout=90)
            subprocess.run(compose + ['run', '--rm', '--no-deps', '-T', 'migrate'], stdout=log,
                           stderr=subprocess.STDOUT, check=True, timeout=90)
        with (artifact / 'tests.log').open('wb') as log:
            result = subprocess.run(compose + ['run', '--rm', '--no-deps', '-T', 'test', 'node', '--test',
                '--test-reporter=spec', '--test-concurrency=1'] + ['test/mbt/' + name + '.test.js' for name in tests],
                stdout=log, stderr=subprocess.STDOUT, timeout=180)
        log = (artifact / 'tests.log').read_text()
        print('\n'.join(log.splitlines()[-(16 if result.returncode == 0 else 100):]), flush=True)
        assert result.returncode == 0, 'Production candidate regression failed'
        assert re.search(r'tests 102\b', log) and re.search(r'pass 102\b', log), 'Unexpected test count'
        current(data)
        assert json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)) == before
        core.save('validation-passed.json', {'passed': True, 'tests': 102, 'sourceHash': SOURCE_HASH,
            'beforeTreeHash': core.sha(json.dumps(before, sort_keys=True).encode()), 'at': core.now()})
    finally:
        subprocess.run(compose + ['down', '--volumes', '--remove-orphans'], check=True, timeout=60)
        print(json.dumps(container_status()), flush=True)
        for kind in ['volume', 'network']:
            assert not core.docker(kind, 'ls', '-q', '--filter', 'label=com.docker.compose.project=' + project).strip()
        core.ready(data['app']['imageId'])


def build():
    data = core.state()
    current(data)
    before = json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT))
    assert before[FILE] == BEFORE_HASH
    graph = set()

    def visit(path):
        path = path.resolve()
        if path in graph:
            return
        graph.add(path)
        for reference in re.findall(r'''(?:from\s*|import\s*\()?["'](\.{1,2}/[^"']+\.js)["']''', path.read_text()):
            child = (path.parent / reference).resolve()
            if child.is_file():
                visit(child)

    for name in [FILE, 'src/regular-stock-delivery.js', 'src/stock-request-service.js']:
        visit(SERVER / name)
    changed = [str(path.relative_to(SERVER)) for path in graph if str(path.relative_to(SERVER)) != FILE
               and core.sha(path.read_bytes()) != before.get(str(path.relative_to(SERVER)))]
    validation = json.loads((RELEASE / 'validation-passed.json').read_text())
    assert validation['passed'] and validation['sourceHash'] == SOURCE_HASH
    assert validation['beforeTreeHash'] == core.sha(json.dumps(before, sort_keys=True).encode())
    assert core.sha((SERVER / 'package-lock.json').read_bytes()) == before['package-lock.json']
    source = (SERVER / FILE).read_bytes()
    assert source == (RELEASE / 'workspace.js').read_bytes()
    data.update({'authorization': 'User explicitly requested deploy', 'beforeTree': before,
                 'candidateTree': dict(before, **{FILE: SOURCE_HASH}),
                 'validatedTests': 102, 'runtimeDependencyDifferencesValidated': sorted(changed),
                 'matchedDependencyFiles': len(graph) - 1 - len(changed)})
    core.docker('tag', data['app']['imageId'], ROLLBACK)
    stage = RELEASE / 'stage'
    overlay = stage / 'overlay' / FILE
    overlay.parent.mkdir(parents=True, exist_ok=True)
    overlay.write_bytes(source)
    (stage / 'Dockerfile').write_text('FROM ' + ROLLBACK + '\nCOPY --chown=node:node overlay/ /app/\n')
    (RELEASE / 'change.patch').write_text(''.join(difflib.unified_diff(
        (RELEASE / 'before.js').read_text().splitlines(True), source.decode().splitlines(True),
        fromfile='a/' + FILE, tofile='b/' + FILE)))
    for mode, image in [('release', IMAGE), ('rollback', ROLLBACK)]:
        (RELEASE / ('compose.' + mode + '.yml')).write_text(
            'services:\n  app:\n    image: ' + image + '\n    pull_policy: never\n')
    with (RELEASE / 'build.log').open('wb') as output:
        subprocess.run(['docker', 'build', '--network=none', '--pull=false', '-t', IMAGE, str(stage)],
                       stdout=output, stderr=subprocess.STDOUT, check=True, timeout=120)
    data['candidateImageId'] = core.docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    core.save('manifest.json', data)
    core.config_check(data)
    current(data)
    print(json.dumps({'built': True, 'image': IMAGE, 'sourceHash': SOURCE_HASH,
                      'productionCandidateTests': validation['tests']}), flush=True)


def container_status():
    results = {}
    for label, args in [('running', ['ps']), ('all', ['ps', '-a'])]:
        rows = core.docker(*args, '--format', '{{.Names}} {{.Status}}').decode().splitlines()
        assert {row.split()[0] for row in rows} == {core.APP, *core.DEPENDENCIES}
        results[label] = rows
    return results


def image_check():
    assert os.environ.get('MBBS_TEST_ARTIFACT_DIR'), 'Use the disposable retention runner'
    data = core.state()
    current(data)
    name = 'mbbs-delivery-uom-image-' + str(os.getpid())
    try:
        actual = json.loads(core.bounded(data['candidateImageId'], name, 'node', '-e', core.HASH_SCRIPT))
        assert actual == data['candidateTree'], 'Unexpected image content'
    finally:
        subprocess.run(['docker', 'rm', '-fv', name], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, check=False)
        print(json.dumps(container_status()), flush=True)
        core.ready(data['app']['imageId'])
    result = {'passed': True, 'imageId': data['candidateImageId'], 'runtimeFilesVerified': len(actual),
              'sourceHash': actual[FILE]}
    core.save('image-check.json', result)
    print(json.dumps(result), flush=True)


def verify():
    data = core.state()
    core.ready(data['candidateImageId'])
    app = core.metadata(core.APP)
    assert app['configuration'] == data['app']['configuration'], 'Runtime configuration changed'
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    actual = json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT))
    assert actual == data['candidateTree'], 'Live source differs from checked image'
    result = {'deployed': True, 'verifiedAt': core.now(), 'image': IMAGE, 'imageId': app['imageId'],
              'files': [FILE], 'sourceHash': actual[FILE], 'health': 'healthy',
              'runtimeConfigurationPreserved': True, 'dependencyContainersUnchanged': True,
              'databaseMigration': False, 'containers': container_status()}
    core.save('deployment-result.json', result)
    print(json.dumps(result), flush=True)


def deploy():
    data = core.state()
    current(data)
    check = json.loads((RELEASE / 'image-check.json').read_text())
    assert check['passed'] and check['imageId'] == data['candidateImageId']
    assert core.docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip() == data['candidateImageId']
    core.config_check(data)
    active = core.preflight()
    active['automaticFulfillment'] = int(core.sql("SELECT count(*) FROM dispatch_sales_order_if_candidates WHERE status='posting';"))
    core.assert_no_active_operations(active)
    args = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
    try:
        with (RELEASE / 'publish.log').open('wb') as output:
            subprocess.run(core.compose(data, 'release') + args, cwd=ROOT, stdout=output,
                           stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except BaseException:
        with (RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(core.compose(data, 'rollback') + args, cwd=ROOT, stdout=output,
                           stderr=subprocess.STDOUT, check=True, timeout=60)
        core.ready(data['app']['imageId'])
        core.save('rollback-result.json', {'at': core.now(), 'priorImageRestored': True})
        raise


if __name__ == '__main__':
    os.umask(0o077)
    signal.signal(signal.SIGTERM, lambda signum, _: sys.exit(128 + signum))
    {'validate': validate, 'build': build, 'image-check': image_check, 'deploy': deploy, 'verify': verify}[sys.argv[1]]()

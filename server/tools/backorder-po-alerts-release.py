"""Scoped Already Ordered PO progress alerts release; preserves live configuration and unrelated source."""
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
RELEASE = SERVER / 'deployments/backorder-po-alerts-20261027'
IMAGE = 'mbbs-operator-app:backorder-po-alerts-20261027'
ROLLBACK = IMAGE + '-rollback'
FILES = json.loads((SERVER / 'tools/backorder-po-alerts-files.json').read_text())
MIGRATION = FILES[-1].split('/')[-1]
spec = importlib.util.spec_from_file_location('backorder_release_base', SERVER / 'tools/ifir-integration-release.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
core = base.core
core.RELEASE = RELEASE


def current(data):
    assert core.metadata(core.APP) == data['app'], 'Live app changed; recapture and revalidate'
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    assert json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)) == data['beforeTree']
    assert base.tree(RELEASE / 'candidate') == data['candidateTree']


def capture():
    app = core.metadata(core.APP)
    initial = json.loads((RELEASE / 'live-before.json').read_text())
    assert app['imageId'] == initial['imageId'], 'Live source changed since work began'
    roots = json.loads(core.docker('exec', core.APP, 'node', '-e',
        "console.log(JSON.stringify(['src','public','migrations','contracts','package.json','package-lock.json'].filter(p=>require('node:fs').existsSync(p))))"))
    archive = core.docker('exec', core.APP, 'tar', '-cf', '-', '-C', '/app', *roots)
    before = RELEASE / 'live-before'
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(before, filter='data')
    candidate = RELEASE / 'candidate'
    if candidate.exists():
        shutil.rmtree(candidate)
    shutil.copytree(before, candidate)
    for name in FILES:
        old = RELEASE / 'before-workspace' / name
        if (before / name).exists():
            assert old.exists() and old.read_bytes() == (before / name).read_bytes(), 'Concurrent source change: ' + name
        (candidate / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SERVER / name, candidate / name)
    before_tree, candidate_tree = base.tree(before), base.tree(candidate)
    changed = sorted(name for name in before_tree.keys() | candidate_tree.keys() if before_tree.get(name) != candidate_tree.get(name))
    assert changed == sorted(FILES)
    data = {'app': app, 'dependencies': [core.metadata(name) for name in core.DEPENDENCIES],
        'beforeTree': before_tree, 'candidateTree': candidate_tree, 'files': FILES,
        'source': {name: candidate_tree[name] for name in FILES},
        'candidateTreeHash': core.sha(json.dumps(candidate_tree, sort_keys=True).encode()), 'at': core.now()}
    core.save('manifest.json', data)
    current(data)
    print(json.dumps({'captured': True, 'files': changed, 'treeHash': data['candidateTreeHash']}))


def build():
    data = core.state(); current(data)
    core.docker('tag', data['app']['imageId'], ROLLBACK)
    stage = RELEASE / 'stage'
    for name in FILES:
        target = stage / 'overlay' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(RELEASE / 'candidate' / name, target)
    (stage / 'Dockerfile').write_text('FROM ' + ROLLBACK + '\nCOPY --chown=node:node overlay/ /app/\n')
    subprocess.run(['docker', 'build', '--network=none', '--pull=false', '-t', IMAGE, str(stage)], check=True)
    for mode, image in [('release', IMAGE), ('rollback', ROLLBACK)]:
        (RELEASE / ('compose.' + mode + '.yml')).write_text('services:\n  app:\n    image: ' + image + '\n')
    data['candidateImageId'] = core.docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    core.save('manifest.json', data)
    core.config_check(data)
    current(data)
    print(json.dumps({'built': True, 'imageId': data['candidateImageId']}))


def verify():
    data = core.state(); core.ready(data['candidateImageId'])
    actual = core.metadata(core.APP)
    assert actual['configuration'] == data['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    assert json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)) == data['candidateTree']
    schema = json.loads(core.sql("""SELECT json_build_object(
      'migration',(SELECT count(*) FROM schema_migrations WHERE filename='315_backorder_po_alert_receipts.sql'),
      'receiptsTable',to_regclass('backorder_po_alert_receipts') IS NOT NULL)"""))
    assert schema == {'migration': 1, 'receiptsTable': True}
    containers = {}
    for args, key in [(['ps'], 'running'), (['ps', '-a'], 'all')]:
        containers[key] = core.docker(*args, '--format', '{{.Names}} {{.Status}}').decode().splitlines()
        assert {line.split()[0] for line in containers[key]} == {core.APP, *core.DEPENDENCIES}
    result = {'deployed': True, 'at': core.now(), 'imageId': actual['imageId'], 'schema': schema,
        'configurationPreserved': True, 'dependenciesUnchanged': True, 'runtimeFilesVerified': len(data['candidateTree']),
        'containers': containers, 'source': data['source'], 'rollbackImage': ROLLBACK}
    core.save('deployment-result.json', result)
    print(json.dumps(result))


def apply():
    data = core.state(); current(data)
    validation = json.loads((RELEASE / 'validation-passed.json').read_text())
    assert validation['passed'] and validation['source'] == data['source']
    core.config_check(data)
    core.assert_no_active_operations(core.preflight())
    assert int(core.sql("SELECT count(*) FROM schema_migrations WHERE filename='" + MIGRATION + "'")) == 0
    # The additive receipt table is safe to retain if the app image is rolled back.
    stopped = False
    try:
        core.docker('stop', '--time', '30', core.APP, timeout=40); stopped = True
        core.assert_no_active_operations(core.preflight())
        core.sql("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';\n" +
            (RELEASE / 'candidate/migrations' / MIGRATION).read_text() +
            "\nINSERT INTO schema_migrations(filename) VALUES('" + MIGRATION + "'); COMMIT;")
        subprocess.run(core.compose(data, 'release') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'], cwd=ROOT, check=True, timeout=60)
        verify()
    except BaseException:
        if stopped:
            subprocess.run(core.compose(data, 'rollback') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'], cwd=ROOT, check=True, timeout=60)
            core.ready(data['app']['imageId'])
            core.save('rollback-result.json', {'at': core.now(), 'previousImageRestored': True, 'receiptDataRetained': True})
        raise


if __name__ == '__main__':
    {'capture': capture, 'build': build, 'apply': apply, 'verify': verify}[sys.argv[1]]()

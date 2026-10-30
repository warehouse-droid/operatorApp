"""Release the scoped load-completion fix over the captured live image."""
import difflib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import urllib.request

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
RELEASE = SERVER / 'deployments/load-completion-rounding-20261022'
IMAGE = 'mbbs-operator-app:load-completion-rounding-20261022'
ROLLBACK = IMAGE + '-rollback'
FILES = ['src/operator-load-quantity.js', 'src/delivery-repository.js', 'public/operator.js',
         'public/operator.html', 'public/service-worker.js']
spec = importlib.util.spec_from_file_location('load_rounding_release_base', SERVER / 'tools/ifir-integration-release.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
core = base.core
core.RELEASE = RELEASE


def source_hash(root):
    import hashlib
    digest = hashlib.sha256()
    for name in FILES[:3]:
        digest.update(name.encode())
        digest.update((root / name).read_bytes())
    return digest.hexdigest()


def capture():
    RELEASE.mkdir(parents=True, exist_ok=False)
    app = core.metadata(core.APP)
    dependencies = [core.metadata(name) for name in core.DEPENDENCIES]
    before = RELEASE / 'before'
    before.mkdir()
    roots = json.loads(core.docker('exec', core.APP, 'node', '-e',
        "console.log(JSON.stringify(['src','public','migrations','contracts','package.json','package-lock.json'].filter(p=>require('node:fs').existsSync(p))))"))
    archive = core.docker('exec', core.APP, 'tar', '-cf', '-', '-C', '/app', *roots)
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(before, filter='data')
    candidate = RELEASE / 'candidate'
    shutil.copytree(before, candidate)
    patch = ''
    for name in FILES:
        original = (before / name).read_text() if (before / name).exists() else ''
        updated = (SERVER / name).read_text()
        patch += ''.join(difflib.unified_diff(original.splitlines(True), updated.splitlines(True),
                                            fromfile='a/' + name, tofile='b/' + name))
        shutil.copy2(SERVER / name, candidate / name)
    (RELEASE / 'release.patch').write_text(patch)
    before_tree, candidate_tree = base.tree(before), base.tree(candidate)
    changed = sorted(name for name in before_tree.keys() | candidate_tree.keys()
                     if before_tree.get(name) != candidate_tree.get(name))
    assert changed == sorted(FILES), changed
    core.save('manifest.json', {'capturedAt': core.now(), 'app': app, 'dependencies': dependencies,
        'authorization': 'User requested performing the completion fix after every load; exact NetSuite formula supplied.',
        'beforeTree': before_tree, 'candidateTree': candidate_tree, 'files': changed,
        'sourceHash': source_hash(candidate)})
    assert core.metadata(core.APP) == app
    print(json.dumps({'captured': True, 'files': changed, 'sourceHash': source_hash(candidate)}))


def current(data):
    assert core.metadata(core.APP) == data['app'], 'Live application changed; recapture required'
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    assert base.tree(RELEASE / 'candidate') == data['candidateTree'], 'Candidate source changed'


def compose(data, mode):
    return core.compose(data, mode)


def checked():
    data = core.state()
    evidence = json.loads((RELEASE / 'test-evidence.json').read_text())
    assert evidence['sourceHash'] == data['sourceHash'] == source_hash(RELEASE / 'candidate')
    assert evidence['summary']['newFailures'] == 0
    assert evidence['summary']['files'] == 40 and evidence['summary']['tests'] >= 284
    assert evidence['types'] == evidence['lint'] == evidence['syntax'] == 'passed'
    assert evidence['mutation']['killed'] == evidence['mutation']['total'] == 6
    return data


def build():
    data = checked()
    current(data)
    core.docker('tag', data['app']['imageId'], ROLLBACK)
    stage = RELEASE / 'stage'
    for name in FILES:
        target = stage / 'overlay' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(RELEASE / 'candidate' / name, target)
    (stage / 'Dockerfile').write_text('FROM ' + ROLLBACK + '\nCOPY --chown=node:node overlay/ /app/\n')
    for mode, image in [('release', IMAGE), ('rollback', ROLLBACK)]:
        (RELEASE / ('compose.' + mode + '.yml')).write_text('services:\n  app:\n    image: ' + image + '\n    pull_policy: never\n')
    with (RELEASE / 'build.log').open('wb') as output:
        subprocess.run(['docker', 'build', '--network=none', '--pull=false', '-t', IMAGE, str(stage)],
                       check=True, stdout=output, stderr=subprocess.STDOUT, timeout=180)
    data['candidateImageId'] = core.docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    core.save('manifest.json', data)
    core.config_check(data)
    print(json.dumps({'built': True, 'image': IMAGE}))


def verify():
    data = checked()
    core.ready(data['candidateImageId'])
    actual = core.metadata(core.APP)
    assert actual['configuration'] == data['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    assert json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)) == data['candidateTree']
    for name in FILES[2:]:
        with urllib.request.urlopen('http://127.0.0.1:3000/' + name.removeprefix('public/'), timeout=10) as response:
            assert response.status == 200
            assert core.sha(response.read()) == data['candidateTree'][name]
    containers = {key: core.docker(*args, '--format', '{{.Names}} {{.Status}}').decode().splitlines()
                  for key, args in [('running', ['ps']), ('all', ['ps', '-a'])]}
    for rows in containers.values():
        assert {row.split()[0] for row in rows} == {core.APP, *core.DEPENDENCIES}
    result = {'deployed': True, 'at': core.now(), 'image': IMAGE, 'imageId': actual['imageId'],
              'sourceHash': data['sourceHash'], 'healthy': True, 'configurationPreserved': True,
              'dependenciesUnchanged': True, 'assetsVerified': 3, 'files': FILES, 'rollbackImage': ROLLBACK}
    core.save('containers.json', containers)
    core.save('deployed.json', result)
    print(json.dumps(result))


def deploy():
    data = checked()
    current(data)
    core.config_check(data)
    active = core.preflight()
    core.assert_no_active_operations(active)
    try:
        subprocess.run(compose(data, 'release') + ['up', '-d', '--no-deps', '--no-build', 'app'], check=True, timeout=120)
        verify()
    except BaseException:
        subprocess.run(compose(data, 'rollback') + ['up', '-d', '--no-deps', '--no-build', 'app'], check=True, timeout=120)
        core.ready(data['app']['imageId'])
        raise


def diagnose():
    rows = core.sql("""BEGIN READ ONLY; SET LOCAL statement_timeout='5s';
SELECT json_agg(row_to_json(l)) FROM (SELECT id, unit, quantity, loaded_qty,
pallet_qty, layer_qty, section_qty, piece_qty, to_plt, to_lyr, to_sec, to_pcs
FROM sales_order_lines WHERE sales_order_id=1078880 AND id IN (559147,559148) ORDER BY id) l;
COMMIT;""")
    script = """import {operatorLoadedUnitCount} from './src/operator-load-quantity.js';
const lines = LINES;
console.log(JSON.stringify(lines.map(line => {
  let consumed = 0;
  const remaining = {};
  for (const [name, conversion] of [['pallet','to_plt'],['layer','to_lyr'],['section','to_sec'],['piece','to_pcs']]) {
    const required = Number(line[name+'_qty'] || 0), factor = Number(line[conversion] || 0);
    const loaded = operatorLoadedUnitCount(Number(line.loaded_qty), consumed, required, factor, line.unit);
    consumed += loaded * factor;
    remaining[name] = required - loaded;
  }
  return {lineId: line.id, quantity: line.quantity, loadedQuantity: line.loaded_qty, remaining};
})));""".replace('LINES', rows)
    result = json.loads(core.docker('exec', '-i', '-w', '/app', core.APP, 'node', '--input-type=module', input=script.encode()))
    core.save('soa10636-readonly-diagnostic.json', {'at': core.now(), 'order': 'SOA10636', 'lines': result})
    print(json.dumps(result))


if __name__ == '__main__':
    os.umask(0o077)
    {'capture': capture, 'build': build, 'deploy': deploy, 'verify': verify, 'diagnose': diagnose}[sys.argv[1]]()

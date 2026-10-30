"""Scoped quantity-policy rollout; live capture, exact-source checks, app-only rollback."""
import difflib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
RELEASE = SERVER / 'deployments/ifir-quantity-policy-20261021'
IMAGE = 'mbbs-operator-app:ifir-quantity-policy-20261021'
ROLLBACK = IMAGE + '-rollback'
FLAG = 'NETSUITE_IFIR_POSTING_QUANTITY_POLICY_ENABLED'
spec = importlib.util.spec_from_file_location('core', SERVER / 'tools/delivery-scm-release.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE = RELEASE
core.HASH_SCRIPT = """const fs=require('node:fs'),c=require('node:crypto'),result={};
function hash(p){result[p]=c.createHash('sha256').update(fs.readFileSync(p)).digest('hex');}
function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=d+'/'+e.name;
if(e.isDirectory())walk(p);else if(e.isFile())hash(p);}}
for(const d of ['src','public','migrations'])walk(d);
for(const p of ['package.json','package-lock.json'])hash(p);console.log(JSON.stringify(result));"""


def tree(root):
    files = [p for d in ['src', 'public', 'migrations'] for p in (root / d).rglob('*') if p.is_file()]
    files += [root / p for p in ['package.json', 'package-lock.json']]
    return {str(p.relative_to(root)): core.sha(p.read_bytes()) for p in sorted(files)}


def current(data):
    assert core.metadata(core.APP) == data['app'], 'Live app changed; rebase required'
    assert [core.metadata(n) for n in core.DEPENDENCIES] == data['dependencies'], 'Dependency changed'
    assert json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)) == data['beforeTree']
    assert tree(RELEASE / 'candidate') == data['candidateTree'], 'Candidate changed'
    assert all(core.sha((SERVER / n).read_bytes()) == value for n, value in data['workspace'].items()), 'Workspace changed'


def prepare():
    capture = json.loads((RELEASE / 'capture.json').read_text())
    assert core.metadata(core.APP) == capture['app']
    before, candidate = RELEASE / 'before', RELEASE / 'candidate'
    shutil.copytree(before, candidate)
    files = [n for n in json.loads((ROOT / 'docker/ifir-diagnostics/changed.json').read_text()) if n.startswith('src/')]
    patch = ''
    for name in files:
        original = (before / name).read_text()
        if name == 'src/netsuite.js':
            anchor = '  settings: async () => ({ enabled: await getIfirPostingRestletEnabled(),\n'
            assert original.count(anchor) == 1
            after = original.replace(anchor, anchor + '    quantityPolicyEnabled: config.netsuite.ifirPostingQuantityPolicyEnabled,\n')
        else:
            after = (SERVER / name).read_text()
        (candidate / name).write_text(after)
        patch += ''.join(difflib.unified_diff(original.splitlines(True), after.splitlines(True),
                         fromfile='a/' + name, tofile='b/' + name))
    (RELEASE / 'release.patch').write_text(patch)
    before_tree, after_tree = tree(before), tree(candidate)
    assert sorted(n for n in before_tree if before_tree[n] != after_tree[n]) == sorted(files)
    data = {**capture, 'files': files, 'beforeTree': before_tree, 'candidateTree': after_tree,
            'candidateTreeHash': core.sha(json.dumps(after_tree, sort_keys=True).encode()),
            'workspace': {n: core.sha((SERVER / n).read_bytes()) for n in files}}
    core.save('manifest.json', data)
    current(data)
    print(json.dumps({'prepared': True, 'changedFiles': files, 'candidateTreeHash': data['candidateTreeHash']}))


def config_check(data):
    args = core.compose(data, 'release')
    # Compare complete Compose configuration without emitting any secret values.
    # Explicit construction avoids depending on the number of existing overlays.
    old_args = ['sudo', '-n', 'docker', 'compose', '--project-directory', data['app']['projectDirectory'], '-p', 'mbbs-operator-app']
    for name in data['app']['configFiles'].split(','):
        old_args += ['-f', name]
    old_args += ['--env-file', str(ROOT / 'docker/env/.env')]
    old = json.loads(subprocess.check_output(old_args + ['config', '--format', 'json'], cwd=ROOT))
    new = json.loads(subprocess.check_output(args + ['config', '--format', 'json'], cwd=ROOT))
    old['services']['app']['image'] = IMAGE
    old['services']['app']['pull_policy'] = 'never'
    old['services']['app'].setdefault('environment', {})[FLAG] = 'true'
    assert old == new, 'Unexpected Compose configuration change'
    live = json.loads(core.docker('inspect', core.APP))[0]
    env_before = dict(entry.split('=', 1) for entry in live['Config']['Env'])
    image = json.loads(core.docker('image', 'inspect', data['candidateImageId']))[0]['Config']
    env_after = dict(entry.split('=', 1) for entry in image.get('Env', []))
    env_after.update({k: str(v) for k, v in new['services']['app'].get('environment', {}).items()})
    env_before[FLAG] = 'true'
    assert env_before == env_after, 'Unexpected environment change'
    core.save('config-check.json', {'passed': True, 'onlyEnvironmentChange': {FLAG: 'true'},
              'otherServicesAndSettingsPreserved': True})


def build():
    data = core.state()
    current(data)
    core.docker('tag', data['app']['imageId'], ROLLBACK)
    stage = RELEASE / 'stage'
    for name in data['files']:
        dest = stage / 'overlay' / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(RELEASE / 'candidate' / name, dest)
    (stage / 'Dockerfile').write_text('FROM ' + ROLLBACK + '\nCOPY --chown=node:node overlay/ /app/\n')
    for mode, tag in [('release', IMAGE), ('rollback', ROLLBACK)]:
        flag = 'true' if mode == 'release' else 'false'
        (RELEASE / ('compose.' + mode + '.yml')).write_text(
            f'services:\n  app:\n    image: {tag}\n    pull_policy: never\n    environment:\n      {FLAG}: "{flag}"\n')
    with (RELEASE / 'build.log').open('wb') as output:
        subprocess.run(['docker', 'build', '--network', 'none', '--pull=false', '-t', IMAGE, str(stage)],
                       stdout=output, stderr=subprocess.STDOUT, check=True, timeout=180)
    data['candidateImageId'] = core.docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    core.save('manifest.json', data)
    config_check(data)
    print(json.dumps({'built': True, 'imageId': data['candidateImageId']}))


def apply():
    data = core.state()
    current(data)
    check = json.loads((RELEASE / 'validation-passed.json').read_text())
    assert check['passed'] and check['candidateTreeHash'] == data['candidateTreeHash']
    image = json.loads((RELEASE / 'image-check.json').read_text())
    assert image['passed'] and image['imageId'] == data['candidateImageId']
    account = json.loads((RELEASE / 'account-validation.json').read_text())
    assert account['passed'] and account['quantityPolicy'] == 'sqft_remaining_v1'
    assert account['transactionsCreated'] == 0
    config_check(data)
    core.assert_no_active_operations(core.preflight())
    assert int(core.sql("BEGIN READ ONLY; SET LOCAL statement_timeout='5s'; SELECT count(*) FROM dispatch_sales_order_if_candidates WHERE status='posting'; COMMIT;")) == 0
    current(data)
    try:
        with (RELEASE / 'compose-up.log').open('wb') as out:
            subprocess.run(core.compose(data, 'release') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'],
                           stdout=out, stderr=subprocess.STDOUT, check=True, timeout=90)
        core.ready(data['candidateImageId'])
        assert json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)) == data['candidateTree']
        assert [core.metadata(n) for n in core.DEPENDENCIES] == data['dependencies']
        script = """import assert from 'node:assert/strict';import {config} from './src/config.js';
import {getIfirQuantityPolicyEnabled} from './src/netsuite-ifir-posting-policy.js';import {closeDb} from './src/db.js';
try{assert.equal(config.netsuite.ifirPostingQuantityPolicyEnabled,true);assert.equal(await getIfirQuantityPolicyEnabled(),true);
console.log(JSON.stringify({quantityFlag:true,effectivePolicy:true}));}finally{await closeDb();}"""
        policy = json.loads(core.docker('exec', '-i', '-w', '/app', core.APP, 'node', '--input-type=module', input=script.encode()))
        result = {'deployed': True, 'at': core.now(), 'imageId': data['candidateImageId'],
                  'candidateTreeHash': data['candidateTreeHash'], 'runtimeFilesVerified': len(data['candidateTree']),
                  'onlyEnvironmentChange': {FLAG: 'true'}, 'dependenciesUnchanged': True, **policy}
        core.save('deployment-result.json', result)
        print(json.dumps(result))
    except BaseException:
        with (RELEASE / 'rollback.log').open('wb') as out:
            subprocess.run(core.compose(data, 'rollback') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'],
                           stdout=out, stderr=subprocess.STDOUT, check=True, timeout=90)
        core.ready(data['app']['imageId'])
        core.save('rollback-result.json', {'rolledBack': True, 'at': core.now(), 'imageId': data['app']['imageId']})
        raise


if __name__ == '__main__':
    {'prepare': prepare, 'build': build, 'apply': apply}[sys.argv[1]]()

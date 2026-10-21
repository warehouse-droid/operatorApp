"""Release only the gated Operator phone interface over the active app image."""
import atexit
import difflib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import urllib.request

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
RELEASE = SERVER / 'deployments/operator-phone-20261008'
ARTIFACTS = SERVER / 'test-artifacts/operator-phone-20261008'
spec = importlib.util.spec_from_file_location('phone_release_helpers', SERVER / 'tools/delivery-scm-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE = RELEASE
release.IMAGE = 'mbbs-operator-app:operator-phone-20261008'
release.ROLLBACK = release.IMAGE + '-rollback'
release.READ_NAME = 'mbbs-operator-phone-release-reader'
release.CHECK_NAME = 'mbbs-operator-phone-release-image-check'
release.docker = lambda *args, **kwargs: subprocess.check_output(['sudo', '-n', 'docker', *args], **kwargs)
MIGRATION = '272_operator_phone_layout.sql'
ADDED = ['public/operator-phone.js', 'public/operator-phone.css', 'src/operator-phone-policy.js',
         'src/operator-phone-policy-router.js', 'migrations/' + MIGRATION]
EDITED = ['public/operator.js', 'public/operator.html', 'public/service-worker.js',
          'src/server.js', 'src/mbt/feature-gate-catalog.js']
TABLET = ['public/operator.css', 'public/operator-inventory.css', 'public/operator-display-settings.css']


def cleanup_tests():
    for name in [release.READ_NAME, release.CHECK_NAME]:
        rows = release.docker('ps', '-a', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}').decode().split()
        for container_id in rows:
            label = release.docker('inspect', container_id, '--format', '{{index .Config.Labels "com.mbbs.lifecycle"}}').decode().strip()
            assert label == 'disposable-test'
            release.docker('rm', '--force', '--volumes', container_id)
    for args, filename in [(['ps'], 'docker-ps.log'), (['ps', '-a'], 'docker-ps-a.log')]:
        (RELEASE / filename).write_bytes(release.docker(*args, '--format', '{{.Names}} {{.Status}}'))


release.cleanup_manual = cleanup_tests


def replace_once(path, before, after):
    source = path.read_text()
    assert source.count(before) == 1, 'Production insertion point changed: ' + str(path)
    path.write_text(source.replace(before, after, 1))


def capture():
    os.umask(0o077)
    RELEASE.mkdir(exist_ok=False)
    before = release.metadata(release.APP)
    dependencies = [release.metadata(name) for name in release.DEPENDENCIES]
    baseline = RELEASE / 'before'
    baseline.mkdir()
    archive = release.docker('exec', release.APP, 'tar', '-cf', '-', '-C', '/app',
        'src', 'public', 'migrations', 'package.json', 'package-lock.json')
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(baseline, filter='data')
    assert release.metadata(release.APP) == before
    candidate = RELEASE / 'candidate'
    shutil.copytree(baseline, candidate)
    # Shared working files also contain unrelated work. Select the phone hunks
    # from the original task capture, then apply them to production with no fuzz.
    patch = ''
    markers = ['MBBSOperatorPhone', 'refreshOperatorPhonePolicy', 'operatorPhonePolicy',
               'operator-phone', 'phone-v1', 'phone-layout-policy']
    for name in EDITED[:3]:
        old = (ARTIFACTS / 'baseline' / Path(name).name).read_text()
        new = (SERVER / name).read_text()
        diff = ''.join(difflib.unified_diff(old.splitlines(True), new.splitlines(True),
            fromfile='a/' + name, tofile='b/' + name, n=3))
        sections = re.split(r'(?m)(?=^@@ )', diff)
        hunks = [part for part in sections[1:] if any(marker in part for marker in markers)]
        assert hunks, 'No phone changes selected: ' + name
        patch += sections[0] + ''.join(hunks)
    release.apply_patch(candidate, patch, 'phone-client')
    # Other work can advance shared cache labels after the phone implementation.
    # Pin the scoped release's entry script and app-shell cache to its own version.
    html = candidate / 'public/operator.html'
    contents, count = re.subn(r'(/operator\.js\?v=)[^"<>]+', r'\g<1>20261008-phone-v1', html.read_text())
    assert count == 1
    html.write_text(contents)
    worker = candidate / 'public/service-worker.js'
    contents, count = re.subn(r'const CACHE_NAME = "[^"]+";', 'const CACHE_NAME = "mbbs-yard-operator-20261008-phone-v1";', worker.read_text())
    assert count == 1
    contents, count = re.subn(r'(/operator\.js\?v=)[^"<>]+', r'\g<1>20261008-phone-v1', contents)
    assert count == 1
    worker.write_text(contents)
    entrypoint = candidate / 'src/server.js'
    import_anchor = 'import { createOperatorPreferencesRouter } from "./operator-preferences-router.js";'
    replace_once(entrypoint, import_anchor, import_anchor + '\nimport { createOperatorPhonePolicyRouter } from "./operator-phone-policy-router.js";')
    route_anchor = 'app.use("/api/operator/preferences", requireOperator, requireOperatorAccess, createOperatorPreferencesRouter());'
    replace_once(entrypoint, route_anchor, route_anchor + '\napp.use("/api/operator/phone-layout-policy", requireOperator, requireOperatorAccess, createOperatorPhonePolicyRouter());')
    gate = re.search(r'  Object\.freeze\(\{\n    flagKey: "operator_phone_layout",[\s\S]*?\n  \}\),\n',
                     (SERVER / 'src/mbt/feature-gate-catalog.js').read_text()).group()
    anchor = '  Object.freeze({\n    flagKey: "sales_stock_request_over_availability",'
    replace_once(candidate / 'src/mbt/feature-gate-catalog.js', anchor, gate + anchor)
    for name in ADDED:
        assert not (candidate / name).exists(), 'Phone file already deployed: ' + name
        shutil.copy2(SERVER / name, candidate / name)
    before_tree, after_tree = release.files_at(baseline), release.files_at(candidate)
    changed = sorted(name for name in before_tree.keys() | after_tree.keys() if before_tree.get(name) != after_tree.get(name))
    assert changed == sorted(ADDED + EDITED), changed
    assert all(before_tree[name] == after_tree[name] for name in TABLET)
    complete_patch = ''.join(''.join(difflib.unified_diff(
        (baseline / name).read_text().splitlines(True) if (baseline / name).exists() else [],
        (candidate / name).read_text().splitlines(True), fromfile='a/' + name, tofile='b/' + name)) for name in changed)
    (RELEASE / 'release.patch').write_text(complete_patch)
    release.save('manifest.json', {'capturedAt': release.now(), 'app': before, 'dependencies': dependencies,
        'files': changed, 'beforeTree': before_tree, 'candidateTree': after_tree,
        'candidateTreeHash': release.sha(json.dumps(after_tree, sort_keys=True).encode()),
        'workspace': {name: release.sha((SERVER / name).read_bytes()) for name in ADDED},
        'packages': {name: release.sha((candidate / name).read_bytes()) for name in ['package.json', 'package-lock.json']}})
    release.current(release.state())
    print(json.dumps({'captured': True, 'changedFiles': changed, 'tabletStylesPreserved': True}), flush=True)


def validated():
    data = release.state()
    release.current(data)
    result = json.loads((RELEASE / 'test-artifacts/operator-phone-20261008/browser-results.json').read_text())
    assert len(result['results']) == 680 and all(row['pass'] for row in result['results']) and not result['errors']
    log = (RELEASE / 'candidate-checks.log').read_text()
    counts = {name: int(value) for name, value in re.findall(r'^# (tests|pass|fail|skipped) (\d+)$', log, re.M)}
    assert counts['pass'] >= 18 and counts['tests'] == counts['pass'] and counts['fail'] == counts['skipped'] == 0 and 'PASS: 680' in log
    release.save('validation-passed.json', {'passed': True, 'candidateTreeHash': data['candidateTreeHash'],
        'browserChecks': len(result['results']), 'focusedTests': counts['pass'], 'at': release.now()})
    print(json.dumps({'candidateValidated': True, 'browserChecks': 680, 'focusedTests': counts['pass']}), flush=True)


def gate_snapshot():
    return json.loads(release.sql("SELECT json_build_object('gate',(SELECT row_to_json(f) FROM mbt_feature_flags f WHERE flag_key='operator_phone_layout'),'migration',(SELECT count(*) FROM schema_migrations WHERE filename='" + MIGRATION + "'));"))


def migrate():
    before = gate_snapshot()
    release.save('phone-gate.before.json', before)
    assert before['gate'] is None or before['gate']['enabled'] is False, 'Phone gate unexpectedly already enabled'
    sql = (RELEASE / 'candidate/migrations' / MIGRATION).read_text()
    release.sql("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'; " + sql +
                "\nINSERT INTO schema_migrations(filename) VALUES ('" + MIGRATION + "') ON CONFLICT (filename) DO NOTHING; COMMIT;")
    after = gate_snapshot()
    assert after['migration'] == 1 and after['gate']['enabled'] is False
    release.save('phone-gate.after.json', after)


def verify():
    data = release.state()
    release.ready(data['candidateImageId'])
    live = release.metadata(release.APP)
    assert live['imageId'] == data['candidateImageId']
    assert live['configuration'] == data['app']['configuration'], 'Runtime configuration changed'
    assert [release.metadata(name) for name in release.DEPENDENCIES] == data['dependencies'], 'Dependency changed'
    assert json.loads(release.docker('exec', release.APP, 'node', '-e', release.HASH_SCRIPT)) == data['candidateTree']
    public = {name: data['candidateTree'][name] for name in data['files'] if name.startswith('public/')}
    public.update({name: data['candidateTree'][name] for name in TABLET})
    checked = release.http_check(public, ['/api/operator/phone-layout-policy'])
    schema = gate_snapshot()
    assert schema['migration'] == 1 and schema['gate']['enabled'] is False
    script = '''import {getOperatorPhonePolicy} from './src/operator-phone-policy.js';
import {materializeMbtAdminGates} from './src/mbt/feature-gate-catalog.js';
import {closeDb} from './src/db.js';
try {const policy=await getOperatorPhonePolicy();
const gate=materializeMbtAdminGates({flags:[policy],environment:{enabled:false}}).find(row=>row.flagKey===policy.flagKey);
console.log(JSON.stringify({policy,adminLabel:gate.label,adminWritable:!gate.locked,effective:gate.effective}));}
finally {await closeDb();}'''
    policy = json.loads(release.docker('exec', '-i', release.APP, 'node', '--input-type=module', input=script.encode()))
    assert policy['policy']['enabled'] is False and policy['adminWritable'] and policy['effective'] is False
    result = {'deployed': True, 'at': release.now(), 'image': release.IMAGE, 'imageId': live['imageId'],
        'changedFiles': data['files'], 'configurationPreserved': True, 'workerAndDependenciesUnchanged': True,
        'tabletStylesPreserved': True, 'phoneGateEnabled': False, 'policy': policy, 'http': checked}
    release.save('deployment-result.json', result)
    print(json.dumps({'deployed': True, 'phoneGateEnabled': False, 'productionHealthy': True, 'http': checked}), flush=True)


def apply():
    data = release.state()
    release.current(data)
    check = json.loads((RELEASE / 'image-check.json').read_text())
    assert check['passed'] and check['imageId'] == data['candidateImageId']
    release.config_check(data)
    release.assert_no_active_operations(release.preflight())
    migrate()
    samples, stop = [], threading.Event()
    start = time.monotonic()
    def probe():
        while not stop.is_set():
            try:
                with urllib.request.urlopen('http://127.0.0.1:3000/health', timeout=0.5) as response:
                    ok = response.status == 200
            except OSError:
                ok = False
            samples.append({'seconds': round(time.monotonic() - start, 3), 'ok': ok})
            stop.wait(0.2)
    thread = threading.Thread(target=probe, daemon=True)
    thread.start()
    args = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
    try:
        with (RELEASE / 'cutover.log').open('wb') as output:
            subprocess.run(release.compose(data, 'release') + args, cwd=ROOT, stdout=output,
                           stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except BaseException:
        with (RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(release.compose(data, 'rollback') + args, cwd=ROOT, stdout=output,
                           stderr=subprocess.STDOUT, check=True, timeout=60)
        release.ready(data['app']['imageId'])
        release.save('rollback-result.json', {'restoredImageId': data['app']['imageId'], 'phoneGateEnabled': False})
        raise
    finally:
        stop.set()
        thread.join(timeout=2)
        release.save('cutover.json', {'seconds': round(time.monotonic() - start, 3), 'samples': samples})


if __name__ == '__main__':
    os.umask(0o077)
    if sys.argv[1] == 'build':
        atexit.register(release.cleanup_manual)
    {'capture': capture, 'validated': validated, 'build': release.build, 'apply': apply, 'verify': verify}[sys.argv[1]]()

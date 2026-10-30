"""Deploy only driver-inactivation behavior over the current live application."""
import difflib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys

sys.dont_write_bytecode = True
SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('driver_inactivation_release_core', SERVER / 'tools/dispatch-source-save-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE = SERVER / 'deployments/driver-inactivation-20261029'
release.IMAGE = 'mbbs-operator-app:driver-inactivation-20261029'
release.ROLLBACK = 'mbbs-operator-app:driver-inactivation-rollback-20261029'
release.FILES = [
    'src/driver-execution-access.js', 'src/driver-repository.js',
    'src/dispatch-setup-repository.js', 'src/dispatch-fleet-status.js',
    'src/server.js', 'public/dispatch-setup.js',
    'src/mbt/bin-dispatch-service.js', 'src/mbt/bin-planning-assignments.js',
]
TESTS = [
    'test/dispatch/unit/driver-inactivation-planning.test.js',
    'test/dispatch/integration/driver-inactivation.test.js',
    'test/mbt/integration/bin-planning-driver.test.js',
    'test/mbt/integration/p3-bin-confirmation-coverage-hardening.test.js',
    'test/mbt/integration/driver-bin-execution.test.js',
    'test/mbt/integration/driver-bin-offline-queue.test.js',
    'test/mbt/integration/driver-bin-reservation-hardening.test.js',
    'src/dispatch-fleet-status-endpoint-harness.js',
]
HASH_SCRIPT = """const fs=require('node:fs'),c=require('node:crypto'),result={};
function hash(p){result[p]=c.createHash('sha256').update(fs.readFileSync(p)).digest('hex');}
function walk(d){if(!fs.existsSync(d))return;for(const e of fs.readdirSync(d,{withFileTypes:true})){
const p=d+'/'+e.name;if(e.isDirectory())walk(p);else if(e.isFile())hash(p);}}
for(const d of ['src','public','migrations','contracts'])walk(d);
for(const p of ['package.json','package-lock.json'])hash(p);
console.log(JSON.stringify(result));"""


def replace(source, before, after):
    assert source.count(before) == 1, 'Release anchor changed: ' + before[:120]
    return source.replace(before, after)


def candidate_source(name, live):
    if name == 'src/driver-execution-access.js':
        assert live is None, 'Execution guard already exists in production'
        return (SERVER / name).read_text()
    if name == 'src/driver-repository.js':
        live = replace(live,
            'import { DISPATCH_FLEET_PLANNING_LOCK } from "./dispatch-fleet-status.js";',
            'import { DISPATCH_FLEET_PLANNING_LOCK } from "./dispatch-fleet-status.js";\n'
            'import { assertDriverExecutionActive } from "./driver-execution-access.js";')
        live = replace(live,
            '    return startDriverJobUnlocked(driverLogin, jobIdValue, options);',
            '    await assertDriverExecutionActive(driverLogin, options.job);\n'
            '    return startDriverJobUnlocked(driverLogin, jobIdValue, options);')
        return replace(live,
            'export async function recordDriverJobPhotos(driverLogin, jobIdValue, {',
            '''export async function recordDriverJobPhotos(driverLogin, jobIdValue, options = {}) {
  return withTransaction(async () => {
    await assertDriverExecutionActive(driverLogin, options.job);
    return recordDriverJobPhotosUnlocked(driverLogin, jobIdValue, options);
  });
}

async function recordDriverJobPhotosUnlocked(driverLogin, jobIdValue, {''')
    if name == 'src/dispatch-setup-repository.js':
        live = replace(live, 'import { query, withTransaction } from "./db.js";',
            'import { query, withTransaction } from "./db.js";\n'
            'import { DISPATCH_FLEET_PLANNING_LOCK } from "./dispatch-fleet-status.js";')
        anchor = '''export async function setDispatchDriverActive(id, active) {
  const driverId = fleetRecordId(id, "Driver");
  return withTransaction(async () => {'''
        return replace(live, anchor, anchor + '\n    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);')
    if name == 'src/dispatch-fleet-status.js':
        live = replace(live, '        if (!resolvedDriver || resolvedDriver.active === false) {',
            '''        // Inactivation restricts execution, not dispatch planning. Retain the
        // assignment until dispatch reassigns it, including across plan saves.
        if (!resolvedDriver) {''')
        return replace(live, 'is assigned to disabled or unavailable driver', 'is assigned to unavailable driver')
    if name == 'src/server.js':
        live = replace(live,
            '''      const conflicts = req.body.active ? [] : await dispatchFleetDisableConflicts({ driver: current });
      if (conflicts.length) return { current, conflicts };
      return { current, result: await setDispatchDriverActive(current.id, req.body.active) };''',
            '''      const result = await setDispatchDriverActive(current.id, req.body.active);
      if (result && !result.driver.active) await revokeDispatchDriverSessions(result.driver.login);
      return { current, result };''')
        return replace(live,
            '''    if (change.conflicts?.length) {
      return res.status(409).json({
        code: "DISPATCH_FLEET_IN_USE",
        error: `Cannot disable ${change.current.name || change.current.login}. Reassign or finish the active work first. ${change.conflicts[0].message}`,
        conflicts: change.conflicts
      });
    }
    const { result } = change;
    if (!result) return res.status(404).json({ error: "Driver not found." });
    if (!result.driver.active) await revokeDispatchDriverSessions(result.driver.login);''',
            '''    const { result } = change;
    if (!result) return res.status(404).json({ error: "Driver not found." });''')
    if name == 'src/mbt/bin-dispatch-service.js':
        return replace(live, '      || current.driver_active !== true\n', '')
    if name == 'src/mbt/bin-planning-assignments.js':
        return replace(live, '    && current.driver_active && current.truck_active', '    && current.truck_active')
    if name == 'public/dispatch-setup.js':
        return replace(live,
            'The driver will be removed from new planning and sign-in. Existing history and statistics will remain. Active work must be reassigned or finished first.',
            'Sign-in and job execution will be blocked immediately. Planning can continue. Unfinished jobs will remain assigned until Dispatch reassigns them to an active driver. Existing history and statistics will remain.')
    raise AssertionError(name)


def tree(root):
    files = release.core.files_at(root)
    for name in ['package.json', 'package-lock.json']:
        files[name] = release.digest(root / name)
    for path in (root / 'contracts').rglob('*'):
        if path.is_file():
            files[str(path.relative_to(root))] = release.digest(path)
    return files


def current(info):
    release.current(info)
    assert tree(release.RELEASE / 'candidate') == info['candidateTree'], 'Candidate tree changed'
    assert json.loads(release.docker('exec', release.APP, 'node', '-e', HASH_SCRIPT)) == info['beforeTree'], 'Live files changed'


def prepare():
    out = release.RELEASE
    out.mkdir(parents=True, exist_ok=False)
    info = {'app': release.core.metadata(release.APP),
            'dependencies': [release.core.metadata(name) for name in release.DEPENDENCIES],
            'authorization': 'User explicitly requested deploy.'}
    before = out / 'live-before'
    before.mkdir()
    roots = json.loads(release.docker('exec', release.APP, 'node', '-e',
        "console.log(JSON.stringify(['src','public','migrations','contracts','package.json','package-lock.json'].filter(p=>require('fs').existsSync(p))))"))
    subprocess.run(['tar', '--no-same-owner', '-xf', '-', '-C', str(before)], check=True,
        input=release.docker('exec', release.APP, 'tar', '-C', '/app', '-cf', '-', *roots))
    candidate = out / 'candidate'
    shutil.copytree(before, candidate)
    patch = []
    for name in release.FILES:
        old = (before / name).read_text() if (before / name).exists() else None
        new = candidate_source(name, old)
        target = candidate / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(new)
        patch.extend(difflib.unified_diff((old or '').splitlines(True), new.splitlines(True),
            fromfile='live/' + name, tofile='candidate/' + name))
    (out / 'release.patch').write_text(''.join(patch))
    for directory in [before, candidate]:
        for path in [directory, *directory.rglob('*')]:
            path.chmod(0o755 if path.is_dir() else 0o644)
    before_tree, after_tree = tree(before), tree(candidate)
    changed = sorted(name for name in before_tree.keys() | after_tree.keys() if before_tree.get(name) != after_tree.get(name))
    assert changed == sorted(release.FILES), changed
    info.update(files={name: after_tree[name] for name in release.FILES}, beforeTree=before_tree, candidateTree=after_tree)
    release.save('manifest.json', info)
    current(info)
    print(json.dumps({'prepared': True, 'files': changed, 'baseImage': info['app']['imageId']}), flush=True)


def validate():
    if not os.environ.get('MBBS_TEST_ARTIFACT_DIR'):
        subprocess.run(['python3', str(SERVER.parent / 'docker/retention/retention.py'), 'run', '--',
            sys.executable, __file__, 'validate'], check=True)
        return
    info = release.state()
    current(info)
    tests = TESTS + sorted(str(path.relative_to(SERVER)) for path in (SERVER / 'test/mbt').rglob('driver-pwa-historical-assist-concurrency.test.js'))
    test_hashes = {name: release.digest(SERVER / name) for name in tests if name.startswith('test/')}
    log = Path(os.environ['MBBS_TEST_ARTIFACT_DIR']) / 'validation.log'
    environment = dict(os.environ, DISPATCH_SOURCE_RUNTIME=str(release.RELEASE / 'candidate'),
        DISPATCH_SOURCE_MIGRATIONS=str(release.RELEASE / 'candidate/migrations'), DISPATCH_SOURCE_SKIP_BUILD='1')
    with log.open('w') as output:
        result = subprocess.run(['bash', 'docker/run-dispatch-source-tests.sh', 'node',
            'tools/driver-inactivation-checks.mjs', 'files', *tests], cwd=SERVER.parent,
            env=environment, stdout=output, stderr=subprocess.STDOUT)
    content = log.read_text()
    summary = [line for line in content.splitlines() if line.startswith('Isolated ')
        or re.match(r'^ℹ (tests|pass|fail|cancelled|skipped) ', line)]
    print('\n'.join(summary), flush=True)
    if result.returncode:
        print(content[-18000:], flush=True)
    assert result.returncode == 0, 'Release candidate checks failed'
    current(info)
    assert test_hashes == {name: release.digest(SERVER / name) for name in test_hashes}
    release.save('verified.json', {'passed': True, 'files': info['files'], 'candidateTree': info['candidateTree'],
        'tests': tests, 'testHashes': test_hashes, 'summary': summary, 'cleanupVerified': True})


def checked():
    info = release.state()
    evidence = json.loads((release.RELEASE / 'verified.json').read_text())
    assert evidence['passed'] and evidence['files'] == info['files']
    assert evidence['candidateTree'] == info['candidateTree']
    assert tree(release.RELEASE / 'candidate') == info['candidateTree']
    return info


def build():
    info = checked()
    current(info)
    release.docker('tag', info['app']['imageId'], release.ROLLBACK)
    assert release.docker('image', 'inspect', '--format', '{{.Id}}', release.ROLLBACK).decode().strip() == info['app']['imageId']
    context = release.RELEASE / 'image-context'
    try:
        for name in release.FILES:
            target = context / 'payload' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(release.RELEASE / 'candidate' / name, target)
        (context / 'Dockerfile').write_text('FROM ' + release.ROLLBACK + '\nCOPY --chown=node:node payload/ /app/\n')
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network=none', '--pull=false',
            '-t', release.IMAGE, str(context)], check=True)
    finally:
        shutil.rmtree(context, ignore_errors=True)
    info['imageId'] = release.docker('image', 'inspect', '--format', '{{.Id}}', release.IMAGE).decode().strip()
    for name, tag in [('compose.release.yml', release.IMAGE), ('compose.rollback.yml', release.ROLLBACK)]:
        (release.RELEASE / name).write_text('services:\n  app:\n    image: ' + tag + '\n    pull_policy: never\n')
    release.save('manifest.json', info)
    print(json.dumps({'built': True, 'imageId': info['imageId']}), flush=True)


def image_check():
    if not os.environ.get('MBBS_TEST_ARTIFACT_DIR'):
        subprocess.run(['python3', str(SERVER.parent / 'docker/retention/retention.py'), 'run', '--',
            sys.executable, __file__, 'image-check'], check=True)
        return
    info = checked()
    current(info)
    name = 'mbbs-driver-inactivation-image-check-' + str(os.getpid())
    options = ['run', '--rm', '--name', name, '--init', '--network=none', '--read-only',
        '--cgroup-parent=mbbs-tests.slice', '--memory=512m', '--memory-swap=512m', '--cpus=0.5',
        '--pids-limit=64', '--tmpfs', '/tmp:rw,size=64m', '--label', 'com.mbbs.lifecycle=disposable-test',
        '-e', 'NODE_ENV=test', '-e', 'MBBS_ENV_FILE=/tmp/absent.env', '--entrypoint', 'node', info['imageId']]
    try:
        assert json.loads(release.docker(*options, '-e', HASH_SCRIPT)) == info['candidateTree']
        release.docker(*options, '--input-type=module', '-e', "await import('./src/server.js');process.exit(0)")
    finally:
        subprocess.run(['sudo', '-n', 'docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for args in [('ps',), ('ps', '-a')]:
            print(release.docker(*args, '--format', '{{.Names}} {{.Status}}').decode().strip())
        assert not release.docker('ps', '-aq', '--filter', 'name=^/' + name + '$').strip()
    release.save('image-check.json', {'passed': True, 'imageId': info['imageId'], 'runtimeTreeVerified': True, 'serverImport': True})
    print(json.dumps({'imageCheck': 'passed', 'runtimeFiles': len(info['candidateTree'])}), flush=True)


def verify():
    info = checked()
    release.core.ready(info['imageId'])
    assert release.core.metadata(release.APP)['configuration'] == info['app']['configuration']
    assert [release.core.metadata(name) for name in release.DEPENDENCIES] == info['dependencies']
    assert json.loads(release.docker('exec', release.APP, 'node', '-e', HASH_SCRIPT)) == info['candidateTree']
    script = """import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const results=[];
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
 const response=await fetch(base+'/health');assert.equal(response.status,200);assert.equal((await response.json()).ok,true);
 const asset=await fetch(base+'/dispatch-setup.js?v=driver-inactivation-20261029');assert.equal(asset.status,200);
 assert.equal(createHash('sha256').update(Buffer.from(await asset.arrayBuffer())).digest('hex'),EXPECTED);
 for(const path of ['/api/dispatch/setup?includeInactive=true','/api/driver/me']) {
   assert.equal((await fetch(base+path)).status,401);
 }
 results.push({origin:base,health:200,setupAsset:'verified',anonymousAccess:401});
}
console.log(JSON.stringify(results));"""
    checks = json.loads(release.docker('exec', '-i', release.APP, 'node', '--input-type=module',
        input=script.replace('EXPECTED', json.dumps(info['files']['public/dispatch-setup.js'])).encode()))
    result = {'deployed': True, 'imageId': info['imageId'], 'image': release.IMAGE,
        'configurationPreserved': True, 'dependenciesUnchanged': True, 'schemaChanged': False,
        'runtimeFilesVerified': len(info['candidateTree']), 'http': checks, 'rollbackImage': release.ROLLBACK}
    release.save('deployment-result.json', result)
    print(json.dumps(result), flush=True)


def apply():
    info = checked()
    current(info)
    evidence = json.loads((release.RELEASE / 'image-check.json').read_text())
    assert evidence['passed'] and evidence['imageId'] == info['imageId']
    assert release.docker('image', 'inspect', '--format', '{{.Id}}', release.IMAGE).decode().strip() == info['imageId']
    config = json.loads(subprocess.check_output(release.compose(info) + ['config', '--format', 'json'], cwd=SERVER.parent))['services']['app']
    image = json.loads(release.docker('image', 'inspect', info['imageId']))[0]['Config']
    live = json.loads(release.docker('inspect', release.APP))[0]['Config']
    environment = dict(entry.split('=', 1) for entry in image['Env'])
    environment.update({key: str(value) for key, value in config.get('environment', {}).items()})
    assert environment == dict(entry.split('=', 1) for entry in live['Env']), 'Environment drift'
    for field, key in [('Cmd', 'command'), ('Entrypoint', 'entrypoint'), ('User', 'user'), ('WorkingDir', 'working_dir')]:
        assert (image.get(field) if config.get(key) is None else config[key]) == live.get(field), 'Command drift'
    active = release.docker('exec', release.DEPENDENCIES[0], 'psql', '-U', 'mbbs_app', '-d', 'mbbs_yard',
        '-XAt', '-v', 'ON_ERROR_STOP=1', '-c',
        "SELECT (SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing')) + (SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing');").decode().strip()
    assert active == '0', 'Active operational writes; retry cutover when idle'
    current(info)
    command = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
    try:
        with (release.RELEASE / 'publish.log').open('wb') as output:
            subprocess.run(release.compose(info) + command, cwd=SERVER.parent, check=True,
                stdout=output, stderr=subprocess.STDOUT, timeout=60)
        verify()
    except BaseException:
        # A separate authorized release must never be overwritten by our rollback.
        actual = release.core.metadata(release.APP)
        if actual['imageId'] == info['imageId']:
            with (release.RELEASE / 'rollback.log').open('wb') as output:
                subprocess.run(release.compose(info, 'compose.rollback.yml') + command,
                    cwd=SERVER.parent, check=True, stdout=output, stderr=subprocess.STDOUT, timeout=60)
            release.core.ready(info['app']['imageId'])
            release.save('rollback-result.json', {'restoredImage': info['app']['imageId'], 'healthy': True})
        raise


release.verify = verify
if __name__ == '__main__':
    os.umask(0o077)
    signal.signal(signal.SIGTERM, lambda number, _frame: sys.exit(128 + number))
    {'prepare': prepare, 'validate': validate, 'build': build, 'image-check': image_check,
     'apply': apply, 'verify': verify}[sys.argv[1]]()

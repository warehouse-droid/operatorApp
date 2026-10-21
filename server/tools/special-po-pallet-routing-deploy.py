"""Publish the verified PALLET/routing patch over the captured running app."""
import datetime
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

SERVER = Path(__file__).resolve().parents[1]
OUT = SERVER / 'test-artifacts/special-po-pallet-routing'
RELEASE = SERVER / 'deployments/special-po-pallet-routing-20260930'
APP = 'mbbs-operator-app-app-1'
DEPS = ['mbbs-operator-app-db-1', 'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-ollama-1']
IMAGE = 'mbbs-operator-app:special-po-pallet-routing-20260930'
FILES = json.loads((SERVER / 'tools/special-po-pallet-routing-files.json').read_text())
MIGRATION = '246_special_po_pallet.sql'
spec = importlib.util.spec_from_file_location('scoped_release', SERVER / 'tools/regular-stock-v2-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE, core.CONTAINERS = RELEASE, {'app': APP}
docker, digest, metadata = core.docker, core.digest, core.metadata
HASH = """const fs=require('fs'),crypto=require('crypto'),hashes={};function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=dir+'/'+e.name;if(e.isDirectory())walk(p);else if(e.isFile())hashes[p]=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}}for(const d of ['src','public','migrations'])walk(d);console.log(JSON.stringify(hashes));"""


def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + '\n')


def state():
    return json.loads((RELEASE / 'manifest.json').read_text())


def current(data):
    assert metadata(APP) == data['services']['app']['before'], 'Running app changed; recapture before release'
    assert {name: metadata(name) for name in DEPS} == data['dependencies'], 'A dependency changed'
    assert {file: digest((SERVER / file).read_bytes()) for file in FILES} == data['workspaceHashes'], 'Tested workspace changed'
    assert {file: digest((RELEASE / 'candidate' / file).read_bytes()) for file in FILES} == data['sourceHashes']


def capture():
    os.umask(0o077)
    RELEASE.mkdir(exist_ok=False)
    before = metadata(APP)
    data = {'services': {'app': {'before': before, 'image': IMAGE}},
            'dependencies': {name: metadata(name) for name in DEPS},
            'workspaceHashes': {file: digest((SERVER / file).read_bytes()) for file in FILES}}
    baseline = RELEASE / 'before'
    baseline.mkdir()
    for name in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']:
        with tarfile.open(fileobj=io.BytesIO(docker('cp', APP + ':/app/' + name, '-'))) as archive:
            archive.extractall(baseline, filter='data')
    candidate = RELEASE / 'candidate'
    shutil.copytree(baseline, candidate)
    patch = []
    for file in FILES:
        old = OUT / 'before' / file
        original = old.read_text() if old.exists() else ''
        updated = (SERVER / file).read_text()
        if file == 'public/scm-stock-requests.html':
            import re
            original = (baseline / file).read_text()
            updated, count = re.subn(r'/scm-special-stock-requests\.js\?v=[^"\s]+',
                                    '/scm-special-stock-requests.js?v=20260930-pallet-routing-v1', original)
            assert count == 1
            updated = updated.replace('  </head>', '    <link rel="stylesheet" href="/special-stock-po-routing.css?v=20260930-pallet-routing-v1" />\n  </head>')
        patch.extend(difflib.unified_diff(original.splitlines(True), updated.splitlines(True),
                                        fromfile='a/' + file if old.exists() else '/dev/null', tofile='b/' + file))
    patch = ''.join(patch)
    (RELEASE / 'release.patch').write_text(patch)
    result = subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-d', str(candidate)],
                            input=patch, text=True, capture_output=True)
    (RELEASE / 'patch.log').write_text(result.stdout + result.stderr)
    assert result.returncode == 0, 'Review the scoped patch before release'
    for file in candidate.rglob('*.orig'):
        file.unlink()
    old, new = core.files_at(baseline), core.files_at(candidate)
    changed = sorted(file for file in new if old.get(file) != new[file])
    assert changed == sorted(FILES), changed
    data['sourceHashes'] = {file: new[file] for file in FILES}
    save('source-tree.json', new)
    save('manifest.json', data)
    current(data)
    print(json.dumps({'captured': True, 'changedFiles': changed}), flush=True)


def candidate_tests(data):
    spec = importlib.util.spec_from_file_location('feature_runner', SERVER / 'tools/special-po-pallet-routing-run.py')
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    runner.REMOTE = '/tmp/special-po-pallet-routing-release'
    root = RELEASE / 'candidate'
    for folder in ['test', 'tools']:
        shutil.copytree(SERVER / folder, root / folder, dirs_exist_ok=True)
    shutil.copy2(SERVER / 'netsuite-smart-scm-picking-ticket-restlet.js', root)
    docker('exec', runner.RUNNER, 'node', '-e', "const fs=require('fs'),p=process.argv[1];fs.rmSync(p,{recursive:true,force:true});fs.mkdirSync(p)", runner.REMOTE)
    docker('cp', str(root) + '/.', runner.RUNNER + ':' + runner.REMOTE)
    docker('exec', runner.RUNNER, 'node', '-e', "require('fs').symlinkSync('/app/node_modules',process.argv[1]+'/node_modules','dir')", runner.REMOTE)
    suites = ['test/mbt/unit/special-po-line-discount.test.js', 'test/mbt/unit/special-workflow-review.test.js',
              'test/mbt/integration/special-workflow-review.test.js', 'test/mbt/integration/special-batch-browser.test.js',
              'test/mbt/integration/special-standalone-po.test.js', 'test/mbt/unit/special-po-pallet.test.js',
              'test/mbt/unit/special-po-routing.test.js', 'test/mbt/integration/special-po-pallet.test.js',
              'test/mbt/integration/special-po-routing-browser.test.js']
    status = runner.run('candidate-tests', ['node', '--test', '--test-concurrency=1', *suites])
    import re
    log = (OUT / 'candidate-tests.log').read_text()
    failures = re.findall(r'^not ok \d+ - (.+)$', log, re.M)
    allowed = json.loads((OUT / 'checks.json').read_text())['baselineFailures']
    assert status == 0 or status == 1 and failures
    assert not [name for name in failures if name not in allowed]
    assert not any(name.startswith('/') for name in failures)
    assert 'ERR_MODULE_NOT_FOUND' not in log and 'hookFailed' not in log
    result = {key: int(re.search(r'^# ' + key + r' (\d+)$', log, re.M).group(1)) for key in ['tests', 'pass', 'fail']}
    result.update(newFailures=[], failures=failures)
    save('candidate-checks.json', result)
    print(json.dumps(result), flush=True)


def prepare():
    data = state()
    checks = json.loads((OUT / 'checks.json').read_text())
    assert checks['completed'] and not checks['newFailures'] and checks['mutantsKilled'] == 6
    assert checks['sourceHashes'] == data['workspaceHashes']
    coverage = json.loads((OUT / 'changed-lines.json').read_text())
    assert not coverage['uncovered'], 'Changed lines need coverage'
    current(data)
    candidate_tests(data)
    stage = RELEASE / 'stage'
    for file in FILES:
        target = stage / 'overlay' / file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(RELEASE / 'candidate' / file, target)
    before = data['services']['app']['before']
    assert docker('image', 'inspect', '--format', '{{.Id}}', before['image']).decode().strip() == before['imageId']
    (stage / 'Dockerfile').write_text('FROM ' + before['image'] + '\nCOPY --chown=node:node overlay/ /app/\n')
    with (RELEASE / 'build.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', IMAGE, str(stage)], stdout=log, stderr=subprocess.STDOUT, check=True)
    data['services']['app']['candidateImageId'] = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    assert json.loads(docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', IMAGE, '-e', HASH)) == json.loads((RELEASE / 'source-tree.json').read_text())
    docker('run', '--rm', '--network', 'none', '-e', 'MBBS_ENV_FILE=/nonexistent', '-e', 'NETSUITE_DIRECT_ACCESS_ENABLED=false',
           '-e', 'NETSUITE_MIRROR_ROLE=disabled', '--entrypoint', 'node', IMAGE, '--input-type=module', '-e', "await import('./src/server.js');process.exit(0)")
    (RELEASE / 'compose.release.yml').write_text('services:\n  app:\n    image: ' + IMAGE + '\n')
    (RELEASE / 'compose.rollback.yml').write_text('services:\n  app:\n    image: ' + before['imageId'] + '\n')
    core.config_check(data)
    current(data)
    save('manifest.json', data)
    print(json.dumps({'prepared': True, 'sourceFiles': len(FILES)}), flush=True)


def database(sql):
    return docker('exec', '-i', DEPS[0], 'psql', '-U', 'mbbs_app', '-d', 'mbbs_yard', '-XAt', '-v', 'ON_ERROR_STOP=1', input=sql.encode()).decode().strip()


def migrate():
    if database("SELECT count(*) FROM schema_migrations WHERE filename='" + MIGRATION + "';") == '1':
        return
    original = database("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='sales_special_stock_order_line_case_check';")
    save('constraint-before.json', {'definition': original})
    sql = (RELEASE / 'candidate/migrations' / MIGRATION).read_text()
    database("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';\n" + sql +
             "\nINSERT INTO schema_migrations(filename) VALUES('" + MIGRATION + "'); COMMIT;")
    save('migration-result.json', {'applied': MIGRATION, 'transactional': True})


def verify():
    data = state()
    core.core.ready(data['services']['app']['candidateImageId'])
    actual = metadata(APP)
    assert actual['imageId'] == data['services']['app']['candidateImageId']
    assert actual['configuration'] == data['services']['app']['before']['configuration']
    assert {name: metadata(name) for name in DEPS} == data['dependencies']
    assert json.loads(docker('exec', APP, 'node', '-e', HASH)) == json.loads((RELEASE / 'source-tree.json').read_text())
    assert database("SELECT count(*) FROM schema_migrations WHERE filename='" + MIGRATION + "';") == '1'
    script = r"""import assert from 'node:assert/strict';import crypto from 'node:crypto';
const hashes=HASHES;for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
 const health=await fetch(base+'/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
 for(const [file,hash] of Object.entries(hashes)){if(!file.startsWith('public/'))continue;
 const path=file.endsWith('.html')?'/scm/stock-requests':'/'+file.slice(7);
 const response=await fetch(base+path,{headers:{'Cache-Control':'no-cache','User-Agent':'Mozilla/5.0'}});assert.equal(response.status,200,path);
 const body=(await response.text()).replace(/<script type="module" src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js\/[^>]+><\/script>\n/g,'');
 assert.equal(crypto.createHash('sha256').update(body).digest('hex'),hash,path);}}
console.log(JSON.stringify({health:true,publicAssets:true}));"""
    live = json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', input=script.replace('HASHES', json.dumps(data['sourceHashes'])).encode()))
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'image': IMAGE,
              'configurationPreserved': True, 'workerAndDependenciesUnchanged': True, 'migration': MIGRATION, **live}
    save('result.json', result)
    print(json.dumps(result), flush=True)


def apply():
    data = state()
    current(data)
    core.config_check(data)
    active = json.loads(database("""SELECT json_build_object(
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'quantityApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying'),
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
      'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'),
      'webhookRunning',(SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status='running'))"""))
    save('active-before-release.json', active)
    assert not any(active.values()), 'Wait for active work: ' + json.dumps(active)
    migrate()
    try:
        with (RELEASE / 'publish.log').open('wb') as log:
            subprocess.run(core.compose(data) + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'], cwd=SERVER.parent, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(core.compose(data, 'compose.rollback.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'], cwd=SERVER.parent, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        core.core.ready(data['services']['app']['before']['imageId'])
        save('rollback-result.json', {'rolledBack': True, 'additiveConstraintRetained': True})
        raise


def repair(apply=False):
    code = (SERVER / 'tools/special-po-pallet-routing-repair-000017.mjs').read_text().replace("from '../src/", "from './src/")
    result = json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', '-', *(['--apply'] if apply else []), input=code.encode()))
    save('repair-after.json' if apply else 'repair-before.json', result)
    print(json.dumps(result), flush=True)


def live_check():
    code = (SERVER / 'tools/special-po-pallet-routing-live.mjs').read_text().replace("from '../src/", "from './src/").replace("from '../public/", "from './public/")
    result = json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', '-', input=code.encode()))
    save('live-request-check.json', result)
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    {'capture': capture, 'prepare': prepare, 'apply': apply, 'verify': verify,
     'repair-inspect': repair, 'repair': lambda: repair(True), 'live-check': live_check}[sys.argv[1]]()

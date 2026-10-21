"""Release the verified direct Credit Memo gates over the captured live image."""
import atexit
import difflib
import importlib.util
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
import threading
import time
import urllib.request

SERVER = Path(__file__).resolve().parents[2]
TASK = SERVER / 'tools/return-credit-memo-20261008'
ARTIFACTS = SERVER / 'test-artifacts/return-credit-memo-20261008'
RELEASE = SERVER / 'deployments/return-credit-memo-20261008'
spec = importlib.util.spec_from_file_location('release_helpers', SERVER / 'tools/delivery-scm-release.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
r.RELEASE = RELEASE
r.IMAGE = 'mbbs-operator-app:return-credit-memo-20261008'
r.ROLLBACK = r.IMAGE + '-rollback'
r.READ_NAME = 'mbbs-return-credit-memo-release-reader'
r.CHECK_NAME = 'mbbs-return-credit-memo-release-check'
FILES = json.loads((TASK / 'files.json').read_text())
MIGRATION = '273_operator_return_credit_memo_gates.sql'
GATES = ['operator_netsuite_' + kind + '_return_cm_' + yard
         for kind in ['stock', 'pallet'] for yard in ['3445', '2967', '12441', '150']]


def cleanup():
    for name in [r.READ_NAME, r.CHECK_NAME]:
        ids = r.docker('ps', '-a', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}').decode().split()
        for container in ids:
            label = r.docker('inspect', container, '--format', '{{index .Config.Labels "com.mbbs.lifecycle"}}').decode().strip()
            assert label == 'disposable-test'
            r.docker('rm', '--force', '--volumes', container)
    for args, filename in [(['ps'], 'docker-ps.log'), (['ps', '-a'], 'docker-ps-a.log')]:
        (RELEASE / filename).write_bytes(r.docker(*args, '--format', '{{.Names}} {{.Status}}'))


r.cleanup_manual = cleanup


def replace(path, old, new):
    text = path.read_text()
    assert text.count(old) == 1, 'Live insertion point changed: ' + str(path)
    path.write_text(text.replace(old, new, 1))


def function(text, name):
    start = re.search(r'(?m)^function ' + name + r'\(', text).start()
    following = re.search(r'\n(?:async )?function ', text[start + 1:])
    return text[start:start + 1 + following.start() + 1] if following else text[start:]


def capture():
    RELEASE.mkdir(exist_ok=False)
    app = r.metadata(r.APP)
    dependencies = [r.metadata(name) for name in r.DEPENDENCIES]
    before = RELEASE / 'before'
    before.mkdir()
    archive = r.docker('exec', r.APP, 'tar', '-cf', '-', '-C', '/app',
                       'src', 'public', 'migrations', 'package.json', 'package-lock.json')
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(before, filter='data')
    assert r.metadata(r.APP) == app
    r.save('capture.json', {'capturedAt': r.now(), 'app': app, 'dependencies': dependencies})
    print(json.dumps({'captured': True, 'image': app['imageId']}), flush=True)


def prepare():
    capture = json.loads((RELEASE / 'capture.json').read_text())
    assert r.metadata(r.APP) == capture['app']
    assert [r.metadata(name) for name in r.DEPENDENCIES] == capture['dependencies']
    source = json.loads((ARTIFACTS / 'source-state.json').read_text())['sources']
    assert all(r.sha((SERVER / name).read_bytes()) == value for name, value in source.items())
    baseline = ARTIFACTS / 'baseline'
    before = RELEASE / 'before'
    candidate = RELEASE / 'candidate'
    shutil.copytree(before, candidate)
    shared = ['src/server.js', 'public/operator.js', 'src/mbt/feature-gate-catalog.js']
    for name in FILES:
        if name in shared:
            continue
        if (baseline / name).exists():
            assert (before / name).read_bytes() == (baseline / name).read_bytes(), 'Live source changed: ' + name
        else:
            assert not (before / name).exists(), 'New file already live: ' + name
        shutil.copy2(SERVER / name, candidate / name)
    for name, names in {'src/server.js': ['operatorSafeReturnPayload'],
                         'public/operator.js': ['returnNetSuiteResultLabel', 'renderReturnSuccess', 'renderReturnPostingPolicies']}.items():
        for entry in names:
            replace(candidate / name, function((baseline / name).read_text(), entry), function((SERVER / name).read_text(), entry))
    name = 'src/mbt/feature-gate-catalog.js'
    replace(candidate / name, '  OPERATOR_NETSUITE_RETURN_GATE_DEFINITIONS,',
            '  OPERATOR_NETSUITE_RETURN_GATE_DEFINITIONS,\n  OPERATOR_NETSUITE_RETURN_CREDIT_MEMO_GATE_DEFINITIONS,')
    replace(candidate / name, '...[...OPERATOR_NETSUITE_GATE_DEFINITIONS, ...OPERATOR_NETSUITE_RETURN_GATE_DEFINITIONS].map',
            '...[...OPERATOR_NETSUITE_GATE_DEFINITIONS, ...OPERATOR_NETSUITE_RETURN_GATE_DEFINITIONS,\n    ...OPERATOR_NETSUITE_RETURN_CREDIT_MEMO_GATE_DEFINITIONS].map')
    assert all((candidate / name).read_bytes() == (SERVER / name).read_bytes() for name in FILES if name != 'src/server.js')
    server_text = (SERVER / 'src/server.js').read_text().replace(
        '// Account preferences and phone layout policy are independent of the selected yard.',
        '// Account preferences are independent of the currently selected yard.')
    assert (candidate / 'src/server.js').read_text() == server_text
    before_tree, after_tree = r.files_at(before), r.files_at(candidate)
    changed = sorted(name for name in before_tree.keys() | after_tree.keys() if before_tree.get(name) != after_tree.get(name))
    assert changed == sorted(FILES)
    patch = ''.join(''.join(difflib.unified_diff(
        (before / name).read_text().splitlines(True) if (before / name).exists() else [],
        (candidate / name).read_text().splitlines(True), fromfile='a/' + name, tofile='b/' + name)) for name in changed)
    (RELEASE / 'release.patch').write_text(patch)
    data = {**capture, 'files': changed, 'beforeTree': before_tree, 'candidateTree': after_tree,
        'candidateTreeHash': r.sha(json.dumps(after_tree, sort_keys=True).encode()), 'workspace': source,
        'packages': {name: r.sha((candidate / name).read_bytes()) for name in ['package.json', 'package-lock.json']}}
    r.save('manifest.json', data)
    r.current(data)
    print(json.dumps({'prepared': True, 'changedFiles': len(changed), 'existingPhoneReleasePreserved': True}), flush=True)


def validate():
    data = r.state()
    r.current(data)
    env = {**os.environ, 'RETURN_CM_RUNTIME_ROOT': str(RELEASE / 'candidate'),
           'RETURN_CM_ARTIFACT_ROOT': str(RELEASE / 'test-artifacts')}
    subprocess.run([sys.executable, str(TASK / 'run.py'), 'deployment', 'node',
                    'tools/return-credit-memo-20261008/release-check.mjs'], env=env, check=True)
    result = json.loads((RELEASE / 'test-artifacts/return-credit-memo-20261008/deployment-checks.json').read_text())
    assert result['passed']
    r.current(data)
    r.save('validation-passed.json', {**result, 'candidateTreeHash': data['candidateTreeHash'], 'at': r.now()})
    print(json.dumps({'candidateValidated': True, 'regressionTests': result['regression']['pass'],
                      'compatibilityTests': result['compatibility']['pass']}), flush=True)


def gates():
    return json.loads(r.sql("BEGIN READ ONLY; SET LOCAL statement_timeout='5s'; SELECT json_build_object(" +
        "'flags',(SELECT coalesce(json_agg(row_to_json(f) ORDER BY flag_key),'[]'::json) FROM mbt_feature_flags f)," +
        "'migration',(SELECT count(*) FROM schema_migrations WHERE filename='" + MIGRATION + "')); COMMIT;"))


def migrate():
    before = gates()
    r.save('gates.before.json', before)
    assert all(not row['enabled'] for row in before['flags'] if row['flag_key'] in GATES)
    r.sql("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'; " +
        (RELEASE / 'candidate/migrations' / MIGRATION).read_text() +
        "\nINSERT INTO schema_migrations(filename) VALUES ('" + MIGRATION + "') ON CONFLICT DO NOTHING; COMMIT;")
    after = gates()
    new = [row for row in after['flags'] if row['flag_key'] in GATES]
    assert len(new) == 8 and all(row['enabled'] is False for row in new) and after['migration'] == 1
    assert [row for row in before['flags'] if row['flag_key'] not in GATES] == [row for row in after['flags'] if row['flag_key'] not in GATES]
    r.save('gates.after.json', after)


def preflight():
    # Counts only. Business rows and credentials never leave the production DB.
    statement = """BEGIN READ ONLY; SET LOCAL statement_timeout='5s'; SELECT json_build_object(
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'quantityApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying'),
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
      'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'),
      'stockingExecuting',(SELECT count(*) FROM sales_stock_requests WHERE regular_details->'pickupTransfer'->>'status'='executing'),
      'deliveryExecuting',(SELECT count(*) FROM regular_stock_delivery_operations WHERE status IN ('queued','running')),
      'scmExecuting',(SELECT count(*) FROM scm_smart_proposals WHERE status='executing'),
      'webhooks',(SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status='running' AND lease_expires_at>now()),
      'returnTransactions',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND xact_start IS NOT NULL AND query ILIKE '%return_%'),
      'openTransactions',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='idle in transaction'));
      COMMIT;"""
    counts = json.loads(r.sql(statement))
    r.save('preflight.json', {'at': r.now(), **counts})
    assert not any(counts.values()), 'Business operations active; retry after they finish: ' + json.dumps(counts)


def verify():
    data = r.state()
    r.ready(data['candidateImageId'])
    live = r.metadata(r.APP)
    assert live['imageId'] == data['candidateImageId']
    assert live['configuration'] == data['app']['configuration']
    assert [r.metadata(name) for name in r.DEPENDENCIES] == data['dependencies']
    assert json.loads(r.docker('exec', r.APP, 'node', '-e', r.HASH_SCRIPT)) == data['candidateTree']
    public = {name: data['candidateTree'][name] for name in FILES if name.startswith('public/')}
    http = r.http_check(public, ['/api/operator/netsuite-posting-policy', '/api/operator/phone-layout-policy'])
    gate_state = gates()
    assert gate_state['migration'] == 1
    assert gate_state['flags'] == json.loads((RELEASE / 'gates.after.json').read_text())['flags']
    script = """import assert from 'node:assert/strict';
import {getOperatorNetSuitePostingPolicy} from './src/operator-netsuite-posting-policy-repository.js';
import {MBT_ADMIN_GATE_DEFINITIONS} from './src/mbt/feature-gate-catalog.js';
import {closeDb} from './src/db.js';
try {const policies=[];for(const locationId of [3445,2967,12441,150])for(const functionKey of ['stock_return','pallet_return']) {
const p=await getOperatorNetSuitePostingPolicy({locationId,functionKey});assert.equal(p.transactionType,'RA');
policies.push({locationId,functionKey,transactionType:p.transactionType,effective:p.effective});}
assert.equal(MBT_ADMIN_GATE_DEFINITIONS.filter(g=>g.flagKey.includes('_return_cm_')).length,8);
console.log(JSON.stringify({policies,creditMemoGates:8}));}finally{await closeDb();}"""
    policy = json.loads(r.docker('exec', '-i', r.APP, 'node', '--input-type=module', input=script.encode()))
    r.save('deployment-result.json', {'deployed': True, 'at': r.now(), 'image': r.IMAGE, 'imageId': live['imageId'],
        'candidateTreeHash': data['candidateTreeHash'], 'changedFiles': FILES, 'configurationPreserved': True,
        'workerAndDependenciesUnchanged': True, 'existingGatesPreserved': True, 'creditMemoGatesEnabled': False,
        'http': http, 'policy': policy})
    print(json.dumps({'deployed': True, 'productionHealthy': True, 'creditMemoGatesEnabled': False, 'http': http}), flush=True)


def apply():
    data = r.state()
    r.current(data)
    check = json.loads((RELEASE / 'image-check.json').read_text())
    assert check['passed'] and check['imageId'] == data['candidateImageId']
    assert r.docker('image', 'inspect', '--format', '{{.Id}}', r.IMAGE).decode().strip() == data['candidateImageId']
    r.config_check(data)
    preflight()
    migrate()
    r.current(data)
    preflight()
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
            subprocess.run(r.compose(data, 'release') + args, cwd=SERVER.parent, stdout=output,
                           stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except BaseException:
        with (RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(r.compose(data, 'rollback') + args, cwd=SERVER.parent, stdout=output,
                           stderr=subprocess.STDOUT, check=True, timeout=60)
        r.ready(data['app']['imageId'])
        r.save('rollback-result.json', {'restoredImageId': data['app']['imageId'], 'creditMemoGatesEnabled': False})
        raise
    finally:
        stop.set()
        thread.join(timeout=2)
        r.save('cutover.json', {'seconds': round(time.monotonic() - start, 3), 'samples': samples})
        cleanup()


if __name__ == '__main__':
    os.umask(0o077)
    def interrupted(_signal, _frame):
        raise KeyboardInterrupt('Interrupted; cleanup and rollback remain active')
    signal.signal(signal.SIGTERM, interrupted)
    if sys.argv[1] == 'build':
        atexit.register(cleanup)
    {'capture': capture, 'prepare': prepare, 'validate': validate, 'build': r.build,
     'apply': apply, 'verify': verify}[sys.argv[1]]()

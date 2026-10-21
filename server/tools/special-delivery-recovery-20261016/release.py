"""Publish the verified delivery recovery and closure fixes with app-only image rollback."""
import importlib.util
import json
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('delivery_recovery_checks', HERE / 'run.py')
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)
core = checks.core
core.RELEASE = checks.RELEASE
RELEASE = checks.RELEASE
IMAGE = 'mbbs-operator-app:special-delivery-recovery-20261016'
CHECK_NAME = 'mbbs-special-delivery-recovery-image-check'


def save(name, value):
    checks.save(RELEASE / name, value)


def current(data):
    assert core.metadata(core.APP) == data['app'], 'Live app changed; recapture and reverify'
    assert [core.metadata(n) for n in core.DEPENDENCIES] == data['dependencies']
    assert json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)) == data['beforeTree']
    assert core.files_at(RELEASE / 'candidate') == data['candidateTree']


def evidence(data):
    final = checks.OUT / 'final'
    result = json.loads((final / 'verified.json').read_text())
    assert result['passed'] and result['sourceHashes'] == data['sourceHashes']
    assert all(core.sha((checks.SERVER / n).read_bytes()) == value for n, value in result['testHashes'].items())
    cleanup = json.loads((final / 'cleanup.json').read_text())
    assert not any(cleanup[key] for key in ['containers', 'networks', 'volumes'])
    assert cleanup['productionHealth'] == 'healthy'
    assert not json.loads((final / 'changed-coverage.json').read_text())['uncovered']
    mutants = json.loads((final / 'mutations.json').read_text())
    assert len(mutants) == 6 and all(m['killed'] and m['propertyKilled'] for m in mutants)
    assert all(core.sha((checks.SERVER / n).read_bytes()) == value for n, value in data['workspaceHashes'].items())


def cleanup():
    subprocess.run(['docker', 'rm', '-fv', CHECK_NAME], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    (RELEASE / 'docker-ps.log').write_bytes(core.docker('ps', '--format', '{{.Names}} {{.Status}}'))
    (RELEASE / 'docker-ps-a.log').write_bytes(core.docker('ps', '-a', '--format', '{{.Names}} {{.Status}}'))
    assert not core.docker('ps', '-a', '--filter', 'label=com.mbbs.lifecycle=disposable-test', '--format', '{{.Names}}').strip()


def prepare():
    data = core.state()
    evidence(data)
    current(data)
    stage = RELEASE / 'image'
    for name in checks.FILES:
        destination = stage / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(RELEASE / 'candidate' / name, destination)
    rollback = IMAGE + '-rollback'
    core.docker('tag', data['app']['imageId'], rollback)
    (stage / 'Dockerfile').write_text('FROM ' + rollback + '\n' + ''.join(
        'COPY --chown=node:node ' + name + ' /app/' + name + '\n' for name in checks.FILES))
    (RELEASE / 'compose.release.yml').write_text('services:\n  app:\n    image: ' + IMAGE + '\n')
    (RELEASE / 'compose.rollback.yml').write_text('services:\n  app:\n    image: ' + data['app']['imageId'] + '\n')
    with (RELEASE / 'build.log').open('wb') as log:
        subprocess.run(['docker', 'build', '--pull=false', '--network=none', '-t', IMAGE, str(stage)],
            stdout=log, stderr=subprocess.STDOUT, check=True, timeout=120)
    data['candidateImageId'] = core.docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    save('manifest.json', data)
    try:
        actual = json.loads(core.bounded(data['candidateImageId'], CHECK_NAME, 'node', '-e', core.HASH_SCRIPT))
        assert actual == data['candidateTree'], 'Unexpected image content changes'
        core.bounded(data['candidateImageId'], CHECK_NAME, 'node', '--input-type=module', '-e',
            "import assert from 'node:assert/strict';import {specialFulfillmentBlocksAdjustment as blocks} from './src/special-stock-local-adjustments.js';"
            "assert.equal(blocks({status:'attention'},{localOnly:true}),false);assert.equal(blocks({status:'attention',plan:{}},{localOnly:true}),true);")
    finally:
        cleanup()
    core.config_check(data)
    configs = [json.loads(subprocess.check_output(core.compose(data, mode) + ['config', '--format', 'json'], cwd=checks.ROOT))
        for mode in ['release', 'rollback']]
    for config in configs:
        config['services']['app'].pop('image')
    assert configs[0] == configs[1], 'Runtime configuration would change'
    current(data)
    save('image-check.json', {'passed': True, 'imageId': data['candidateImageId'], 'runtimeFiles': len(actual)})
    print(json.dumps({'prepared': True, 'files': checks.FILES, 'runtimeFilesVerified': len(actual)}), flush=True)


def read_request():
    script = """import {query,closeDb} from './src/db.js';
import {specialFulfillmentBlocksAdjustment as blocks} from './src/special-stock-local-adjustments.js';
try {
 const result=await query(`SELECT r.id,r.request_ref,r.revision,c.close_status,c.fulfillment_change,
 c.sales_order_ref,c.purchase_order_ref,c.quantity_review,
 (SELECT count(*)::int FROM sales_special_stock_lines l WHERE l.request_id=r.id AND l.removed_at IS NULL) AS lines
 FROM sales_stock_requests r JOIN sales_special_stock_cases c ON c.request_id=r.id WHERE r.request_ref=$1`,['SPREQ-000063']);
 const r=result.rows[0];
 console.log(JSON.stringify({requestRef:r.request_ref,revision:Number(r.revision),activeLines:r.lines,
 salesOrder:r.sales_order_ref,purchaseOrder:r.purchase_order_ref,deliveryStatus:r.fulfillment_change.status,
 savedDeliveryPlan:Boolean(r.fulfillment_change.plan),localAdjustmentBlockedByDelivery:blocks(r.fulfillment_change,{localOnly:true}),
 quantityReviewStatus:r.quantity_review.status||null}));
} finally {await closeDb();}"""
    return json.loads(core.docker('exec', '-i', core.APP, 'node', '--input-type=module', input=script.encode()))


def verify():
    data = core.state()
    core.ready(data['candidateImageId'])
    assert core.metadata(core.APP)['configuration'] == data['app']['configuration']
    assert [core.metadata(n) for n in core.DEPENDENCIES] == data['dependencies']
    assert json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)) == data['candidateTree']
    http = core.http_check({name:data['sourceHashes'][name] for name in checks.FILES if name.startswith('public/')}, ['/api/sales/special-stock-requests', '/api/scm/special-stock-requests'])
    request = read_request()
    cleanup()
    result = {'deployed': True, 'at': core.now(), 'imageId': data['candidateImageId'], 'files': checks.FILES,
        'runtimeFilesVerified': len(data['candidateTree']), 'configurationPreserved': True,
        'dependenciesUnchanged': True, 'schemaChanged': False, 'deploymentDataWrites': 0,
        'netSuiteDeploymentWrites': 0, 'authorizedRecoveryLog': 'recovery.log', 'http': http, 'request': request}
    save('deployment-result.json', result)
    checks.save(checks.OUT / 'deployment-result.json', result)
    print(json.dumps(result), flush=True)


def apply():
    data = core.state()
    evidence(data)
    current(data)
    assert json.loads((RELEASE / 'image-check.json').read_text())['imageId'] == data['candidateImageId']
    assert core.docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip() == data['candidateImageId']
    core.config_check(data)
    for attempt in range(20):
        try:
            active = core.preflight()
            active['specialAdjustments'] = int(core.sql("SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying' OR fulfillment_change->>'status'='applying' OR closure_review->>'status'='applying'"))
            core.assert_no_active_operations(active)
            break
        except AssertionError:
            if attempt == 19:
                raise
            time.sleep(2)
    current(data)
    args = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
    try:
        with (RELEASE / 'publish.log').open('wb') as log:
            subprocess.run(core.compose(data, 'release') + args, cwd=checks.ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except BaseException:
        with (RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(core.compose(data, 'rollback') + args, cwd=checks.ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        core.ready(data['app']['imageId'])
        save('rollback-result.json', {'previousImageRestored': True})
        raise


signal.signal(signal.SIGTERM, checks.base.interrupted)
signal.signal(signal.SIGINT, checks.base.interrupted)
if __name__ == '__main__':
    {'prepare': prepare, 'apply': apply, 'verify': verify}[sys.argv[1]]()

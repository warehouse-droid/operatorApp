"""Scoped overlays for app and worker, with environment hashes and rollback."""
import hashlib
import itertools
import json
from pathlib import Path
import subprocess
import sys
import time

SERVER = Path(__file__).resolve().parents[2]
OUT = SERVER / 'test-artifacts/special-so-link-sqft-20261006'
RELEASE = OUT / 'release'
APP = 'mbbs-operator-app-app-1'
WORKER = 'mbbs-operator-app-webhook-worker-1'
FILES = ['src/special-stock-request-repository.js', 'src/special-stock-pricing-domain.js',
         'public/sales-special-stock-requests.js']
SIGNATURE = 'async function reconcileCanonicalOrderLines(requestId, orderKind, remoteOrderId, { required = false, reviewedDescriptionChanges = [], quantityReview = {} } = {}) {\n'
GUARD = """  if (orderKind === 'sales_order' && !required) {
    const owner = await query('SELECT sales_order_source FROM sales_special_stock_cases WHERE request_id=$1', [requestId]);
    if (owner.rows[0]?.sales_order_source === 'manual_link') return false;
  }
"""
DELIVERY_SELECT = '    `SELECT sales_order_netsuite_id, fulfillment_method, delivery_address,\n'
DELIVERY_SELECTED = """    `SELECT sales_order_netsuite_id, sales_order_source,
            EXISTS (SELECT 1 FROM sales_special_stock_order_lines
                     WHERE request_id = $1 AND order_kind = 'sales_order') AS has_sales_order_draft,
            fulfillment_method, delivery_address,
"""
DELIVERY_CONDITION = '  if (special.fulfillment_method === "mbt_delivery") {\n'
DELIVERY_PRESERVED = """  if (special.fulfillment_method === "mbt_delivery"
      && (special.sales_order_source !== 'manual_link' || special.has_sales_order_draft)) {
"""

def docker(*args, **kwargs):
    return subprocess.check_output(['sudo', '-n', 'docker', *args], **kwargs)

def sha(value):
    return hashlib.sha256(value).hexdigest()

def metadata(name):
    info = json.loads(docker('inspect', name))[0]
    config = {key: value for key, value in info['Config'].items() if key not in ['Image', 'Labels', 'Hostname']}
    config['Env'] = sorted(config.get('Env', []))
    info['HostConfig']['Binds'] = sorted(info['HostConfig'].get('Binds') or [])
    return {'image': info['Image'], 'configurationHash': sha(json.dumps({'Config': config,
             'HostConfig': info['HostConfig']}, sort_keys=True).encode()),
            'compose': {key: value for key, value in info['Config']['Labels'].items() if key.startswith('com.docker.compose.')}}

def resume_bind_order():
    state = json.loads((RELEASE / 'manifest.json').read_text())
    (RELEASE / 'manifest-before-bind-normalization.json').write_text(json.dumps(state, indent=2))
    findings = {}
    for service, name in [('app', APP), ('webhook-worker', WORKER),
                          ('db', 'mbbs-operator-app-db-1'), ('ollama', 'mbbs-operator-app-ollama-1')]:
        info = json.loads(docker('inspect', name))[0]
        assert info['Image'] == state[service]['image'], 'Rollback did not restore the captured image'
        config = {key: value for key, value in info['Config'].items() if key not in ['Image', 'Labels', 'Hostname']}
        config['Env'] = sorted(config.get('Env', []))
        host = info['HostConfig']
        matches = 0
        for ordering in itertools.permutations(host.get('Binds') or []):
            host['Binds'] = list(ordering)
            if sha(json.dumps({'Config': config, 'HostConfig': host}, sort_keys=True).encode()) == state[service]['configurationHash']:
                matches += 1
        assert matches, 'Configuration difference extends beyond bind ordering: ' + service
        findings[service] = {'equivalentExceptBindOrder': True, 'matchingPermutations': matches}
        state[service] = metadata(name)
    (RELEASE / 'bind-order-equivalence.json').write_text(json.dumps(findings, indent=2))
    (RELEASE / 'manifest.json').write_text(json.dumps(state, indent=2))
    print(json.dumps(findings), flush=True)

def compose(state, filename):
    labels = state['app']['compose']
    args = ['sudo', '-n', 'docker', 'compose', '--project-name', labels['com.docker.compose.project'],
            '--project-directory', labels['com.docker.compose.project.working_dir']]
    environment_file = labels.get('com.docker.compose.project.environment_file')
    if environment_file:
        args += ['--env-file', environment_file]
    for filename_part in labels['com.docker.compose.project.config_files'].split(','):
        args += ['-f', filename_part]
    return args + ['-f', str(RELEASE / filename)]

def verify_evidence():
    evidence = json.loads((OUT / 'deployment-evidence.json').read_text())
    assert evidence['extendedValidationStoppedByUser'] and evidence['focused']['fail'] == 0
    assert evidence['focused']['pass'] == 23 and evidence['syntaxVerified']
    hashes = {file: sha((SERVER / file).read_bytes()) for file in FILES}
    assert hashes == evidence['sourceHashes'], 'Verified source changed'
    return hashes

def prepare():
    hashes = verify_evidence()
    RELEASE.mkdir(exist_ok=False)
    state = {'app': metadata(APP), 'webhook-worker': metadata(WORKER),
             'db': metadata('mbbs-operator-app-db-1'), 'ollama': metadata('mbbs-operator-app-ollama-1')}
    state['files'] = hashes
    candidate = {}
    for service, container in [('app', APP), ('webhook-worker', WORKER)]:
        stage = RELEASE / service
        stage.mkdir()
        original_files = FILES if service == 'app' else ['src/special-stock-request-repository.js']
        for file in original_files:
            before = docker('exec', container, 'cat', '/app/' + file)
            backup = stage / 'before' / file
            backup.parent.mkdir(parents=True, exist_ok=True); backup.write_bytes(before)
            target = stage / 'overlay' / file
            target.parent.mkdir(parents=True, exist_ok=True)
            if service == 'app':
                assert before == (OUT / 'baseline' / file).read_bytes(), 'Affected deployed source changed: ' + file
                target.write_bytes((SERVER / file).read_bytes())
            else:
                text = before.decode()
                assert text.count(SIGNATURE) == 1 and GUARD not in text
                text = text.replace(SIGNATURE, SIGNATURE + GUARD)
                assert text.count(DELIVERY_SELECT) == 1
                text = text.replace(DELIVERY_SELECT, DELIVERY_SELECTED)
                start = text.index('async function materializeSpecialDeliveryInstructions(')
                end = text.index('\nexport async function ', start)
                delivery = text[start:end]
                assert delivery.count(DELIVERY_CONDITION) == 1
                text = text[:start] + delivery.replace(DELIVERY_CONDITION, DELIVERY_PRESERVED) + text[end:]
                target.write_text(text)
        tag = 'mbbs-operator-app:special-so-link-sqft-' + service + '-20261006'
        base_tag = 'mbbs-operator-app:special-so-link-sqft-base-' + service + '-20261006'
        docker('image', 'tag', state[service]['image'], base_tag)
        (stage / 'Dockerfile').write_text('FROM ' + base_tag + '\n' + ''.join(
            'COPY --chown=node:node overlay/' + file + ' /app/' + file + '\n' for file in original_files))
        with (stage / 'build.log').open('wb') as log:
            subprocess.run(['sudo', '-n', 'docker', 'build', '--network=none', '--pull=false', '-t', tag,
                            str(stage)], stdout=log, stderr=subprocess.STDOUT, check=True)
        candidate[service] = {'tag': tag, 'image': docker('image', 'inspect', '--format', '{{.Id}}', tag).decode().strip(),
                              'files': {file: sha((stage / 'overlay' / file).read_bytes()) for file in original_files}}
    state['candidate'] = candidate
    for filename, images in [('compose.release.json', {s: c['tag'] for s, c in candidate.items()}),
                             ('compose.rollback.json', {s: state[s]['image'] for s in candidate})]:
        (RELEASE / filename).write_text(json.dumps({'services': {service: {'image': image, 'pull_policy': 'never'}
            for service, image in images.items()}}))
    resolved = json.loads(subprocess.check_output(compose(state, 'compose.release.json') + ['config', '--format', 'json']))
    for service, container in [('app', APP), ('webhook-worker', WORKER)]:
        image_config = json.loads(docker('image', 'inspect', candidate[service]['image']))[0]['Config']
        current = json.loads(docker('inspect', container))[0]['Config']
        config = resolved['services'][service]
        environment = dict(entry.split('=', 1) for entry in image_config.get('Env', []))
        environment.update({key: str(value) for key, value in config.get('environment', {}).items()})
        assert environment == dict(entry.split('=', 1) for entry in current['Env']), 'Environment drift for ' + service
    (RELEASE / 'manifest.json').write_text(json.dumps(state, indent=2))
    print(json.dumps({'prepared': True, 'candidate': candidate, 'configurationPreserved': True}), flush=True)

def wait_healthy():
    for _ in range(30):
        info = json.loads(docker('inspect', APP))[0]
        if info['State'].get('Health', {}).get('Status') == 'healthy':
            return
        time.sleep(1)
    raise RuntimeError('Application health did not recover')

def verify():
    state = json.loads((RELEASE / 'manifest.json').read_text())
    for service, container in [('app', APP), ('webhook-worker', WORKER)]:
        actual = metadata(container)
        assert actual['image'] == state['candidate'][service]['image']
        assert actual['configurationHash'] == state[service]['configurationHash'], 'Service configuration drift'
        for file, digest in state['candidate'][service]['files'].items():
            assert sha(docker('exec', container, 'cat', '/app/' + file)) == digest
        assert json.loads(docker('inspect', container))[0]['State']['Running']
    assert metadata('mbbs-operator-app-db-1') == state['db']
    assert metadata('mbbs-operator-app-ollama-1') == state['ollama']
    wait_healthy()
    result = {'deployed': True, 'services': {service: item['image'] for service, item in state['candidate'].items()},
              'configurationPreserved': True, 'dbAndOllamaPreserved': True, 'health': 'healthy',
              'files': {service: item['files'] for service, item in state['candidate'].items()}}
    (OUT / 'live-deployment.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result), flush=True)

def apply():
    verify_evidence()
    state = json.loads((RELEASE / 'manifest.json').read_text())
    assert metadata(APP) == state['app'] and metadata(WORKER) == state['webhook-worker'], 'Live release changed after preparation'
    script = b"""import {query,closeDb} from './src/db.js';
    try{console.log(JSON.stringify((await query(`SELECT json_build_object(
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'quantityApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying'),
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
      'webhooks',(SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status IN ('running','processing'))) AS counts`)).rows[0].counts));}
    finally{await closeDb();}"""
    active = json.loads(docker('exec', '-i', '-w', '/app', APP, 'node', '--input-type=module', input=script))
    assert not any(active.values()), 'Active order work is in progress: ' + json.dumps(active)
    try:
        with (RELEASE / 'publish.log').open('wb') as log:
            subprocess.run(compose(state, 'compose.release.json') + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never',
                           'app', 'webhook-worker'], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except BaseException:
        with (RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(compose(state, 'compose.rollback.json') + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never',
                           'app', 'webhook-worker'], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        wait_healthy()
        raise

if __name__ == '__main__':
    {'prepare': prepare, 'apply': apply, 'verify': verify, 'resume-bind-order': resume_bind_order}[sys.argv[1]]()

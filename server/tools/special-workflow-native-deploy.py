"""Scoped native NetSuite PDF, closure approval and planning-status release."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
BASE_IMAGE = 'sha256:482ca65888ea236c510b10c327d6b5bfbf3d1e039f970ad57d0e7ce81816a07c'
RELEASE = SERVER / 'test-artifacts/special-workflow-native-documents-release-20260926'
EVIDENCE = SERVER / 'test-artifacts/special-workflow-review/native-documents'
FILES = json.loads((EVIDENCE / 'runtime-files.json').read_text())
SERVICES = {'app': 'mbbs-operator-app-app-1', 'webhook-worker': 'mbbs-operator-app-webhook-worker-1'}
DEPENDENCIES = ['mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1']
IMAGE = 'mbbs-operator-app:special-native-documents-closure-20260926'
ROLLBACK = 'mbbs-operator-app:rollback-special-native-documents-closure-20260926'
spec = importlib.util.spec_from_file_location('core', SERVER / 'tools/operator-display-settings-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
docker = core.docker


def save(name, value):
    path = RELEASE / name
    path.write_text(json.dumps(value, indent=2) + '\n')
    path.chmod(0o600)


def load():
    return json.loads((RELEASE / 'manifest.json').read_text())


def evidence():
    assert json.loads((EVIDENCE / 'summary.json').read_text())['completed']
    hashes = json.loads((EVIDENCE / 'source-manifest.json').read_text())
    for file, sha in hashes.items():
        assert core.digest((SERVER / file).read_bytes()) == sha, 'Verified source changed: ' + file
    return {file: hashes[file] for file in FILES}


def current(info):
    assert evidence() == info['files']
    assert {s: core.metadata(c) for s, c in SERVICES.items()} == info['services'], 'Live services changed'
    assert [core.metadata(c) for c in DEPENDENCIES] == info['dependencies'], 'Dependency changed'


def compose(info, filename):
    args = ['sudo', '-n', 'docker', 'compose', '-p', 'mbbs-operator-app']
    for file in info['services']['app']['configFiles'].split(','):
        args += ['-f', file]
    return args + ['-f', str(RELEASE / filename), '--env-file', str(ROOT / 'docker/env/.env')]


def config_gate(info):
    resolved = json.loads(subprocess.check_output(compose(info, 'compose.release.yml') + ['config', '--format', 'json'], cwd=ROOT))
    image = json.loads(docker('image', 'inspect', IMAGE))[0]['Config']
    for service, container in SERVICES.items():
        live = json.loads(docker('inspect', container))[0]['Config']
        config = resolved['services'][service]
        env = dict(entry.split('=', 1) for entry in image['Env'])
        env.update({k: str(v) for k, v in config.get('environment', {}).items()})
        assert env == dict(entry.split('=', 1) for entry in live['Env']), 'Environment drift'
        for field, key in [('Cmd', 'command'), ('Entrypoint', 'entrypoint'), ('User', 'user'), ('WorkingDir', 'working_dir')]:
            assert (image.get(field) if config.get(key) is None else config[key]) == live.get(field), 'Command drift'
    save('compose.private.json', resolved)


def prepare():
    os.umask(0o077)
    hashes = evidence()
    RELEASE.mkdir(mode=0o700, exist_ok=True)
    assert not any(RELEASE.iterdir()), 'Preserve any existing prepared release'
    info = {'files': hashes, 'services': {s: core.metadata(c) for s, c in SERVICES.items()},
            'dependencies': [core.metadata(c) for c in DEPENDENCIES]}
    assert len({v['imageId'] for v in info['services'].values()}) == 1, 'Base images differ'
    for service, container in SERVICES.items():
        assert info['services'][service]['imageId'] == BASE_IMAGE, 'Unexpected production release'
        for file in FILES:
            if not (EVIDENCE / 'baseline' / file).exists():
                docker('exec', container, 'test', '!', '-e', '/app/' + file)
                continue
            assert core.digest(docker('exec', container, 'cat', '/app/' + file)) == core.digest((EVIDENCE / 'baseline' / file).read_bytes()), 'Live baseline differs: ' + file
    for container in SERVICES.values():
        assert core.digest(docker('exec', container, 'cat', '/app/src/special-stock-order-pdf.js')) == core.digest((EVIDENCE / 'baseline/src/special-stock-order-pdf.js').read_bytes())
    stage = RELEASE / 'stage'
    (stage / 'src').mkdir(parents=True)
    (stage / 'public').mkdir()
    for file in FILES:
        (stage / file).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SERVER / file, stage / file)
    base = info['services']['app']['imageId']
    docker('tag', base, ROLLBACK)
    (stage / 'Dockerfile').write_text('FROM ' + ROLLBACK + '\n' + ''.join('COPY --chown=node:node ' + f + ' /app/' + f + '\n' for f in FILES) + 'RUN rm /app/src/special-stock-order-pdf.js\n')
    with (RELEASE / 'build.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', IMAGE, str(stage)], stdout=log, stderr=subprocess.STDOUT, check=True)
    info['imageId'] = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    for filename, image in [('compose.release.yml', IMAGE), ('compose.rollback.yml', base)]:
        (RELEASE / filename).write_text('services:\n' + ''.join('  ' + s + ':\n    image: ' + image + '\n' for s in SERVICES))
    actual = docker('run', '--rm', '--network', 'none', '--entrypoint', 'sha256sum', IMAGE, *['/app/' + f for f in FILES]).decode().splitlines()
    assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in actual} == hashes
    docker('run', '--rm', '--network', 'none', '--entrypoint', 'test', IMAGE, '!', '-e', '/app/src/special-stock-order-pdf.js')
    smoke = """import assert from 'node:assert/strict';
import {buildSpecialQuote,specialOrderSnapshot} from './src/special-stock-documents.js';
import {fetchNetSuiteOrderPdf} from './src/netsuite-order-pdf.js';
import {createSpecialClosureService} from './src/special-stock-closure-service.js';
import {quotePdf} from './src/field-sales/pdf.js';
const quote=buildSpecialQuote({requestRef:'TEST',revision:1,inquiryDate:'2026-09-26',customerName:'TEST',fulfillmentMethod:'yard_pickup',lines:[{productName:'TEST',quantity:2,uom:'PLT',rate:50,discountPercent:10}]},{name:'MBBS',taxBps:1300},{draft:true});
assert.equal(quote.snapshot.totalMinor,10170);
assert.equal((await quotePdf(quote)).subarray(0,5).toString(),'%PDF-');
assert.equal(typeof createSpecialClosureService,'function');
await assert.rejects(fetchNetSuiteOrderPdf('invoice',1,{restlet:async()=>{throw Error('No network');}}),/order kind/);
assert.equal(typeof specialOrderSnapshot,'function');
console.log(JSON.stringify({passed:true,network:'none',localQuote:true,nativePdfGuard:true,closureService:true}));"""
    save('image-smoke.json', json.loads(docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', IMAGE, '--input-type=module', '-e', smoke)))
    save('manifest.json', info)
    current(info)
    config_gate(info)
    print(json.dumps({'prepared': True, 'imageId': info['imageId'], 'files': FILES}), flush=True)


def verify():
    info = load()
    core.ready(info['imageId'])
    for service, container in SERVICES.items():
        actual = core.metadata(container)
        assert actual['imageId'] == info['imageId']
        assert actual['configuration'] == info['services'][service]['configuration']
        row = json.loads(docker('inspect', container))[0]
        assert row['State']['Running'] and row['RestartCount'] == 0
        hashes = docker('exec', container, 'sha256sum', *['/app/' + f for f in FILES]).decode().splitlines()
        assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in hashes} == info['files']
    assert [core.metadata(c) for c in DEPENDENCIES] == info['dependencies']
    result = {'deployed': True, 'imageId': info['imageId'], 'configurationPreserved': True, 'dependenciesUnchanged': True, 'files': FILES}
    save('deployment-result.json', result)
    print(json.dumps(result), flush=True)


def migrate(info):
    sql = (SERVER / 'migrations/232_special_stock_closure_review.sql').read_text()
    assert core.digest(sql.encode()) == info['files']['migrations/232_special_stock_closure_review.sql']
    script = """import {query,withTransaction,closeDb} from './src/db.js';
const sql=SQL_LITERAL;
try { await withTransaction(async()=>{
  await query("SELECT pg_advisory_xact_lock(hashtextextended('special-closure-review-migration',0))");
  const existing=await query("SELECT filename FROM schema_migrations WHERE filename='232_special_stock_closure_review.sql'");
  if(!existing.rowCount){await query(sql);await query("INSERT INTO schema_migrations(filename) VALUES('232_special_stock_closure_review.sql')");}
});console.log(JSON.stringify({migration:'232_special_stock_closure_review.sql',ready:true}));}finally{await closeDb();}""".replace('SQL_LITERAL', json.dumps(sql))
    result = docker('exec', '-i', '-w', '/app', SERVICES['app'], 'node', '--input-type=module', '-', input=script.encode())
    save('migration-result.json', json.loads(result))


def apply():
    info = load()
    current(info)
    config_gate(info)
    sql = """SELECT json_build_object(
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'webhooks',(SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status IN ('running','processing')),
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'quantityApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying'),
      'closureApplying',(SELECT count(*) FROM sales_special_stock_cases special WHERE to_jsonb(special)->'closure_review'->>'status'='applying'))"""
    counts = json.loads(docker('exec', DEPENDENCIES[0], 'psql', '-U', 'mbbs_app', '-d', 'mbbs_yard', '-XAt', '-v', 'ON_ERROR_STOP=1', '-c', sql))
    save('preflight.json', counts)
    assert not any(counts.values()), 'Wait for active order work before restarting'
    current(info)
    migrate(info)
    try:
        with (RELEASE / 'cutover.log').open('wb') as log:
            subprocess.run(compose(info, 'compose.release.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', *SERVICES], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(compose(info, 'compose.rollback.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', *SERVICES], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        core.ready(info['services']['app']['imageId'])
        raise


if __name__ == '__main__':
    {'prepare': prepare, 'apply': apply, 'verify': verify}[sys.argv[1]]()

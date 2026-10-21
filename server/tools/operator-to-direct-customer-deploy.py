"""Overlay the direct-transfer completion change on the captured live app."""
import datetime
import difflib
import importlib.util
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('direct_release', ROOT / 'server/tools/operator-to-yard-flow-deploy.py')
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)
STATE = pathlib.Path('/home/ubuntu/operatorapp-deploy-backups/to01208-delivery-prep/direct-release')
ARTIFACT = ROOT / 'server/test-artifacts/operator-to-direct-customer'
CANDIDATE = STATE / 'candidate'
TAG = 'mbbs-operator-app:direct-to-completion-20261010'
ROLLBACK = 'mbbs-operator-app:direct-to-completion-rollback-20261010'
MIGRATION = '280_direct_transfer_system_receipts.sql'
release.STATE = STATE


def function(source, signature):
    found = re.findall('^' + re.escape(signature) + r'.*?^\}', source, re.M | re.S)
    assert len(found) == 1, signature
    return found[0]


def substitute(source, old, new):
    assert source.count(old) == 1, old[:100]
    return source.replace(old, new, 1)


def updated_source(name, original):
    source = (ROOT / 'server/src' / name).read_text()
    if name == 'transfer-order-posting-domain.js':
        for signature in ['export function transferPostingPhysicalStatus(job,evidence) {',
                          'export function buildTransferPostingDraft(job,source,policy,event) {']:
            original = substitute(original, function(original, signature), function(source, signature))
        start = source.index('/** @param {Record<string,any>} job @param {Record<string,any>[]} evidence */\nexport function transferLoadEvidence')
        end = source.index('/** Durable records are joined', start)
        return substitute(original, '/** Durable records are joined', source[start:end] + '/** Durable records are joined')
    if name == 'transfer-order-posting-repository.js':
        original = substitute(original, "import {transferPostingCompletion,transferPostingPhysicalStatus}",
                              "import {transferPostingCompletion,transferPostingPhysicalStatus,transferVerifiedFulfillment}")
        original = substitute(original, 'async function readTransferDriverDependencies(orderIds) {',
                              'export async function readTransferDriverDependencies(orderIds) {')
        original = substitute(original, '/** @param {unknown[]} orderIds */',
                              '/** @param {unknown[]} orderIds @returns {Promise<Record<string,any>[]>} */')
        signature = 'export async function readTransferPhysicalStatus(job) {'
        functions = [function(source, 'export async function ' + f + '(job) {')
                     for f in ['readTransferPostingEvidence', 'readTransferPhysicalStatus', 'readTransferFulfillmentEvidence']]
        return substitute(original, '/** @param {Record<string,any>} job */\n' + function(original, signature),
                          '/** @param {Record<string,any>} job @returns {Promise<Record<string,any>[]>} */\n'
                          + '\n\n/** @param {Record<string,any>} job */\n'.join(functions))
    if name == 'transfer-order-posting-service.js':
        original = substitute(original, 'import {readTransferCompletionEvents,readTransferPhysicalStatus}',
                              'import {readTransferCompletionEvents,readTransferPhysicalStatus,readTransferFulfillmentEvidence}')
        signature = 'export async function prepareTransferPostingJob(id,{resolveSource=resolveTransferSource,getPolicy=getOperatorNetSuitePostingPolicy}={}) {'
        guard = 'function waitingForPhysicalRecord(status) {'
        original = substitute(original, function(original, guard), function(original, guard)
                              + '\n\n/** @param {Record<string,any>} job @param {unknown} photos */\n'
                              + function(source, 'async function transferAdmissionInput(job,photos) {'))
        return substitute(original, function(original, signature), function(source, signature))
    if name == 'operator-netsuite-posting-domain.js':
        marker = '/**\n * Build a canonical, immutable command draft.'
        start = source.index('/** @param {Record<string,any>} input */\nfunction directTransferOperation(input) {')
        addition = source[start:source.index(marker, start)]
        original = substitute(original, marker, addition + marker)
        original = substitute(original, '  const actorOperatorId = systemReceipt ? null : requiredText(input.actorOperatorId, "Operator ID");',
                              '  const directTransferEvidence = normalizedDirectTransferEvidence(input);\n'
                              '  const actorOperatorId = systemReceipt || (directTransferEvidence && (input.actorOperatorId === null || input.actorOperatorId === undefined))\n'
                              '    ? null : requiredText(input.actorOperatorId, "Operator ID");')
        return substitute(original, '    ...(directDeliveryEvidence ? {directDeliveryEvidence} : {}),',
                          '    ...(directDeliveryEvidence ? {directDeliveryEvidence} : {}),\n'
                          '    ...(directTransferEvidence ? {directTransferEvidence} : {}),')
    if name == 'order-dependency-repository.js':
        original = substitute(original, 'import { query, withTransaction } from "./db.js";',
                              'import { query, withTransaction } from "./db.js";\n'
                              'import { completeDirectTransfersForDependencies } from "./direct-to-completion-repository.js";')
        return substitute(original, '      completed.push(result);\n    }\n    return { completed, alreadyCompleted };',
                          '      completed.push(result);\n    }\n'
                          '    await completeDirectTransfersForDependencies(rows.rows);\n    return { completed, alreadyCompleted };')
    raise ValueError(name)


def prepare():
    assert not CANDIDATE.exists(), 'Preserve the reviewed candidate and rollback capture'
    STATE.mkdir(parents=True, mode=0o700)
    ARTIFACT.mkdir(parents=True)
    before = {s: release.inspect(c) for s, c in release.SERVICES.items()}
    for service in ['db', 'ollama']: before[service] = release.inspect(f'mbbs-operator-app-{service}-1')
    release.save(STATE / 'before.private.json', before)
    baseline = STATE / 'baseline'
    baseline.mkdir()
    for name in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']:
        subprocess.run(release.DOCKER + ['cp', f"{release.SERVICES['app']}:/app/{name}", str(baseline / name)], check=True)
    subprocess.run(['sudo', '-n', 'chown', '-R', f'{os.getuid()}:{os.getgid()}', str(baseline)], check=True)
    shutil.copytree(baseline, CANDIDATE)
    names = ['transfer-order-posting-domain.js', 'transfer-order-posting-repository.js', 'transfer-order-posting-service.js',
             'operator-netsuite-posting-domain.js', 'order-dependency-repository.js']
    changes = {}
    for name in names:
        path = CANDIDATE / 'src' / name
        original = path.read_text()
        updated = updated_source(name, original)
        path.write_text(updated)
        changes['src/' + name] = {'before': release.digest(baseline / 'src' / name), 'after': release.digest(path)}
        (ARTIFACT / f'{name}.patch').write_text(''.join(difflib.unified_diff(original.splitlines(True), updated.splitlines(True),
                                                                          fromfile='before/' + name, tofile='after/' + name)))
    for name in ['src/direct-to-completion-repository.js', 'migrations/' + MIGRATION]:
        assert not (baseline / name).exists(), name
        shutil.copy2(ROOT / 'server' / name, CANDIDATE / name)
        changes[name] = {'before': None, 'after': release.digest(CANDIDATE / name)}
    release.save(ARTIFACT / 'manifest.json', {'baseImage': before['app']['Image'], 'candidateTag': TAG, 'changes': changes})
    print(json.dumps({'candidate': str(CANDIDATE), 'changedFiles': len(changes), 'baseImage': before['app']['Image']}))


def build():
    before = json.loads((STATE / 'before.private.json').read_text())
    manifest = json.loads((ARTIFACT / 'manifest.json').read_text())
    assert all(release.digest(CANDIDATE / name) == change['after'] for name, change in manifest['changes'].items())
    overlay = STATE / 'image/overlay'
    for name in manifest['changes']:
        target = overlay / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(CANDIDATE / name, target)
    subprocess.run(release.DOCKER + ['tag', before['app']['Image'], ROLLBACK], check=True)
    (overlay.parent / 'Dockerfile').write_text(f'FROM {ROLLBACK}\nCOPY --chown=node:node overlay/ /app/\n')
    with (ARTIFACT / 'build.log').open('w') as output:
        subprocess.run(release.DOCKER + ['build', '--pull=false', '--network=none', '-t', TAG, str(overlay.parent)],
                       stdout=output, stderr=subprocess.STDOUT, check=True)
    manifest['candidateImage'] = release.inspect(TAG)['Id']
    release.save(ARTIFACT / 'manifest.json', manifest)
    for kind, tag in [('release', TAG), ('rollback', ROLLBACK)]:
        (STATE / f'compose.{kind}.yml').write_text(f'services:\n  app:\n    image: {tag}\n')
    configured = json.loads(release.run(release.compose(before, 'compose.release.yml') + ['config', '--format', 'json']))
    release.save(STATE / 'compose.private.json', configured)
    image_env = dict(value.split('=', 1) for value in release.inspect(TAG)['Config']['Env'])
    environment = {**image_env, **{key: str(value) for key, value in configured['services']['app'].get('environment', {}).items()}}
    assert environment == dict(value.split('=', 1) for value in before['app']['Config']['Env']), 'Live environment changed'
    print('Built the narrow direct-transfer overlay; production environment matches the captured runtime.')


def refresh():
    assert not (ARTIFACT / 'checks.json').exists(), 'Preserve the verified candidate'
    manifest = json.loads((ARTIFACT / 'manifest.json').read_text())
    assert release.inspect(release.SERVICES['app'])['Image'] == manifest['baseImage']
    for name, change in manifest['changes'].items():
        baseline = STATE / 'baseline' / name
        if baseline.exists():
            updated = updated_source(pathlib.Path(name).name, baseline.read_text())
            (CANDIDATE / name).write_text(updated)
            (ARTIFACT / f'{pathlib.Path(name).name}.patch').write_text(''.join(difflib.unified_diff(baseline.read_text().splitlines(True),
                updated.splitlines(True), fromfile='before/' + name, tofile='after/' + name)))
        else:
            shutil.copy2(ROOT / 'server' / name, CANDIDATE / name)
        change['after'] = release.digest(CANDIDATE / name)
    release.save(ARTIFACT / 'manifest.json', manifest)
    print('Refreshed the candidate before final verification; live baseline remains unchanged.')


def migrate():
    manifest = json.loads((ARTIFACT / 'manifest.json').read_text())
    checks = json.loads((ARTIFACT / 'checks.json').read_text())
    name = 'migrations/' + MIGRATION
    assert release.digest(CANDIDATE / name) == checks['sourceHashes'][name] == manifest['changes'][name]['after']
    sql = (CANDIDATE / name).read_text()
    sql = re.sub(r'^BEGIN;\s*', '', sql)
    sql = re.sub(r'COMMIT;\s*$', '', sql)
    args = release.DOCKER + ['exec', '-i', '-w', '/app', release.SERVICES['app'], 'node', '--input-type=module']
    inventory = """import {query,closeDb} from './src/db.js';
      try {console.log(JSON.stringify({
        migrations:(await query('SELECT filename,applied_at FROM schema_migrations WHERE filename=$1',[FILENAME])).rows,
        constraint:(await query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='operator_netsuite_posting_commands'::regclass AND conname='operator_posting_actor_or_direct_receipt'")).rows
      }));}finally{await closeDb();}""".replace('FILENAME', json.dumps(MIGRATION))
    backup = STATE / 'migration-before.private.json'
    if not backup.exists():
        release.save(backup, json.loads(release.run(args, input=inventory)))
    program = """import assert from 'node:assert/strict';
      import {query,withTransaction,closeDb} from './src/db.js';
      try {
        await withTransaction(async()=>{
          await query("SET LOCAL lock_timeout='5s'");await query("SET LOCAL statement_timeout='30s'");
          await query("SELECT pg_advisory_xact_lock(hashtext('operator-to-direct-migration'))");
          if(!(await query('SELECT 1 FROM schema_migrations WHERE filename=$1',[FILENAME])).rowCount){
            await query(SQL);await query('INSERT INTO schema_migrations(filename) VALUES($1)',[FILENAME]);
          }
          const definition=(await query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='operator_netsuite_posting_commands'::regclass AND conname='operator_posting_actor_or_direct_receipt'")).rows[0]?.definition;
          assert.ok(definition?.includes('directTransferEvidence') && definition.includes('directDeliveryEvidence'));
        });
        console.log(JSON.stringify({migration:FILENAME,verified:true,at:new Date().toISOString()}));
      }finally{await closeDb();}""".replace('FILENAME', json.dumps(MIGRATION)).replace('SQL', json.dumps(sql))
    result = json.loads(release.run(args, input=program))
    release.save(ARTIFACT / 'migration.json', result)
    print('The direct-transfer receipt migration is applied and verified; the direct-PO rule is preserved.')


def deploy():
    before = json.loads((STATE / 'before.private.json').read_text())
    manifest = json.loads((ARTIFACT / 'manifest.json').read_text())
    checks = json.loads((ARTIFACT / 'checks.json').read_text())
    assert checks['tests']['fail'] == 0 and checks['tests']['pass'] == checks['tests']['tests']
    assert checks['mutantsKilled'] >= 5 and checks['lintErrors'] == 0 and checks['newTypeErrors'] == 0
    assert checks['sourceHashes'] == {name: change['after'] for name, change in manifest['changes'].items()}
    assert release.inspect(release.SERVICES['app'])['Image'] == before['app']['Image'], 'The live app changed after capture'
    names = list(manifest['changes'])
    assert release.runtime_hashes(release.SERVICES['app'], names) == {name: change['before'] for name, change in manifest['changes'].items()}
    migrate()
    try:
        subprocess.run(release.compose(before, 'compose.release.yml') + ['up', '-d', '--no-deps', '--no-build', 'app'], check=True)
        for _ in range(55):
            current = release.inspect(release.SERVICES['app'])
            if current['Image'] == manifest['candidateImage'] and current['State'].get('Health', {}).get('Status') == 'healthy': break
            time.sleep(1)
        else: raise RuntimeError('The direct-transfer app did not become healthy')
        assert release.runtime_hashes(release.SERVICES['app'], names) == checks['sourceHashes']
        for service in ['db', 'ollama', 'webhook-worker']:
            current = release.inspect(before[service]['Id'])
            assert current['State']['Running'] and current['Id'] == before[service]['Id']
        with urllib.request.urlopen('http://127.0.0.1:3000/health', timeout=5) as response:
            assert response.status == 200 and json.load(response)['ok']
        release.save(ARTIFACT / 'deployed.json', {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                                              'appImage': manifest['candidateImage'], 'health': 'healthy', 'migration': MIGRATION})
        print('Direct-transfer completion deployed and healthy; worker and production storage preserved.')
    except Exception:
        subprocess.run(release.compose(before, 'compose.rollback.yml') + ['up', '-d', '--no-deps', '--no-build', 'app'], check=True)
        raise


if __name__ == '__main__':
    os.umask(0o077)
    {'prepare': prepare, 'refresh': refresh, 'build': build, 'migrate': migrate, 'deploy': deploy}[sys.argv[1]]()

"""Release the verified direct-ship synchronization and reconcile the reported TO."""
import base64
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time

SERVER = Path(__file__).resolve().parents[1]
REPO = SERVER.parent
OUT = SERVER / 'test-artifacts/linked-direct-ship-sync'
RELEASE = SERVER / 'deployments/linked-direct-ship-sync-20261013'
APP = 'mbbs-operator-app-app-1'
WORKER = 'mbbs-operator-app-webhook-worker-1'
DB = 'mbbs-operator-app-db-1'
IMAGE = 'mbbs-operator-app:linked-direct-ship-sync-20261013'
MIGRATION = '286_linked_direct_ship_quantity_sync.sql'
OLD = ['src/order-sync-repository.js', 'src/order-dependency-repository.js', 'src/direct-to-completion-repository.js']
NEW = ['src/linked-direct-ship-sync-domain.js', 'src/linked-direct-ship-sync-repository.js']

def docker(*args, data=None):
    return subprocess.check_output(['docker', *args], input=data).decode().strip()

def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')

def digest(value):
    return hashlib.sha256(value).hexdigest()

def metadata(name):
    row = json.loads(docker('inspect', name))[0]
    config = {key: row['Config'][key] for key in ['Env', 'User', 'Entrypoint', 'Cmd', 'WorkingDir']}
    return {'image': row['Image'], 'imageRef': row['Config']['Image'],
            'configurationHash': digest(json.dumps({'config': config, 'host': row['HostConfig']}, sort_keys=True).encode()),
            'compose': row['Config']['Labels']}

def logged(label, command, env=None):
    with (OUT / (label + '.log')).open('wb') as log:
        result = subprocess.run(command, cwd=REPO, stdout=log, stderr=subprocess.STDOUT, env=env)
    if result.returncode:
        print((OUT / (label + '.log')).read_text()[-6000:])
    return result.returncode

def compose(state, override):
    labels = state['app']['compose']
    args = ['docker', 'compose', '-p', labels['com.docker.compose.project'],
            '--project-directory', labels['com.docker.compose.project.working_dir']]
    if labels.get('com.docker.compose.project.environment_file'):
        args += ['--env-file', labels['com.docker.compose.project.environment_file']]
    for file in labels['com.docker.compose.project.config_files'].split(','):
        args += ['-f', file]
    return args + ['-f', str(override)]

def healthy():
    for _ in range(30):
        try:
            health = json.loads(docker('exec', APP, 'node', '-e',
                "fetch('http://127.0.0.1:3000/health').then(r=>r.json()).then(h=>console.log(JSON.stringify({ok:h.ok})))"))
            if health.get('ok'):
                return True
        except (subprocess.CalledProcessError, json.JSONDecodeError):
            pass
        time.sleep(1)
    return False

def prepare():
    checks = json.loads((OUT / 'checks.json').read_text())
    assert all(check['exit'] == 0 for check in checks['checks'].values())
    for file, expected in checks['sourceHashes'].items():
        assert digest((SERVER / file).read_bytes()) == expected, file + ' changed after validation'
    state = {'app': metadata(APP), 'worker': metadata(WORKER)}
    assert state['app']['image'] == state['worker']['image']
    for file in OLD:
        actual = docker('exec', APP, 'sha256sum', '/app/' + file).split()[0]
        assert actual == digest((OUT / 'baseline' / file).read_bytes()), file + ' production changed'
    if RELEASE.exists():
        assert json.loads((RELEASE / 'state.json').read_text()) == state
        prior = RELEASE / 'context'
        if prior.exists():
            archive = RELEASE / ('context-before-' + digest((prior / 'src/linked-direct-ship-sync-repository.js').read_bytes())[:12])
            assert not archive.exists()
            shutil.move(prior, archive)
    else:
        RELEASE.mkdir()
    context = RELEASE / 'context'
    for file in OLD + NEW + ['migrations/' + MIGRATION]:
        target = context / file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(SERVER / file, target)
    (context / 'Dockerfile').write_text('FROM ' + state['app']['imageRef'] + '\nCOPY src/ /app/src/\n'
        + 'COPY migrations/' + MIGRATION + ' /app/migrations/' + MIGRATION + '\n')
    save(RELEASE / 'state.json', state)
    save(RELEASE / 'compose.release.json', {'services': {'app': {'image': IMAGE}, 'webhook-worker': {'image': IMAGE}}})
    save(RELEASE / 'compose.rollback.json', {'services': {'app': {'image': state['app']['imageRef']},
        'webhook-worker': {'image': state['worker']['imageRef']}}})
    assert logged('candidate-build', ['docker', 'build', '--network=none', '-t', IMAGE, str(context)]) == 0
    print(json.dumps({'preparedImage': IMAGE, 'sourceHashes': checks['sourceHashes']}))

def preview():
    domain = (SERVER / NEW[0]).read_text().replace('"./order-dependency-quantity.js"', '"file:///app/src/order-dependency-quantity.js"')
    domain_uri = 'data:text/javascript;base64,' + base64.b64encode(domain.encode()).decode()
    repository = (SERVER / NEW[1]).read_text()
    for name in ['db', 'dispatch-audit-repository', 'dispatch-order-target-repository']:
        repository = repository.replace('"./' + name + '.js"', '"file:///app/src/' + name + '.js"')
    repository = repository.replace('"./linked-direct-ship-sync-domain.js"', json.dumps(domain_uri))
    repository_uri = 'data:text/javascript;base64,' + base64.b64encode(repository.encode()).decode()
    code = "const {pool,closeDb}=await import('./src/db.js');\n" \
        + "pool.options.options='-c default_transaction_read_only=on -c statement_timeout=15000 -c jit=off';pool.options.max=1;\n" \
        + 'try {const {reconcileLinkedDirectShipQuantities}=await import(' + json.dumps(repository_uri) + ');\n' \
        + "console.log(JSON.stringify(await reconcileLinkedDirectShipQuantities({transferOrderId:1055871,apply:false})));}\n" \
        + 'finally {await closeDb();}\n'
    result = json.loads(docker('exec', '-i', '-w', '/app', APP, 'node', '--input-type=module', data=code.encode()))
    save(OUT / 'live-preview.json', result)
    print(json.dumps(result, indent=2))

def deploy():
    state = json.loads((RELEASE / 'state.json').read_text())
    for name, key in [(APP, 'app'), (WORKER, 'worker')]:
        assert metadata(name) == state[key], name + ' changed after release preparation'
    assert json.loads((OUT / 'candidate-validation.json').read_text())['passed']
    sql = (SERVER / 'migrations' / MIGRATION).read_text().replace('BEGIN;', '').replace('COMMIT;', '')
    sql = "BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s';\n" + sql \
        + "\nINSERT INTO schema_migrations(filename) VALUES('" + MIGRATION + "'); COMMIT;\n"
    docker('exec', '-i', DB, 'sh', '-c',
        'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"', data=sql.encode())
    try:
        assert logged('production-deploy', compose(state, RELEASE / 'compose.release.json')
            + ['up', '-d', '--no-deps', '--no-build', 'app', 'webhook-worker']) == 0
        assert healthy(), 'Application health did not recover'
        for name, key in [(APP, 'app'), (WORKER, 'worker')]:
            assert metadata(name)['configurationHash'] == state[key]['configurationHash'], name + ' configuration changed'
    except BaseException:
        logged('production-rollback', compose(state, RELEASE / 'compose.rollback.json')
            + ['up', '-d', '--no-deps', '--no-build', 'app', 'webhook-worker'])
        raise
    save(OUT / 'deployment.json', {'image': IMAGE, 'healthy': True, 'migration': MIGRATION})
    print(json.dumps({'deployed': IMAGE, 'healthy': True}))

def repair():
    code = r'''
const assert=(await import('node:assert/strict')).default;
const {query,withTransaction,closeDb}=await import('./src/db.js');
const {reconcileLinkedDirectShipQuantities}=await import('./src/linked-direct-ship-sync-repository.js');
const {writeAudit}=await import('./src/auth-repository.js');
try {
  const result=await withTransaction(async()=>{
    await query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['order-dependency:goa-10172-10173']);
    await query('SELECT id FROM order_dependencies WHERE id=279 FOR UPDATE');
    await query('SELECT id FROM sales_order_lines WHERE sales_order_id=ANY($1::bigint[]) ORDER BY id FOR UPDATE',[[1055868,1055869]]);
    const before=(await query('SELECT * FROM order_dependency_lines WHERE dependency_id=279 ORDER BY id FOR UPDATE')).rows;
    const progress=before.map(line=>[line.id,line.loaded_quantity,line.delivered_quantity,line.locally_received_quantity]);
    const preview=await reconcileLinkedDirectShipQuantities({transferOrderId:1055871,apply:false});
    assert.equal(preview.length,1);assert.equal(String(preview[0].dependencyId),'279');
    assert.equal(preview[0].targetRef,'GOA-10172-10173');
    assert.deepEqual(preview[0].after.map(line=>[Number(line.item_id),Number(line.allocated_quantity)]),[[1189,90],[3632,91.88],[1784,3]]);
    const changed=await reconcileLinkedDirectShipQuantities({transferOrderId:1055871});
    const after=(await query('SELECT * FROM order_dependency_lines WHERE dependency_id=279 ORDER BY id')).rows;
    assert.deepEqual(after.filter(line=>before.some(old=>old.id===line.id)).map(line=>[line.id,line.loaded_quantity,line.delivered_quantity,line.locally_received_quantity]),progress);
    await writeAudit({actorType:'system',source:'control',action:'netsuite.direct_ship.repaired',orderId:1055868,
      details:{salesOrderRef:'SOA10172',transferOrderRef:'TOB01228',targetRef:'GOA-10172-10173',
        reason:'User requested full matching direct-ship quantities after NetSuite edits, matched by item and unit.',
        dependencyId:279,before:changed[0].before,after:changed[0].after,preservedExecutionHistory:true}});
    return changed;
  });
  console.log(JSON.stringify(result));
}finally{await closeDb();}
'''
    result = json.loads(docker('exec', '-i', '-w', '/app', APP, 'node', '--input-type=module', data=code.encode()))
    save(OUT / 'live-repair.json', result)
    print(json.dumps(result, indent=2))

if __name__ == '__main__':
    {'prepare': prepare, 'preview': preview, 'deploy': deploy, 'repair': repair}[sys.argv[1]]()

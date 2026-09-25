"""Scoped follow-up release, retaining the previous release's guarded cutover."""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import io

spec = importlib.util.spec_from_file_location('special_base_release', Path(__file__).with_name('special-workflow-deploy.py'))
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
base.RELEASE = Path('/home/ubuntu/operatorapp-deploy-backups/special-workflow-pricing-20260924-v3')
base.ART = base.SERVER / 'test-artifacts/special-workflow-pricing'
base.MIGRATION = '228_special_workflow_pricing.sql'
ORIGINAL = Path('/home/ubuntu/operatorapp-investigations/special-workflow-pricing-20260924/baseline')
NEW = ['public/special-stock-pricing.js','public/special-stock-calendar.js','src/special-stock-pricing-domain.js','src/special-stock-quantity-adapter.js','src/special-stock-quantity-service.js','migrations/' + base.MIGRATION]
VERSION = 'special-workflow-pricing-20260924-v3'


def workflow_patch(file, original):
    if file == 'src/netsuite.js':
        # The workspace's pending request-priority work added a queue helper.
        # Add only our exports and use the mutation queue already on this image.
        before=(original / file).read_text()
        source=(base.SERVER / file).read_text()
        marker='export async function prepareSpecialQuantityPlanInNetSuite(input) {'
        assert source.count(marker)==1 and marker not in before
        exports=source[source.index(marker):]
        if 'function queueNetSuiteMutation(' not in before:
            queued='return queueNetSuiteMutation(() => applySpecialQuantityPlan(plan, { rest: netsuiteRest, queryAll: suiteqlAll }));'
            assert exports.count(queued)==1 and 'let restMutationQueue = Promise.resolve();' in before
            exports=exports.replace(queued, "const run = () => applySpecialQuantityPlan(plan, { rest: netsuiteRest, queryAll: suiteqlAll });\n  const result = restMutationQueue.then(run, run);\n  restMutationQueue = result.catch(() => {});\n  return result;")
        return base.make_diff(file,before,before.rstrip()+'\n'+exports)

    patch = base.make_diff(file, (ORIGINAL / file).read_text(), (base.SERVER / file).read_text())
    if file not in ['src/server.js','src/netsuite.js','src/dispatch-plan-repository.js']:
        return patch
    # This shared file is also being edited for unrelated operator work. Keep
    # only this release's quantity-review imports, endpoints and planning guard.
    header, *hunks = re.split(r'(?=^@@ )', patch, flags=re.M)
    selected = [hunk for hunk in hunks if any(
        re.search(r'special|Special', line) for line in hunk.splitlines()
        if line.startswith(('+', '-')))]
    assert len(selected) == {'src/server.js':3,'src/netsuite.js':1,'src/dispatch-plan-repository.js':2}[file], 'Unexpected Special quantity patch scope: ' + file
    scoped = header + ''.join(selected)
    assert 'operatorNetSuitePriority' not in scoped
    return scoped


def source_gate():
    hashes = json.loads((base.ART / 'final/source-manifest.json').read_text())
    for file, expected in hashes.items():
        assert base.digest((base.SERVER / file).read_bytes()) == expected, 'Verified source changed: ' + file
    tests = (base.ART / 'final/tests-coverage.txt').read_text()
    assert '# fail 0\n' in tests and '# skipped 0\n' in tests
    assert all(row['passed'] for row in json.loads((base.ART / 'browser/results.json').read_text()))
    changed = [str(file.relative_to(ORIGINAL)) for file in ORIGINAL.rglob('*')
               if file.is_file() and str(file.relative_to(ORIGINAL)).startswith(('src/', 'public/'))
               and file.read_bytes() != (base.SERVER / file.relative_to(ORIGINAL)).read_bytes()]
    return sorted(changed + NEW)


def snapshot():
    assert not base.RELEASE.exists(), 'Release directory already exists; preserve it'
    base.RELEASE.mkdir(mode=0o700)
    before = base.inspect(*base.SERVICES.values(), *base.DEPENDENCIES)
    base.save('containers.before.private.json', before)
    for role, row in zip(base.SERVICES, before):
        name = 'special-pricing-source-' + role
        base.docker('create', '--name', name, row['Image'])
        target = base.RELEASE / (role + '-before')
        target.mkdir()
        try:
            for directory in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']:
                base.docker('cp', name + ':/app/' + directory, str(target / directory))
        finally:
            base.docker('rm', name)
    print('Saved private production baselines.', flush=True)


def prepare():
    base.current()
    assert not (base.RELEASE / 'manifest.json').exists()
    before = base.read('containers.before.private.json')
    scope = source_gate()
    manifest = {'services': {}, 'migration': base.MIGRATION, 'preparedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    for index, role in enumerate(base.SERVICES):
        original = base.RELEASE / (role + '-before')
        candidate = base.RELEASE / (role + '-candidate')
        shutil.copytree(original, candidate)
        chosen = scope if role == 'app' else [f for f in scope if f.startswith(('src/', 'migrations/')) or f in ['public/special-stock-workflow.js','public/special-stock-pricing.js','public/special-stock-calendar.js']]
        patches = ''
        for file in chosen:
            destination = candidate / file
            if file in NEW:
                assert not destination.exists()
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(base.SERVER / file, destination)
            else:
                patches += workflow_patch(file, original)
        (base.RELEASE / (role + '.patch')).write_text(patches)
        patched = subprocess.run(['patch', '--batch', '--fuzz=0', '-p1'], cwd=candidate, input=patches.encode(), capture_output=True)
        (base.RELEASE / (role + '-patch.log')).write_bytes(patched.stdout + patched.stderr)
        assert patched.returncode == 0, 'Patch conflict: ' + role
        for artifact in list(candidate.rglob('*.orig')) + list(candidate.rglob('*.rej')):
            artifact.unlink()
        old, new = base.files_at(original), base.files_at(candidate)
        assert {f for f in set(old) | set(new) if old.get(f) != new.get(f)} == set(chosen)
        stage = base.RELEASE / (role + '-stage')
        stage.mkdir()
        for file in chosen:
            (stage / file).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(candidate / file, stage / file)
        rollback = 'mbbs-operator-app:rollback-' + VERSION + '-' + role
        image = 'mbbs-operator-app:' + VERSION + '-' + role
        (stage / 'Dockerfile').write_text('FROM ' + rollback + '\n' + ''.join('COPY --chown=node:node ' + f + ' /app/' + f + '\n' for f in chosen))
        manifest['services'][role] = {'image': image, 'rollback': rollback, 'baseImageId': before[index]['Image'], 'files': chosen,
                                      'allFiles': new, 'after': {f: new[f] for f in chosen}}
    base.save('manifest.json', manifest)
    for name, release in [('release', True), ('rollback', False)]:
        body = 'services:\n'
        for role, row in manifest['services'].items():
            service = 'app' if role == 'app' else 'webhook-worker'
            body += '  ' + service + ':\n    image: ' + (row['image'] if release else row['baseImageId']) + '\n'
        (base.RELEASE / ('compose.' + name + '.yml')).write_text(body)
    print(json.dumps({'prepared': True, 'files': {role: row['files'] for role, row in manifest['services'].items()}}), flush=True)


def backup_and_migrate():
    for name, flags in [('schema-before.dump', ['--schema-only']), ('special-before.dump', ['--table=public.schema_migrations', '--table=public.mbt_feature_flags', '--table=public.sales_stock_requests', '--table=public.sales_stock_request_lines', '--table=public.sales_stock_request_events', '--table=public.sales_special_stock_*'])]:
        with (base.RELEASE / name).open('wb') as output:
            subprocess.run(['docker', 'exec', base.DEPENDENCIES[0], 'pg_dump', '-U', 'mbbs_app', '-d', 'mbbs_yard', '--format=custom', *flags], stdout=output, check=True)
        with (base.RELEASE / name).open('rb') as source:
            toc = base.docker('exec', '-i', base.DEPENDENCIES[0], 'pg_restore', '--list', stdin=source)
        assert b'sales_special_stock_cases' in toc and b'mbt_feature_flags' in toc
        (base.RELEASE / (name + '.toc')).write_bytes(toc)
    base.save('database-backups.json', {name: {'sha256': base.digest((base.RELEASE / name).read_bytes()), 'bytes': (base.RELEASE / name).stat().st_size} for name in ['schema-before.dump', 'special-before.dump']})
    state = base.preflight()
    assert not any(state[key] for key in ['operatorPosting', 'webhooksRunning', 'specialCreating'])
    assert base.database("SELECT count(*) FROM schema_migrations WHERE filename='228_special_workflow_pricing.sql';").strip() == '0'
    sql = (base.RELEASE / 'app-candidate/migrations' / base.MIGRATION).read_text()
    result = base.database("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'; SELECT pg_advisory_xact_lock(hashtext('special-workflow-228'));\n" + sql + "\nINSERT INTO schema_migrations(filename) VALUES('228_special_workflow_pricing.sql'); COMMIT;")
    (base.RELEASE / 'migration.log').write_text(result)


base_verify = base.verify
def verify():
    result = base_verify()
    checks = json.loads(base.database("SELECT jsonb_build_object('migration228',(SELECT count(*) FROM schema_migrations WHERE filename='228_special_workflow_pricing.sql'),'testSkipGateEnabled',(SELECT enabled FROM mbt_feature_flags WHERE flag_key='special_stock_request_test_skip_orders'));").strip())
    assert checks['migration228'] == 1
    assert checks['testSkipGateEnabled'] == base.read('preflight.json')['testSkipGateEnabled']
    script = """const out=[];for(const host of ['http://127.0.0.1:3000','https://test.mbbsoperation.com'])for(const [role,action]of [['sales','sales-order/skip'],['scm','purchase-order/skip'],['sales','quantity-change'],['scm','quantity-review']]){const r=await fetch(host+'/api/'+role+'/special-stock-requests/1/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(r.status!==401)throw Error('Unexpected anonymous skip access');out.push({host,role,status:r.status})}console.log(JSON.stringify(out))"""
    checks['anonymousSkipApis'] = json.loads(base.docker('exec', base.SERVICES['app'], 'node', '--input-type=module', '-e', script))
    result['pricing'] = checks
    result['configurationUnchanged'] = True
    base.save('deployment-result.json', result)
    print(json.dumps({'pricingVerification': checks}), flush=True)
    return result


base_preflight = base.preflight
def pricing_preflight():
    state = base_preflight()
    extra = json.loads(base.database("SELECT jsonb_build_object('quantityApplying',(SELECT count(*) FROM sales_special_stock_cases special WHERE to_jsonb(special)->'quantity_review'->>'status'='applying'),'testSkipGateEnabled',(SELECT enabled FROM mbt_feature_flags WHERE flag_key='special_stock_request_test_skip_orders'),'unsupportedLegacyPrices',(SELECT count(*) FROM sales_special_stock_order_lines WHERE order_kind='sales_order' AND (unit_rate<>round(unit_rate,6) OR unit_rate<0 OR unit_rate>1000000000)));"))
    assert extra['quantityApplying'] == 0, 'Quantity synchronization is running; retry after it finishes'
    assert extra['unsupportedLegacyPrices'] == 0, 'Legacy pricing needs explicit review before migration'
    return {**state, **extra}
base.preflight = pricing_preflight

base_readiness = base.netsuite_readiness
def pricing_readiness():
    try:
        base_readiness()
    except subprocess.CalledProcessError as error:
        # The underlying Docker command contains inherited production settings.
        # Keep its diagnostic private instead of printing the command/environment.
        (base.RELEASE / 'readiness-error.private.txt').write_text(repr(error))
        raise RuntimeError('Read-only readiness failed; private diagnostic retained.') from None
    script = """import {suiteqlAll} from './src/netsuite.js';import {closeDb} from './src/db.js';
try{const rows=await suiteqlAll("SELECT tl.quantityshiprecv AS execution_quantity,tl.quantitybilled AS billed_quantity,tl.isclosed AS line_closed,BUILTIN.DF(t.status) AS status_text FROM transactionline tl JOIN transaction t ON t.id=tl.transaction WHERE t.type IN ('SalesOrd','PurchOrd') AND tl.item=2055 AND tl.mainline='F' AND ROWNUM<=1");console.log(JSON.stringify({readOnly:true,columnsSupported:true,rows:rows.length,fields:rows[0]?Object.keys(rows[0]):[]}));}finally{await closeDb();}"""
    evidence=json.loads(base.docker('exec',base.SERVICES['app'],'node','--input-type=module','-e',script))
    result=base.read('netsuite-readiness.json')
    result['quantityExecutionMetadata']=evidence
    base.save('netsuite-readiness.json',result)
    print(json.dumps(evidence),flush=True)
base.netsuite_readiness = pricing_readiness

base.source_gate = source_gate
base.backup_and_migrate = backup_and_migrate
base.verify = verify
# The candidate checker imports these existing guarded operations.
SERVER, ROOT, RELEASE, ART = base.SERVER, base.ROOT, base.RELEASE, base.ART
current, read, save, inspect, docker, config_gate = base.current, base.read, base.save, base.inspect, base.docker, base.config_gate
if __name__ == '__main__':
    os.umask(0o077)
    {'snapshot': snapshot, 'prepare': prepare, 'build': base.build, 'readiness': base.netsuite_readiness,
     'config': config_gate, 'apply': base.apply, 'verify': verify}[sys.argv[1]]()

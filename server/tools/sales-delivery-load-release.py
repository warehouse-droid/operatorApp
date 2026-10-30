"""Scoped Operator-load SO IF rollout; preserve live source and configuration."""
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
import time
import urllib.request

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
RELEASE = SERVER / 'deployments/sales-delivery-load-20261021'
IMAGE = 'mbbs-operator-app:sales-delivery-load-20261021'
ROLLBACK = IMAGE + '-rollback'
MIGRATION = '301_sales_order_operator_load_fulfillment.sql'
spec = importlib.util.spec_from_file_location('so_load_release_base', SERVER / 'tools/ifir-integration-release.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
core = base.core
core.RELEASE = RELEASE
FILES = [
    'src/sales-order-auto-fulfillment-loads.js',
    'src/sales-order-auto-fulfillment-repository.js',
    'src/sales-order-auto-fulfillment-service.js',
    'src/operator-netsuite-posting-admission.js',
    'src/operator-netsuite-posting-targets.js',
    'src/movement-record-evidence.js',
    'src/mbt/feature-gate-catalog.js',
    'migrations/' + MIGRATION,
]
VERIFIED = dict(zip(FILES, [
    'a882cf793bad5ba8efa5e1eb1bb3d735f5023bf686822f51c8e88b469d822fc2',
    'e5613462165f6ed157661b89107c94508fd6b1001c9eb3c21c15f0ac40a47f9e',
    'bd0e271f393fc3835777c60b5741c11d435008849430217a32e2bb697a9fcab6',
    '90ec070c45fa37a9c77c9bb7f09a25bfaf77bf489ab99659ba0ce46f7cb2c652',
    'b88494f27781eb0683f324dc6387fa3aed80bbe690da29563501ae7bec18e46f',
    '7ec6d53c04858f0ebf22fe26bcfb75ce89b5cc289019d0b8409b011594c26671',
    '3eee1662fff9708fcc5b876a80087fc858bfedbee68bc58d823be1d2a7be63d2',
    '69046fbb145a10e5f6e7166c61e17a40b0376872a062fe1f05ae75973234a35f',
]))


def save(name, value):
    core.save(name, value)


def current(data):
    assert core.metadata(core.APP) == data['app'], 'Live app changed; recapture required'
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    assert json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)) == data['beforeTree']
    assert base.tree(RELEASE / 'candidate') == data['candidateTree']


def original(name, source):
    replacements = {
        'src/sales-order-auto-fulfillment-service.js': [
            ('candidate.isSplit || candidate.operatorLoadRecordId', 'candidate.isSplit')],
        'src/operator-netsuite-posting-targets.js': [
            ('(root.order_type === "sales_order" ? "sales_load_background" : "driver_completion")', '"driver_completion"')],
        'src/mbt/feature-gate-catalog.js': [
            ('${yard.yardCode} Operator loaded Delivery SO → IF', '${yard.yardCode} completed Delivery SO → IF'),
            ('Queue a Sales Order Item Fulfillment for the exact lines and quantities loaded by Operator at yard ${yard.yardCode}. Driver completion is delivery evidence only.',
             'After an accepted Driver customer drop or audited manual Dispatch completion from yard ${yard.yardCode}, create one verified Sales Order Item Fulfillment for the conserved Operator residual plus completed direct PO/TO supply.')],
    }
    if name in replacements:
        for after, before in replacements[name]:
            assert source.count(after) == 1
            source = source.replace(after, before)
        return source
    return subprocess.check_output(['git', 'show', 'HEAD:server/' + name], cwd=ROOT).decode()


def capture():
    assert {name: core.sha((SERVER / name).read_bytes()) for name in FILES} == VERIFIED, 'Verified workspace changed'
    os.umask(0o077)
    if RELEASE.exists():
        assert not any(RELEASE.iterdir()), 'Existing capture must be reviewed'
    RELEASE.mkdir(parents=True, exist_ok=True)
    app = core.metadata(core.APP)
    dependencies = [core.metadata(name) for name in core.DEPENDENCIES]
    roots = json.loads(core.docker('exec', core.APP, 'node', '-e',
        "console.log(JSON.stringify(['src','public','migrations','contracts','package.json','package-lock.json'].filter(p=>require('node:fs').existsSync(p))))"))
    archive = core.docker('exec', core.APP, 'tar', '-cf', '-', '-C', '/app', *roots)
    before = RELEASE / 'before'
    before.mkdir()
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(before, filter='data')
    candidate = RELEASE / 'candidate'
    shutil.copytree(before, candidate)
    patch = ''
    for name in FILES:
        source = (SERVER / name).read_text()
        if name in ['src/sales-order-auto-fulfillment-loads.js', 'migrations/' + MIGRATION]:
            assert not (candidate / name).exists()
            shutil.copy2(SERVER / name, candidate / name)
        else:
            patch += ''.join(difflib.unified_diff(original(name, source).splitlines(True),
                source.splitlines(True), fromfile='a/' + name, tofile='b/' + name, n=3))
    core.apply_patch(candidate, patch, 'operator-load')
    before_tree, after_tree = base.tree(before), base.tree(candidate)
    changed = sorted(name for name in before_tree.keys() | after_tree.keys() if before_tree.get(name) != after_tree.get(name))
    assert changed == sorted(FILES), 'Unexpected release scope'
    data = {'capturedAt': core.now(), 'authorization': 'User explicitly requested deploy',
            'app': app, 'dependencies': dependencies, 'files': changed,
            'beforeTree': before_tree, 'candidateTree': after_tree,
            'candidateTreeHash': core.sha(json.dumps(after_tree, sort_keys=True).encode()),
            'verifiedWorkspaceHashes': VERIFIED,
            'candidateSourceHashes': {name: after_tree[name] for name in FILES}}
    save('manifest.json', data)
    current(data)
    print(json.dumps({'captured': True, 'files': changed,
          'candidateDiffersFromVerifiedWorkspace': [name for name in FILES if after_tree[name] != VERIFIED[name]],
          'runtimeFiles': len(after_tree)}), flush=True)


def build():
    data = core.state()
    current(data)
    core.docker('tag', data['app']['imageId'], ROLLBACK)
    stage = RELEASE / 'stage'
    for name in FILES:
        target = stage / 'overlay' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(RELEASE / 'candidate' / name, target)
    (stage / 'Dockerfile').write_text('FROM ' + ROLLBACK + '\nCOPY --chown=node:node overlay/ /app/\n')
    for mode, image in [('release', IMAGE), ('rollback', ROLLBACK)]:
        (RELEASE / ('compose.' + mode + '.yml')).write_text('services:\n  app:\n    image: ' + image + '\n')
    with (RELEASE / 'build.log').open('wb') as output:
        subprocess.run(['docker', 'build', '--network=none', '--pull=false', '-t', IMAGE, str(stage)],
                       stdout=output, stderr=subprocess.STDOUT, check=True, timeout=180)
    data['candidateImageId'] = core.docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    save('manifest.json', data)
    configs = [json.loads(subprocess.check_output(core.compose(data, mode) + ['config', '--format', 'json'], cwd=ROOT))
               for mode in ['release', 'rollback']]
    for config in configs:
        config['services']['app'].pop('image')
    assert configs[0] == configs[1], 'Configuration changed beyond image'
    core.config_check(data)
    current(data)
    print(json.dumps({'built': True, 'imageId': data['candidateImageId']}), flush=True)


def queue_fingerprint():
    return json.loads(core.sql("""SELECT json_build_object(
      'candidates',(SELECT md5(coalesce(jsonb_agg(to_jsonb(c) ORDER BY id)::text,'[]')) FROM dispatch_sales_order_if_candidates c),
      'claims',(SELECT md5(coalesce(jsonb_agg(to_jsonb(c) ORDER BY candidate_id,source_sales_order_id,source_line_id)::text,'[]')) FROM dispatch_sales_order_if_line_claims c),
      'audit',(SELECT md5(coalesce(jsonb_agg(to_jsonb(c) ORDER BY id)::text,'[]')) FROM dispatch_sales_order_if_audit_events c),
      'watermarks',(SELECT md5(coalesce(jsonb_agg(to_jsonb(c) ORDER BY gate_key)::text,'[]')) FROM dispatch_sales_order_if_gate_watermarks c));"""))


def schema_status():
    return json.loads(core.sql("""SELECT json_build_object(
      'migration',(SELECT count(*) FROM schema_migrations WHERE filename='301_sales_order_operator_load_fulfillment.sql'),
      'driverTrigger',(SELECT count(*) FROM pg_trigger WHERE tgrelid='dispatch_order_completion_events'::regclass AND tgname='trg_dispatch_enqueue_sales_order_if_candidate'),
      'loadTrigger',(SELECT count(*) FROM pg_trigger WHERE tgrelid='operator_load_records'::regclass AND tgname='trg_operator_enqueue_sales_order_if_candidate' AND tgenabled='O'),
      'gates',(SELECT coalesce(json_agg(json_build_object('key',flag_key,'enabled',enabled,'revision',revision) ORDER BY flag_key),'[]') FROM mbt_feature_flags WHERE flag_key LIKE 'dispatch_netsuite_sales_order_if_%'),
      'cutoverAudit',(SELECT count(*) FROM dispatch_sales_order_if_audit_events WHERE action='operator_load_trigger_cutover'),
      'cutoverAttention',(SELECT count(*) FROM dispatch_sales_order_if_candidates WHERE status='attention' AND result->>'reason'='operator_load_trigger_replaced_driver_completion'),
      'retiredActiveClaims',(SELECT count(*) FROM dispatch_sales_order_if_line_claims cl JOIN dispatch_sales_order_if_candidates c ON c.id=cl.candidate_id WHERE cl.active AND c.result->>'reason'='operator_load_trigger_replaced_driver_completion'),
      'newLoadCandidates',(SELECT count(*) FROM dispatch_sales_order_if_candidates WHERE operator_load_record_id IS NOT NULL));"""))


def verify():
    data = core.state()
    core.ready(data['candidateImageId'])
    actual = core.metadata(core.APP)
    assert actual['configuration'] == data['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    assert json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)) == data['candidateTree']
    schema = schema_status()
    assert schema['migration'] == 1 and schema['driverTrigger'] == 0 and schema['loadTrigger'] == 1
    assert schema['gates'] == json.loads((RELEASE / 'database-preparation.json').read_text())['gates']
    assert schema['retiredActiveClaims'] == 0
    http = core.http_check({}, ['/api/admin/sales-order-fulfillment/candidates', '/api/admin/sales-order-fulfillment/historical'])
    containers = {}
    for args, key in [(['ps'], 'running'), (['ps', '-a'], 'all')]:
        containers[key] = core.docker(*args, '--format', '{{.Names}} {{.Status}}').decode().splitlines()
        assert {line.split()[0] for line in containers[key]} == {core.APP, *core.DEPENDENCIES}
    save('container-check.json', containers)
    result = {'deployed': True, 'at': core.now(), 'image': IMAGE, 'imageId': actual['imageId'],
              'candidateTreeHash': data['candidateTreeHash'], 'runtimeFilesVerified': len(data['candidateTree']),
              'files': FILES, 'configurationPreserved': True, 'dependenciesUnchanged': True,
              'schema': schema, 'http': http, 'rollbackImage': ROLLBACK}
    save('deployment-result.json', result)
    print(json.dumps(result), flush=True)


def prepare_rollback():
    snapshot = json.loads(core.sql("""SELECT json_build_object(
      'candidates',(SELECT coalesce(json_agg(row_to_json(c)),'[]') FROM dispatch_sales_order_if_candidates c WHERE completion_event_id IS NOT NULL AND attempt_count=0 AND status IN ('discovered','waiting_evidence','queued','gate_disabled','historical','attention') AND coalesce(resolution_action,'automatic') IN ('automatic','recheck')),
      'claims',(SELECT coalesce(json_agg(row_to_json(c)),'[]') FROM dispatch_sales_order_if_line_claims c),
      'watermarkFunction',pg_get_functiondef('dispatch_capture_sales_order_if_activation_watermark()'::regprocedure),
      'driverTrigger',(SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid='dispatch_order_completion_events'::regclass AND tgname='trg_dispatch_enqueue_sales_order_if_candidate'),
      'priorCutoverAudit',(SELECT count(*) FROM dispatch_sales_order_if_audit_events WHERE action='operator_load_trigger_cutover'));
    """))
    save('cutover-records-before.json', snapshot)
    assert snapshot['driverTrigger']
    (RELEASE / 'rollback-migration.sql').write_text(rollback_statement(snapshot))
    return snapshot


def rollback_statement(snapshot):
    def literal(value):
        return "'" + json.dumps(value).replace("'", "''") + "'::jsonb"
    rollback = """BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='20s';
DO $$ BEGIN IF EXISTS(SELECT 1 FROM dispatch_sales_order_if_candidates WHERE operator_load_record_id IS NOT NULL)
THEN RAISE EXCEPTION 'New load candidates require forward recovery'; END IF; END $$;
DROP TRIGGER trg_operator_enqueue_sales_order_if_candidate ON operator_load_records;
DROP FUNCTION operator_enqueue_sales_order_if_candidate();
INSERT INTO dispatch_sales_order_if_audit_events(candidate_id,action,details)
SELECT c.id,'operator_load_trigger_cutover_rollback','{"reason":"release_failed_before_queue_activity"}'::jsonb
FROM jsonb_populate_recordset(NULL::dispatch_sales_order_if_candidates,CANDIDATES) c;
UPDATE dispatch_sales_order_if_candidates c SET status=b.status,last_error=b.last_error,result=b.result,updated_at=b.updated_at
FROM jsonb_populate_recordset(NULL::dispatch_sales_order_if_candidates,CANDIDATES) b WHERE b.id=c.id;
UPDATE dispatch_sales_order_if_line_claims c SET active=b.active,released_at=b.released_at
FROM jsonb_populate_recordset(NULL::dispatch_sales_order_if_line_claims,CLAIMS) b
WHERE b.candidate_id=c.candidate_id AND b.source_sales_order_id=c.source_sales_order_id AND b.source_line_id=c.source_line_id;
ALTER TABLE dispatch_sales_order_if_candidates DROP CONSTRAINT sales_order_if_one_origin,
DROP COLUMN operator_load_record_id,DROP COLUMN operator_load_snapshot,DROP COLUMN activation_load_record_id,
ALTER COLUMN completion_event_id SET NOT NULL;
ALTER TABLE dispatch_sales_order_if_gate_watermarks DROP COLUMN activation_load_record_id;
""".replace('CANDIDATES', literal(snapshot['candidates'])).replace('CLAIMS', literal(snapshot['claims']))
    rollback += snapshot['watermarkFunction'] + '\n' + snapshot['driverTrigger'] + ';\n'
    rollback += "DELETE FROM schema_migrations WHERE filename='" + MIGRATION + "';\nCOMMIT;\n"
    return rollback


def rehearse():
    if not os.environ.get('MBBS_TEST_ARTIFACT_DIR'):
        subprocess.run(['python3', str(ROOT / 'docker/retention/retention.py'), 'run', '--',
                        'python3', str(Path(__file__).resolve()), 'rehearse'], check=True)
        return
    data = core.state()
    output = Path(os.environ['MBBS_TEST_ARTIFACT_DIR'])
    output.chmod(0o777)
    project = 'mbbs-so-load-rollback-' + str(os.getpid())
    overlay = output / 'compose.json'
    service = {'image': data['candidateImageId'], 'labels': {'com.mbbs.lifecycle': 'disposable-test'}}
    overlay.write_text(json.dumps({'services': {'migrate': service, 'db': {'labels': service['labels']}}}))
    compose = ['docker', 'compose', '-p', project, '-f', str(ROOT / 'docker-compose.mbt-test.yml'), '-f', str(overlay)]
    def test_sql(statement):
        return subprocess.check_output(compose + ['exec', '-T', 'db', 'psql', '-U', 'mbt_test', '-d', 'mbt_test',
            '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], input=statement.encode())
    try:
        subprocess.run(compose + ['up', '-d', '--wait', 'db'], check=True)
        with (output / 'migrate.log').open('wb') as log:
            subprocess.run(compose + ['run', '--rm', '--no-deps', '-T', 'migrate', 'npm', 'run', 'migrate'],
                           stdout=log, stderr=subprocess.STDOUT, check=True, timeout=90)
        old = (RELEASE / 'before/migrations/180_sales_order_completion_fulfillment.sql').read_text()
        watermark = re.search(r'CREATE OR REPLACE FUNCTION dispatch_capture_sales_order_if_activation_watermark\(\).*?\$\$;', old, re.S).group()
        statement = rollback_statement({'candidates': [], 'claims': [], 'watermarkFunction': watermark,
          'driverTrigger': 'CREATE TRIGGER trg_dispatch_enqueue_sales_order_if_candidate AFTER INSERT ON dispatch_order_completion_events FOR EACH ROW EXECUTE FUNCTION dispatch_enqueue_sales_order_if_candidate()'})
        test_sql(statement)
        assert test_sql("SELECT count(*) FROM pg_trigger WHERE tgname='trg_dispatch_enqueue_sales_order_if_candidate';").strip() == b'1'
        assert test_sql("SELECT count(*) FROM information_schema.columns WHERE table_name='dispatch_sales_order_if_candidates' AND column_name='operator_load_record_id';").strip() == b'0'
        test_sql((RELEASE / 'candidate/migrations' / MIGRATION).read_text())
        assert test_sql("SELECT count(*) FROM pg_trigger WHERE tgname='trg_operator_enqueue_sales_order_if_candidate';").strip() == b'1'
        assert test_sql("SELECT count(*) FROM pg_trigger WHERE tgname='trg_dispatch_enqueue_sales_order_if_candidate';").strip() == b'0'
        save('rollback-rehearsal.json', {'passed': True, 'at': core.now(), 'syntheticEmptyDatabase': True,
                                       'downgradeThenReapply': True})
        print('Rollback SQL and migration reapply passed on disposable database', flush=True)
    finally:
        subprocess.run(compose + ['down', '--volumes', '--remove-orphans'], check=True)
        for args in [['ps'], ['ps', '-a']]:
            print(core.docker(*args, '--format', '{{.Names}} {{.Status}}').decode(), end='')
        for args in [['ps', '-a'], ['volume', 'ls'], ['network', 'ls']]:
            assert not core.docker(*args, '-q', '--filter', 'label=com.docker.compose.project=' + project).strip()
        with urllib.request.urlopen('http://127.0.0.1:3000/health', timeout=5) as response:
            assert response.status == 200


def apply():
    data = core.state()
    current(data)
    validation = json.loads((RELEASE / 'validation-passed.json').read_text())
    assert validation['passed'] and validation['candidateTreeHash'] == data['candidateTreeHash']
    assert validation['imageId'] == data['candidateImageId']
    assert json.loads((RELEASE / 'rollback-rehearsal.json').read_text())['passed']
    assert core.docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip() == data['candidateImageId']
    assert int(core.sql("SELECT count(*) FROM schema_migrations WHERE filename='" + MIGRATION + "';")) == 0
    core.config_check(data)
    for attempt in range(20):
        active = core.preflight()
        active['automaticFulfillment'] = int(core.sql("SELECT count(*) FROM dispatch_sales_order_if_candidates WHERE status='posting';"))
        try:
            core.assert_no_active_operations(active)
            break
        except AssertionError:
            if attempt == 19:
                raise
            time.sleep(2)
    current(data)
    with (RELEASE / 'schema-before.sql').open('wb') as output:
        subprocess.run(['docker', 'exec', core.DB, 'pg_dump', '-U', 'mbbs_app', '-d', 'mbbs_yard',
                        '--schema-only', '--no-owner', '--no-acl'], stdout=output, check=True, timeout=30)
    migrated = False
    stopped = False
    start = time.monotonic()
    args = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
    try:
        # Stop the app that owns the SO posting scheduler before changing triggers.
        core.docker('stop', '--time', '30', core.APP, timeout=40)
        stopped = True
        active = core.preflight()
        active['automaticFulfillment'] = int(core.sql("SELECT count(*) FROM dispatch_sales_order_if_candidates WHERE status='posting';"))
        core.assert_no_active_operations(active)
        snapshot = prepare_rollback()
        statement = (RELEASE / 'candidate/migrations' / MIGRATION).read_text().strip()
        assert statement.startswith('BEGIN;') and statement.endswith('COMMIT;')
        statement = statement[len('BEGIN;'):-len('COMMIT;')]
        core.sql("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='20s';\n" + statement +
                 "\nINSERT INTO schema_migrations(filename) VALUES('" + MIGRATION + "'); COMMIT;")
        migrated = True
        fingerprint = queue_fingerprint()
        save('queue-after-migration.json', fingerprint)
        schema = schema_status()
        assert schema['newLoadCandidates'] == 0 and schema['cutoverAudit'] == snapshot['priorCutoverAudit'] + len(snapshot['candidates'])
        assert schema['cutoverAttention'] == len(snapshot['candidates']) and schema['retiredActiveClaims'] == 0
        save('migration-result.json', {'at': core.now(), 'appStopped': True, 'schema': schema})
        with (RELEASE / 'publish.log').open('wb') as output:
            subprocess.run(core.compose(data, 'release') + args, cwd=ROOT, stdout=output,
                           stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
        save('cutover-timing.json', {'secondsThroughVerification': round(time.monotonic() - start, 3)})
    except BaseException:
        if stopped:
            if migrated:
                core.docker('stop', '--time', '30', core.APP, timeout=40)
                if queue_fingerprint() != json.loads((RELEASE / 'queue-after-migration.json').read_text()):
                    # Do not erase any business activity accepted by the new runtime.
                    core.docker('start', core.APP)
                    save('recovery-required.json', {'at': core.now(), 'reason': 'Queue changed after migration; forward recovery required'})
                    raise
                core.sql((RELEASE / 'rollback-migration.sql').read_text())
            with (RELEASE / 'rollback.log').open('wb') as output:
                subprocess.run(core.compose(data, 'rollback') + args, cwd=ROOT, stdout=output,
                               stderr=subprocess.STDOUT, check=True, timeout=60)
            core.ready(data['app']['imageId'])
            save('rollback-result.json', {'at': core.now(), 'previousImageRestored': True, 'migrationReverted': migrated})
        raise


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, lambda signum, _: sys.exit(128 + signum))
    {'capture': capture, 'build': build, 'rehearse': rehearse, 'apply': apply, 'verify': verify}[sys.argv[1]]()

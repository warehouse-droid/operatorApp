"""Deploy the verified direct shipment lifecycle correction using the release gates."""
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('release', SERVER / 'tools/worktree-release-20260925.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE = SERVER / 'test-artifacts/direct-ship-deployment-20260926-v2'
release.SOURCE = release.RELEASE / 'source'
release.IMAGE = 'mbbs-operator-app:direct-ship-lifecycle-20260926-v2'
release.MIGRATION = '230_direct_ship_lifecycle.sql'
base_preflight = release.preflight


def frozen_current(info):
    """Keep this release pinned while separate Special Stock work continues."""
    assert release.runtime_files(release.SOURCE) == info['runtimeFiles'], 'Frozen source changed'
    worktree = release.runtime_files(SERVER)
    drift = sorted(name for name in set(worktree) | set(info['runtimeFiles'])
                   if worktree.get(name) != info['runtimeFiles'].get(name))
    separate_work = {'src/special-stock-netsuite-adapter.js', 'src/special-stock-quantity-adapter.js',
                     'src/special-stock-request-netsuite.js'}
    assert set(drift) <= separate_work, 'Unreviewed worktree drift outside the separate Special Stock changes'
    assert not set(drift) & set(info['runtimeChanges']), 'Direct-shipping source changed after freeze'
    assert {name: release.core.metadata(container) for name, container in release.SERVICES.items()} == info['services'], 'Live services changed'
    assert [release.core.metadata(name) for name in release.DEPENDENCIES] == info['dependencies'], 'Dependency changed'
    release.save('unreleased-worktree-changes.json', {'files': drift, 'reason': 'Separate edits made after this release was frozen'})


def preflight():
    counts = base_preflight()
    acknowledged = release.RELEASE / 'user-confirmed-failed-operation.json'
    exception = ''
    if acknowledged.exists():
        failed = json.loads(acknowledged.read_text())
        assert failed['requestId'] == 62 and re.fullmatch(r'[0-9a-f]{32}', failed['fingerprint'])
        exception = " AND NOT (request_id=62 AND " + operation_fingerprint_sql() + "='" + failed['fingerprint'] + "')"
    counts.update(json.loads(release.sql("""SELECT json_build_object(
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE (sales_order_operation_status='creating' OR purchase_order_operation_status='creating')""" + exception + """),
      'quantityApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying'),
      'netSuiteRequests',(SELECT count(*) FROM netsuite_request_queue WHERE expires_at>clock_timestamp()));""")))
    release.save('preflight.json', {'at': release.now(), **counts})
    return counts


def operation_fingerprint_sql():
    return "md5(to_jsonb(sales_special_stock_cases)::text)"


def acknowledge_failed_operation():
    # The user confirmed this submission failed and is being fixed in another
    # thread. Exclude only this exact unchanged record; a retry changes its hash.
    row = json.loads(release.sql("SELECT json_build_object('requestId',request_id,'fingerprint'," + operation_fingerprint_sql() + """,
      'updatedAt',updated_at) FROM sales_special_stock_cases WHERE request_id=62 AND sales_order_operation_status='linked'
      AND purchase_order_operation_status='creating'
      AND updated_at='2026-09-26T03:03:29.160717+00:00'::timestamptz;""") or 'null')
    assert row, 'The failed attempt changed; do not exempt a new retry'
    release.save('user-confirmed-failed-operation.json', {**row, 'userStatement': 'failed, i am fixing it in another thread', 'at': release.now()})
    release.emit({'failedAttemptPreserved': row['requestId'], 'newRetriesRemainGuarded': True})


def preview():
    migration = (release.SOURCE / 'migrations' / release.MIGRATION).read_text()
    predicate = migration.split('AS $$', 1)[1].split('$$;', 1)[0].strip()
    recovery = migration.split('INSERT INTO dispatch_direct_ship_completion_corrections(completion_event_id,order_ref,reason,evidence)\n', 1)[1].split('ON CONFLICT DO NOTHING;', 1)[0]
    recovery = re.sub(r'\bdependency\b', 'candidate_dependency', recovery)
    recovery = recovery.replace('dispatch_direct_to_has_residual(candidate_dependency.transfer_order_id)',
                                '(' + predicate.replace('raw_to_id', 'candidate_dependency.transfer_order_id') + ')')
    result = json.loads(release.sql("BEGIN READ ONLY; SET LOCAL statement_timeout='20s';\nWITH candidates AS (" + recovery + ") SELECT coalesce(jsonb_agg(row_to_json(candidates)), '[]'::jsonb) FROM candidates; COMMIT;"))
    release.save('recovery-preview.json', result)
    release.emit({'partialTransferCorrections': len(result), 'orderRefs': [row['order_ref'] for row in result]})
    return result


def build():
    info = release.state()
    release.current(info)
    for service, row in info['services'].items():
        release.docker('tag', row['imageId'], 'mbbs-operator-app:rollback-direct-ship-20260926-v2-' + service)
    with (release.RELEASE / 'build.log').open('wb') as output:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--pull=false', '-t', release.IMAGE, str(release.SOURCE)],
                       stdout=output, stderr=subprocess.STDOUT, check=True)
    info['imageId'] = release.docker('image', 'inspect', '--format', '{{.Id}}', release.IMAGE).decode().strip()
    release.save('manifest.json', info)
    assert release.image_hashes(release.IMAGE) == info['runtimeFiles']
    release.emit({'built': True, 'imageId': info['imageId'], 'filesVerified': len(info['runtimeFiles'])})


def migrate():
    info = release.state()
    applied = set(json.loads(release.sql('SELECT json_agg(filename) FROM schema_migrations;')))
    pending = sorted(set(path.name for path in (release.SOURCE / 'migrations').glob('*.sql')) - applied)
    if not pending and release.MIGRATION in applied:
        return
    assert pending == [release.MIGRATION], 'Migration inventory changed'
    assert info['sourceTreeHash'] == release.digest(json.dumps(release.runtime_files(release.SOURCE), sort_keys=True).encode())
    preview()
    sql = (release.SOURCE / 'migrations' / release.MIGRATION).read_text()
    output = release.sql("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';\n" + sql +
                         "\nINSERT INTO schema_migrations(filename) VALUES ('" + release.MIGRATION + "'); COMMIT;")
    (release.RELEASE / 'migration.log').write_text(output)
    release.emit({'migrationApplied': release.MIGRATION})


def live_probe():
    assert_candidate_running()
    expected = [row['id'] for row in json.loads((release.RELEASE / 'recovery-preview.json').read_text())]
    script = (SERVER / 'tools/direct-ship-live.mjs').read_text().replace('EXPECTED_CORRECTIONS', json.dumps(expected)).encode()
    output = release.docker('exec', '-i', release.SERVICES['app'], 'node', '--input-type=module', input=script)
    result = json.loads(output)
    release.save('live-probe.json', result)
    release.emit(result)


def refresh_catalog():
    assert_candidate_running()
    script = (SERVER / 'tools/direct-ship-refresh.mjs').read_text().replace('from "../src/', 'from "./src/')
    script += '\ntry {process.stdout.write(JSON.stringify(await refreshDirectShipCatalog())+"\\n");} finally {await closeDb();}\n'
    output = release.docker('exec', '-i', release.SERVICES['app'], 'node', '--input-type=module', input=script.encode())
    result = json.loads(output)
    release.save('catalog-refresh.json', result)
    release.emit(result)


def recover_completions():
    assert_candidate_running()
    script = (SERVER / 'tools/direct-ship-recover.mjs').read_text().replace('from "../src/', 'from "./src/')
    script += '\ntry {process.stdout.write(JSON.stringify(await recoverDirectShipCompletions({apply:true}))+"\\n");} finally {await closeDb();}\n'
    output = release.docker('exec', '-i', release.SERVICES['app'], 'node', '--input-type=module', input=script.encode())
    result = json.loads(output)
    release.save('completion-recovery.json', result)
    release.emit({'recoveredCompletions': len(result), 'orderRefs': [row['order_ref'] for row in result]})


def assert_candidate_running():
    info = release.state()
    for container in release.SERVICES.values():
        assert release.core.metadata(container)['imageId'] == info['imageId'], 'Candidate must be deployed before recovery'


release.migrate = migrate
release.current = frozen_current
release.preflight = preflight
if __name__ == '__main__':
    __import__('os').umask(0o077)
    action = sys.argv[1]
    actions = {'prepare': release.prepare, 'build': build, 'preview': preview,
               'backup': release.backup, 'preflight': lambda: release.emit(release.preflight()),
               'acknowledge-failed-operation': acknowledge_failed_operation,
               'apply': release.apply, 'verify': release.verify, 'recover-completions': recover_completions,
               'refresh-catalog': refresh_catalog, 'live-probe': live_probe}
    actions[action]()

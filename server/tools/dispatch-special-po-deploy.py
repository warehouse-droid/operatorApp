"""Deploy the verified special PO lifecycle correction using the release gates."""
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
release.RELEASE = SERVER / 'test-artifacts/dispatch-special-po-deployment-20260925'
release.SOURCE = release.RELEASE / 'source'
release.IMAGE = 'mbbs-operator-app:special-po-lifecycle-20260925-v1'
release.MIGRATION = '213_dispatch_special_po_link_coverage.sql'


def preview():
    migration = (release.SOURCE / 'migrations' / release.MIGRATION).read_text()
    predicate = migration.split('AS $$', 1)[1].split('$$;', 1)[0].strip()
    recovery = migration[migration.index('WITH qualifying_po AS ('):migration.index('INSERT INTO dispatch_order_completion_events')]
    recovery = re.sub(r'\ballocation\b', 'candidate_allocation', recovery)
    recovery = recovery.replace('dispatch_po_link_fully_covers(candidate_allocation.po_order_id)',
                                '(' + predicate.replace('raw_po_order_id', 'candidate_allocation.po_order_id') + ')')
    result = json.loads(release.sql("BEGIN READ ONLY; SET LOCAL statement_timeout='20s';\n" + recovery + """
      SELECT coalesce(jsonb_agg(jsonb_build_object('poId', po_order_id, 'poRef', po_order_ref,
        'completedAt', dispatch_completed_at, 'driverJob', completion_evidence_id,
        'sourceCompletionEventId', completion_event_id) ORDER BY po_order_id), '[]'::jsonb)
      FROM recovered; COMMIT;
    """))
    release.save('recovery-preview.json', result)
    release.emit({'recoveryCandidates': result})
    return result


def build():
    info = release.state()
    release.current(info)
    for service, row in info['services'].items():
        release.docker('tag', row['imageId'], 'mbbs-operator-app:rollback-special-po-20260925-' + service)
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
    script = (SERVER / 'tools/dispatch-special-po-live.mjs').read_bytes()
    output = release.docker('exec', '-i', release.SERVICES['app'], 'node', '--input-type=module', input=script)
    result = json.loads(output)
    release.save('live-probe.json', result)
    release.emit(result)


release.migrate = migrate
if __name__ == '__main__':
    action = sys.argv[1]
    actions = {'prepare': release.prepare, 'build': build, 'preview': preview,
               'backup': release.backup, 'preflight': release.preflight,
               'apply': release.apply, 'verify': release.verify, 'live-probe': live_probe}
    actions[action]()

"""Apply the tested database-only split fix and retain a bounded recovery audit."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
AUDIT = ROOT / 'server/artifacts/pob04054-ir-20261029'
MIGRATION = ROOT / 'server/migrations/324_grouped_split_allocation_execution.sql'
RECOVERY = ROOT / 'server/tools/pob04054-ir-recover.mjs'
APP = 'mbbs-operator-app-app-1'
DB = 'mbbs-operator-app-db-1'


def command(args, body=None):
    return subprocess.run(args, input=body, text=True, capture_output=True, check=True).stdout.strip()


def sql(statement):
    return command(['docker', 'exec', '-i', DB, 'psql', '-U', 'mbbs_app', '-d', 'mbbs_yard',
                    '-XAt', '-v', 'ON_ERROR_STOP=1'], statement)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def prepare():
    AUDIT.mkdir(parents=True, exist_ok=False)
    before = sql("SELECT pg_get_functiondef('dispatch_project_so_po_allocation_execution()'::regprocedure)")
    assert 'dispatch_record_so_po_allocation_execution' not in before
    assert "NEW.order_refs" in before
    assert sql("SELECT count(*) FROM schema_migrations WHERE filename='324_grouped_split_allocation_execution.sql'") == '0'
    (AUDIT / 'rollback-function.sql').write_text(before + '\n')
    (AUDIT / MIGRATION.name).write_bytes(MIGRATION.read_bytes())
    state = {'authorization': 'User requested: please perform fix; target POB04054 IR for completed SOA10208 / SOA10209-S1.',
             'scope': 'Database function migration only; no application restart or unrelated source deployment.',
             'image': command(['docker', 'inspect', '--format', '{{.Config.Image}} {{.Image}} {{.State.StartedAt}}', APP]),
             'migrationSha256': digest(MIGRATION), 'recoverySha256': digest(RECOVERY),
             'beforeFunctionMd5': sql("SELECT md5(prosrc) FROM pg_proc WHERE oid='dispatch_project_so_po_allocation_execution()'::regprocedure")}
    (AUDIT / 'release.json').write_text(json.dumps(state, indent=2) + '\n')
    print(json.dumps(state))


def apply():
    state = json.loads((AUDIT / 'release.json').read_text())
    assert digest(MIGRATION) == state['migrationSha256']
    assert sql("SELECT md5(prosrc) FROM pg_proc WHERE oid='dispatch_project_so_po_allocation_execution()'::regprocedure") == state['beforeFunctionMd5']
    statement = "BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';\n"
    statement += "SELECT pg_advisory_xact_lock(hashtext('pob04054-ir-migration'));\n"
    statement += "DO $$ BEGIN IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='dispatch_project_so_po_allocation_execution()'::regprocedure) <> '" + state['beforeFunctionMd5'] + "' THEN RAISE EXCEPTION 'Execution projector changed'; END IF; END $$;\n"
    statement += MIGRATION.read_text()
    statement += "\nINSERT INTO schema_migrations(filename) VALUES('324_grouped_split_allocation_execution.sql'); COMMIT;"
    result = sql(statement)
    (AUDIT / 'migration-result.txt').write_text(result + '\n')
    print(result)


def recovery(mode):
    state = json.loads((AUDIT / 'release.json').read_text())
    assert digest(RECOVERY) == state['recoverySha256'], 'Recovery source changed after review'
    result = subprocess.run(['docker', 'exec', '-e', f'POB04054_MODE={mode}', '-i', APP,
                             'node', '--input-type=module'], input=RECOVERY.read_text(), text=True, capture_output=True)
    # Operational audit, not disposable test output. Preserve failed recovery evidence.
    filename = AUDIT / f'{mode}-{len(list(AUDIT.glob(mode + "-*.log"))) + 1}.log'
    filename.write_text(result.stdout + result.stderr)
    print(result.stdout, end='')
    if result.stderr:
        print(result.stderr, file=sys.stderr, end='')
    if result.returncode:
        raise SystemExit(result.returncode)


if __name__ == '__main__':
    mode = sys.argv[1]
    if mode == 'prepare':
        prepare()
    elif mode == 'apply':
        apply()
    elif mode in ('inspect', 'recover', 'verify'):
        recovery(mode)
    else:
        raise SystemExit('Expected prepare, apply, inspect, recover, or verify')

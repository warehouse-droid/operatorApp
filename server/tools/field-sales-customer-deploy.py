"""Scoped releases for the approved Field Sales customer/quote workflow."""
import argparse, hashlib, importlib.util, json, os, shutil, subprocess
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('stage', choices=['uuid', 'customer'])
parser.add_argument('action', choices=['prepare', 'build', 'apply', 'verify'])
args = parser.parse_args()
spec = importlib.util.spec_from_file_location('memo_release', SERVER / 'tools/field-sales-quote-memo-deploy.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
CHECKS = SERVER / 'test-artifacts/field-sales/customer-quotes'
REPORT = CHECKS / (args.stage + '-checks.json')
report = json.loads(REPORT.read_text())
FILES = sorted(report['source'])
RELEASE = SERVER / ('test-artifacts/field-sales/' + args.stage + '-deployment-20260921')
IMAGE = 'mbbs-operator-app:field-sales-' + args.stage + '-20260921-v1'
ROLLBACK = 'mbbs-operator-app:rollback-field-sales-' + args.stage + '-20260921-v1'
EXISTING = report['existing']
for target in [module, module.release, module.core]:
    target.RELEASE, target.IMAGE, target.ROLLBACK, target.FILES = RELEASE, IMAGE, ROLLBACK, FILES
    target.EXISTING = EXISTING

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def gate():
    current = json.loads(REPORT.read_text())
    assert current['passed'], 'Verification is incomplete'
    for name, sha in current['source'].items():
        assert digest(SERVER / name) == sha, 'Verified source changed: ' + name
    return current

module.source_gate = gate

def prepare():
    checks = gate()
    RELEASE.mkdir(parents=True, exist_ok=False)
    state = {'app': module.core.metadata(module.APP), 'dependencies': [module.core.metadata(n) for n in module.DEPENDENCIES]}
    for name in EXISTING:
        target = RELEASE / 'baseline' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        module.docker('cp', module.APP + ':/app/' + name, str(target))
        assert digest(target) == checks['baseline'][name], 'Live Field Sales file changed: ' + name
    for folder in ['candidate', 'stage']:
        for name in FILES:
            target = RELEASE / folder / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(SERVER / name, target)
    state.update({'before': {n: digest(RELEASE / 'baseline' / n) for n in EXISTING},
                  'after': checks['source'], 'workspace': checks['source'], 'checks': checks,
                  'scope': 'Field Sales ' + args.stage})
    module.save('manifest.json', state)
    for name, image in [('release', IMAGE), ('rollback', ROLLBACK)]:
        (RELEASE / ('compose.' + name + '.yml')).write_text('services:\n  app:\n    image: ' + image + '\n    pull_policy: never\n')
    print(json.dumps({'prepared': True, 'files': len(FILES), 'baseImage': state['app']['imageId']}))

def backup_and_migrate():
    gate()
    backup = RELEASE / 'database-before.dump'
    assert not backup.exists(), 'Preserve the existing pre-migration backup'
    with backup.open('wb') as output:
        subprocess.run(['sudo', '-n', 'docker', 'exec', module.release.DB, 'pg_dump', '-U', 'mbbs_app', '-d', 'mbbs_yard', '--format=custom', '--table=field_sales_*', '--table=schema_migrations'], stdout=output, check=True)
    with backup.open('rb') as source:
        toc = module.docker('exec', '-i', module.release.DB, 'pg_restore', '--list', stdin=source)
    assert b'field_sales_quotes' in toc and b'schema_migrations' in toc
    module.save('backup.json', {'bytes': backup.stat().st_size, 'sha256': digest(backup), 'validated': True, 'scope': 'Field Sales tables and migration ledger'})
    (RELEASE / 'database-before.dump.toc').write_bytes(toc)
    migration = '213_field_sales_customer_quotes.sql'
    assert module.core.database("SELECT count(*) FROM schema_migrations WHERE filename='" + migration + "';").strip() == '0'
    sql = (RELEASE / 'candidate/migrations' / migration).read_text()
    output = module.core.database("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='45s';\n" + sql + "\nINSERT INTO schema_migrations(filename) VALUES ('" + migration + "'); COMMIT;")
    (RELEASE / 'migration.log').write_text(output)

original_verify = module.verify

def customer_verify():
    original_verify()
    assert module.core.database("SELECT count(*) FROM schema_migrations WHERE filename='213_field_sales_customer_quotes.sql';").strip() == '1'
    assert module.core.database("SELECT data->>'salesOrderPostingEnabled' FROM field_sales_settings;").strip() == 'false'
    result = json.loads((RELEASE / 'deployment-result.json').read_text())
    result.update({'migration': '213_field_sales_customer_quotes.sql', 'salesOrderPostingEnabled': False})
    module.save('deployment-result.json', result)

os.umask(0o077)
if args.stage == 'customer':
    module.verify = customer_verify
    if args.action == 'apply':
        state = module.core.manifest()
        gate()
        module.core.current(state)
        module.release.config_gate(state)
        assert not any(module.release.preflight().values()), 'Wait for an idle cutover'
        backup_and_migrate()

os.umask(0o077)
if args.action == 'prepare': prepare()
else: getattr(module, args.action)()

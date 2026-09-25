"""Deploy the verified Field Sales Trade catalog and quote UI over the active image."""
import argparse
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
RELEASE = SERVER / 'test-artifacts/field-sales/trade-deployment-20260919'
CHECKS = SERVER / 'test-artifacts/field-sales/trade'
IMAGE = 'mbbs-operator-app:field-sales-trade-20260919-v5'
ROLLBACK = 'mbbs-operator-app:rollback-field-sales-trade-20260919-v5'
FILES = json.loads((SERVER / 'tools/field-sales-trade-files.json').read_text())
EXISTING = [name for name in FILES if (SERVER / 'test-artifacts/field-sales/trade-baseline' / name).exists()]
MIGRATION = '211_field_sales_trade.sql'
spec = importlib.util.spec_from_file_location('field_sales_previous', SERVER / 'tools/field-sales-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
core = release.core
for module in [release, core]:
    module.RELEASE, module.IMAGE, module.ROLLBACK, module.FILES = RELEASE, IMAGE, ROLLBACK, FILES
core.EXISTING = EXISTING
APP, DEPENDENCIES = release.APP, release.DEPENDENCIES
docker, save = core.docker, core.save


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_gate():
    report = json.loads((CHECKS / 'checks.json').read_text())
    assert report['passed'] and report['tests'] == 92
    for name, sha in report['source'].items():
        assert digest(SERVER / name) == sha, 'Verified source changed: ' + name
    probe = json.loads((CHECKS / 'live-reader-probe.json').read_text())
    assert probe['passed'] and len(probe['results']) == 3
    return report


def prepare():
    report = source_gate()
    RELEASE.mkdir(parents=True, exist_ok=False)
    state = {'app': core.metadata(APP), 'dependencies': [core.metadata(n) for n in DEPENDENCIES]}
    baseline = RELEASE / 'baseline'
    baseline.mkdir()
    for name in EXISTING:
        target = baseline / name
        target.parent.mkdir(parents=True, exist_ok=True)
        docker('cp', APP + ':/app/' + name, str(target))
        original = SERVER / 'test-artifacts/field-sales/trade-baseline' / name
        assert digest(original) == digest(target), 'Live source changed since work began: ' + name
    assert core.metadata(APP) == state['app'], 'App changed during capture'
    for folder in ['candidate', 'stage']:
        for name in FILES:
            target = RELEASE / folder / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(SERVER / name, target)
    state.update({'before': {name: digest(baseline / name) for name in EXISTING},
                  'after': {name: digest(SERVER / name) for name in FILES},
                  'workspace': {name: digest(SERVER / name) for name in FILES},
                  'checks': report, 'scope': 'Field Sales autocomplete, Trade policies, MBR support and additive migration 211'})
    save('manifest.json', state)
    for name, image in [('release', IMAGE), ('rollback', ROLLBACK)]:
        (RELEASE / f'compose.{name}.yml').write_text(f'services:\n  app:\n    image: {image}\n    pull_policy: never\n')
    print(json.dumps({'prepared': True, 'baseImage': state['app']['imageId'], 'files': FILES}), flush=True)


def build():
    source_gate()
    core.build()


def verify():
    state = core.manifest()
    core.ready(state['candidateImageId'])
    after = core.metadata(APP)
    assert after['configuration'] == state['app']['configuration'], 'Service configuration changed'
    assert [core.metadata(n) for n in DEPENDENCIES] == state['dependencies'], 'Another service changed'
    actual = docker('exec', APP, 'sha256sum', *['/app/' + name for name in FILES]).decode().splitlines()
    assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in actual} == state['after']
    script = """import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const expected=EXPECTED;let checks=0;
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
 const health=await fetch(base+'/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);checks++;
 for(const [file,sha] of Object.entries(expected)){const r=await fetch(base+'/'+file.replace(/^public\\//,''),{headers:{'Cache-Control':'no-cache'}});assert.equal(r.status,200);assert.equal(createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex'),sha);checks++;}
 assert.equal((await fetch(base+'/api/field-sales/jobsites')).status,401);checks++;
 assert.equal((await fetch(base+'/field-sales/')).status,200);checks++;
}console.log(JSON.stringify({passed:true,checks}));
""".replace('EXPECTED', json.dumps({name: sha for name, sha in state['after'].items() if name.startswith('public/')}))
    checks = json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', input=script.encode()))
    assert core.database("SELECT count(*) FROM schema_migrations WHERE filename='211_field_sales_trade.sql';").strip() == '1'
    catalog = json.loads(core.database("SELECT json_agg(t) FROM (SELECT company,count(*) AS items,count(unit_rate) AS priced FROM field_sales_catalog WHERE active GROUP BY company ORDER BY company) t;"))
    assert len(catalog) == 3 and all(int(c['items']) > 0 for c in catalog)
    assert core.database("SELECT data->>'postingEnabled' FROM field_sales_settings;").strip() == 'false'
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'image': IMAGE, 'imageId': after['imageId'], 'configurationPreserved': True,
              'otherServicesUnchanged': True, 'runtimeFilesVerified': len(FILES), 'liveChecks': checks, 'catalog': catalog, 'postingEnabled': False}
    save('deployment-result.json', result)
    print(json.dumps(result), flush=True)


def backup_and_migrate():
    backup = RELEASE / 'database-before.dump'
    with backup.open('wb') as output:
        subprocess.run(['sudo','-n','docker','exec',release.DB,'pg_dump','-U','mbbs_app','-d','mbbs_yard','--format=custom'],stdout=output,check=True)
    with backup.open('rb') as source:
        toc = docker('exec','-i',release.DB,'pg_restore','--list',stdin=source)
    assert b'field_sales_quotes' in toc and b'schema_migrations' in toc
    save('backup.json',{'bytes':backup.stat().st_size,'sha256':digest(backup),'validated':True})
    (RELEASE / 'database-before.dump.toc').write_bytes(toc)
    assert core.database("SELECT count(*) FROM schema_migrations WHERE filename='211_field_sales_trade.sql';").strip() == '0'
    sql = (RELEASE / 'candidate/migrations' / MIGRATION).read_text()
    output = core.database("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='45s';\n" + sql + "\nINSERT INTO schema_migrations(filename) VALUES ('211_field_sales_trade.sql'); COMMIT;")
    (RELEASE / 'migration.log').write_text(output)


def activate():
    script = (SERVER / 'tools/field-sales-trade-activate.mjs').read_text().replace("'../src/", "'./src/")
    result = json.loads(docker('exec','-i',APP,'node','--input-type=module',input=script.encode()))
    assert result['passed']
    save('activation.json',result)
    print(json.dumps(result),flush=True)


def apply():
    source_gate()
    state = core.manifest()
    core.current(state)
    assert docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip() == state['candidateImageId']
    packaged = json.loads((RELEASE / 'candidate-checks.json').read_text())
    assert packaged['passed'] and packaged['imageId'] == state['candidateImageId']
    release.config_gate(state)
    assert not any(release.preflight().values()), 'Wait for an idle cutover'
    command = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
    backup_and_migrate()
    try:
        with (RELEASE / 'cutover.log').open('wb') as output:
            subprocess.run(core.compose(state, 'compose.release.yml') + command, cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=100)
        core.ready(state['candidateImageId'])
        activate()
        verify()
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(core.compose(state, 'compose.rollback.yml') + command, cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=100)
        core.ready(state['app']['imageId'])
        save('rolled-back.json', {'at': datetime.datetime.now(datetime.timezone.utc).isoformat()})
        raise


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['prepare', 'build', 'apply', 'verify'])
    globals()[parser.parse_args().action]()

"""Deploy the tested child-PO changes over the exact captured live image."""
import datetime
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('child_po_release', SERVER / 'tools/dispatch-source-save-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE = SERVER / 'deployments/special-child-po-20261028'
release.FILES = json.loads((release.RELEASE / 'files.json').read_text())
release.IMAGE = 'mbbs-operator-app:special-child-po-20261028'
release.ROLLBACK = 'mbbs-operator-app:rollback-special-child-po-20261028'
MIGRATION = '321_special_child_po.sql'


def prepare():
    evidence = json.loads((release.RELEASE / 'final-result.json').read_text())
    proof = json.loads((release.RELEASE / 'tested-inputs.json').read_text())
    assert evidence['passed'], 'Fresh passing isolated verification required'
    assert all(proof['files'][name] == value for name, value in evidence['hashes'].items()), 'Verified sources changed'
    info = {'app': release.core.metadata(release.APP),
            'dependencies': [release.core.metadata(name) for name in release.DEPENDENCIES], 'files': proof['files']}
    assert info['app']['imageId'] == proof['baseImage'], 'Live app changed; rerun isolated verification'
    release.current(info)
    release.docker('tag', info['app']['imageId'], release.ROLLBACK)
    build_base = info['app']['imageId']
    initial_deployment = release.RELEASE / 'initial-deployment-result.json'
    if initial_deployment.exists() and json.loads(initial_deployment.read_text())['imageId'] == build_base:
        # Rebuild this same scoped release over its original parent, avoiding a
        # second patch layer. Any intervening unrelated image uses its own base.
        build_base = json.loads((release.RELEASE / 'initial-manifest.json').read_text())['app']['imageId']
    build_tag = 'mbbs-operator-app:special-child-po-build-base-20261028'
    release.docker('tag', build_base, build_tag)
    info['buildBaseImage'] = build_base
    stage = release.RELEASE / 'candidate'
    context = release.RELEASE / 'image-context'
    if context.exists():
        shutil.rmtree(context)
    for name in release.FILES:
        target = context / 'payload' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(stage / name, target)
    # The live image already has many release layers; add this scoped patch in one.
    (context / 'Dockerfile').write_text('FROM ' + build_tag + '\nCOPY --chown=node:node payload/ /app/\n')
    (stage / 'Dockerfile').unlink(missing_ok=True)
    with (release.RELEASE / 'build.log').open('wb') as output:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network=none', '--pull=false', '-t', release.IMAGE, str(context)],
                       stdout=output, stderr=subprocess.STDOUT, check=True)
    shutil.rmtree(context)
    info['imageId'] = release.docker('image', 'inspect', '--format', '{{.Id}}', release.IMAGE).decode().strip()
    for name, tag in [('compose.release.yml', release.IMAGE), ('compose.rollback.yml', release.ROLLBACK)]:
        (release.RELEASE / name).write_text('services:\n  app:\n    image: ' + tag + '\n')
    release.save('manifest.json', info)
    release.save('verified.json', {**proof, 'passed': True})
    release.current(info)
    print(json.dumps({'prepared': True, 'imageId': info['imageId'], 'files': len(release.FILES)}))


def db(sql):
    return release.docker('exec', '-i', 'mbbs-operator-app-db-1', 'psql', '-U', 'mbbs_app', '-d', 'mbbs_yard',
                          '-XAt', '-v', 'ON_ERROR_STOP=1', input=sql.encode()).decode()


def migrate():
    info = release.state()
    release.current(info)
    if db("SELECT filename FROM schema_migrations WHERE filename='" + MIGRATION + "';").strip():
        print(json.dumps({'migration': MIGRATION, 'alreadyApplied': True}))
        return
    views = db("SELECT json_object_agg(viewname,definition) FROM pg_views WHERE schemaname='public' AND viewname IN ('special_stock_purchase_dispatch_state','special_stock_completion_evidence');")
    release.save('views-before.json', json.loads(views))
    sql = (release.RELEASE / 'candidate/migrations' / MIGRATION).read_text()
    db("BEGIN; SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s';\n" + sql
       + "\nINSERT INTO schema_migrations(filename) VALUES ('" + MIGRATION + "'); COMMIT;")
    result = {'migration': MIGRATION, 'applied': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    release.save('migration-result.json', result)
    print(json.dumps(result))


def verify():
    info = release.state()
    release.core.ready(info['imageId'])
    assert release.core.metadata(release.APP)['configuration'] == info['app']['configuration'], 'App configuration changed'
    assert [release.core.metadata(name) for name in release.DEPENDENCIES] == info['dependencies'], 'Dependency changed'
    rows = release.docker('exec', release.APP, 'sha256sum', *['/app/' + name for name in release.FILES]).decode().splitlines()
    assert {row.split()[1].removeprefix('/app/'): row.split()[0] for row in rows} == info['files']
    script = """
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
 const response=await fetch(base+'/health');assert.equal(response.status,200);assert.equal((await response.json()).ok,true);
 for(const [file,expected] of Object.entries(FILES)) {
  const asset=await fetch(base+'/'+file.replace('public/','')+'?v=20261028-child-po');
  assert.equal(asset.status,200);assert.equal(createHash('sha256').update(Buffer.from(await asset.arrayBuffer())).digest('hex'),expected);
 }
 assert.equal((await fetch(base+'/api/scm/special-stock-requests/379/purchase-order/splits')).status,401);
}
console.log(JSON.stringify({health:200,assets:'verified',anonymousAccess:401}));
"""
    assets = {file: digest for file, digest in info['files'].items() if file.startswith('public/')}
    result = json.loads(release.docker('exec', '-i', release.APP, 'node', '--input-type=module',
                                     input=script.replace('FILES', json.dumps(assets)).encode()))
    result.update({'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                   'imageId': info['imageId'], 'configurationPreserved': True, 'dependenciesUnchanged': True})
    release.save('deployment-result.json', result)
    print(json.dumps(result))


release.verify = verify
if __name__ == '__main__':
    {'prepare': prepare, 'migrate': migrate, 'apply': release.apply, 'verify': verify}[sys.argv[1]]()

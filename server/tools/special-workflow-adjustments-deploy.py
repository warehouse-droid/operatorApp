"""Publish the scoped discount/PALLET change over the latest application UI."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

spec = importlib.util.spec_from_file_location('release', Path(__file__).with_name('special-workflow-native-deploy.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.BASE_IMAGE = 'sha256:5e0193fa3e48cd7000346d266e4b6899a1237f5f6fd483c66107d2c8286f0abf'
WORKER_BASE = 'sha256:91df9f618ae177e5ae3eaf89b8369a48b7d8e3c24b7b422dc2ba80061ce40022'
release.RELEASE = release.SERVER / 'test-artifacts/special-workflow-adjustments-release-20260926'
release.EVIDENCE = release.SERVER / 'test-artifacts/special-workflow-review/adjustments'
release.FILES = json.loads((release.EVIDENCE / 'runtime-files.json').read_text())
release.IMAGE = 'mbbs-operator-app:special-adjustments-20260926'
release.ROLLBACK = 'mbbs-operator-app:rollback-special-adjustments-20260926'


def business_hashes():
    sql = """SELECT json_build_object('requestRef',r.request_ref,'businessHash',md5(jsonb_build_object(
      'request',to_jsonb(r),'case',(SELECT to_jsonb(c) FROM sales_special_stock_cases c WHERE c.request_id=r.id),
      'lines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM sales_special_stock_lines l WHERE l.request_id=r.id),
      'orderLines',(SELECT jsonb_agg(to_jsonb(o)-'native_discount_percent' ORDER BY o.id) FROM sales_special_stock_order_lines o WHERE o.request_id=r.id))::text))
      FROM sales_stock_requests r WHERE r.request_ref IN ('SPREQ-000006','SPREQ-000007') ORDER BY r.id"""
    rows = release.docker('exec', release.DEPENDENCIES[0], 'psql', '-U', 'mbbs_app', '-d', 'mbbs_yard', '-XAt', '-v', 'ON_ERROR_STOP=1', '-c', sql).decode().splitlines()
    result = [json.loads(row) for row in rows]
    assert len(result) == 2
    return result


def prepare():
    os.umask(0o077)
    hashes = release.evidence()
    release.RELEASE.mkdir(mode=0o700, exist_ok=False)
    info = {'files': hashes, 'services': {s: release.core.metadata(c) for s, c in release.SERVICES.items()},
            'dependencies': [release.core.metadata(c) for c in release.DEPENDENCIES], 'businessHashes': business_hashes()}
    assert info['services']['app']['imageId'] == release.BASE_IMAGE
    assert info['services']['webhook-worker']['imageId'] == WORKER_BASE
    for service, container in release.SERVICES.items():
        for file in release.FILES:
            # The worker predates the two public-only UI releases; all backend
            # files must match the captured baseline in both containers.
            if service == 'webhook-worker' and file.startswith('public/'):
                continue
            baseline = release.EVIDENCE / 'baseline' / file
            if baseline.exists():
                assert release.docker('exec', container, 'cat', '/app/' + file) == baseline.read_bytes(), (service, file)
            else:
                release.docker('exec', container, 'test', '!', '-e', '/app/' + file)
    stage = release.RELEASE / 'stage'
    for file in release.FILES:
        target = stage / file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(release.SERVER / file, target)
    release.docker('tag', release.BASE_IMAGE, release.ROLLBACK)
    (stage / 'Dockerfile').write_text('FROM ' + release.ROLLBACK + '\n' + ''.join('COPY --chown=node:node ' + f + ' /app/' + f + '\n' for f in release.FILES))
    with (release.RELEASE / 'build.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', release.IMAGE, str(stage)], stdout=log, stderr=subprocess.STDOUT, check=True)
    info['imageId'] = release.docker('image', 'inspect', '--format', '{{.Id}}', release.IMAGE).decode().strip()
    (release.RELEASE / 'compose.release.yml').write_text('services:\n' + ''.join('  ' + s + ':\n    image: ' + release.IMAGE + '\n' for s in release.SERVICES))
    (release.RELEASE / 'compose.rollback.yml').write_text('services:\n' + ''.join('  ' + s + ':\n    image: ' + metadata['imageId'] + '\n' for s, metadata in info['services'].items()))
    actual = release.docker('run', '--rm', '--network', 'none', '--entrypoint', 'sha256sum', release.IMAGE, *['/app/' + f for f in release.FILES]).decode().splitlines()
    assert {row.split()[1].removeprefix('/app/'): row.split()[0] for row in actual} == hashes
    release.save('manifest.json', info)
    release.current(info)
    release.config_gate(info)
    print(json.dumps({'prepared': True, 'imageId': info['imageId'], 'files': release.FILES}), flush=True)


def migrate(info):
    filename = '233_special_stock_native_discounts.sql'
    sql = (release.SERVER / 'migrations' / filename).read_text()
    assert release.core.digest(sql.encode()) == info['files']['migrations/' + filename]
    script = """import {query,withTransaction,closeDb} from './src/db.js';
try {await withTransaction(async()=>{
 await query("SELECT pg_advisory_xact_lock(hashtextextended('special-native-discount-migration',0))");
 if(!(await query('SELECT filename FROM schema_migrations WHERE filename=$1',[FILENAME])).rowCount){
  await query(SQL);await query('INSERT INTO schema_migrations(filename) VALUES($1)',[FILENAME]);
 }
});console.log(JSON.stringify({migration:FILENAME,ready:true}));}finally{await closeDb();}
""".replace('FILENAME', json.dumps(filename)).replace('SQL', json.dumps(sql))
    result = release.docker('exec', '-i', '-w', '/app', release.SERVICES['app'], 'node', '--input-type=module', '-', input=script.encode())
    release.save('migration-result.json', json.loads(result))


release.migrate = migrate


def apply():
    assert business_hashes() == release.load()['businessHashes'], 'Requests changed since preparation'
    release.apply()
    actual = business_hashes()
    assert actual == release.load()['businessHashes'], 'Business data changed during release; inspect independently'
    release.save('business-data-preserved.json', {'unchanged': True, 'requests': actual, 'liveOrderWrites': 0})


if __name__ == '__main__':
    {'prepare': prepare, 'apply': apply, 'verify': release.verify}[sys.argv[1]]()

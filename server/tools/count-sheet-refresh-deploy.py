"""Build and publish only the reviewed count comparison patch over the live image."""
import datetime
import difflib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('COUNT_REFRESH_RELEASE_DIR','/home/ubuntu/operatorapp-investigations/count-sheet-refresh-20261003/release'))
APP = 'mbbs-operator-app-app-1'
DB = 'mbbs-operator-app-db-1'
DEPENDENCIES = ['mbbs-operator-app-webhook-worker-1', DB, 'mbbs-operator-app-ollama-1']
FILES = json.loads((SERVER/'tools/count-sheet-refresh-files.json').read_text())
IMAGE = 'mbbs-operator-app:packed-count-20261003-v1'
MIGRATION = '260_inventory_count_packed_snapshot.sql'
spec = importlib.util.spec_from_file_location('release_core', SERVER/'tools/operator-display-settings-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
docker, metadata = core.docker, core.metadata
TREE = """import {readdirSync,readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
const files={};function visit(path){for(const entry of readdirSync(path,{withFileTypes:true})){
const child=path+'/'+entry.name;if(entry.isDirectory())visit(child);else if(entry.isFile())
files[child]=createHash('sha256').update(readFileSync(child)).digest('hex');}}
for(const dir of ['src','public','migrations'])visit(dir);
for(const file of ['package.json','package-lock.json'])files[file]=createHash('sha256').update(readFileSync(file)).digest('hex');
console.log(JSON.stringify(files));"""


def save(name, data):
    (OUT/name).write_text(json.dumps(data, indent=2)+'\n')


def state():
    return json.loads((OUT/'manifest.json').read_text())


def database(sql):
    return docker('exec','-i',DB,'psql','-X','-U','mbbs_app','-d','mbbs_yard','-v','ON_ERROR_STOP=1','-At',input=sql.encode()).decode()


def prepare():
    OUT.mkdir(parents=True, exist_ok=True)
    assert not (OUT/'published.json').exists(), 'Already published'
    before = metadata(APP)
    dependencies = {name:metadata(name) for name in DEPENDENCIES}
    tree = json.loads(docker('exec',APP,'node','--input-type=module','-e',TREE))
    expected = dict(tree)
    patches = []
    for file in FILES:
        target = OUT/'stage/overlay'/file
        target.parent.mkdir(parents=True,exist_ok=True)
        prior = (OUT/'patch-base'/file) if (OUT/'patch-base').exists() else SERVER/'test/support/count-sheet-refresh-baseline'/file
        scoped_target = (OUT/'patch-target'/file) if (OUT/'patch-target').exists() else SERVER/file
        if prior.exists():
            live = docker('exec',APP,'cat','/app/'+file).decode()
            original = OUT/'live-before'/file
            original.parent.mkdir(parents=True,exist_ok=True)
            original.write_text(live)
            target.write_text(live)
            if file.endswith('.html') or file=='public/service-worker.js':
                updated = live
                for asset in ['operator.js','operator-inventory.js','control.js','control-count-sheets.js','i18n.js']:
                    updated = re.sub(r'(/'+re.escape(asset)+r'\?v=)[^"\s]+',r'\g<1>20261003-packed-count-v1',updated)
                if file=='public/service-worker.js':
                    updated = re.sub(r'const CACHE_NAME = "[^"]+";', 'const CACHE_NAME = "mbbs-yard-operator-20261003-packed-count-v1";',updated)
                patch = ''.join(difflib.unified_diff(live.splitlines(True),updated.splitlines(True),fromfile='a/'+file,tofile='b/'+file))
            else:
                patch = ''.join(difflib.unified_diff(prior.read_text().splitlines(True),scoped_target.read_text().splitlines(True),fromfile='a/'+file,tofile='b/'+file))
            assert patch, 'No scoped change: '+file
            result = subprocess.run(['patch','--batch','--fuzz=0','-p1','-d',str(OUT/'stage/overlay')],input=patch,text=True,capture_output=True)
            assert result.returncode==0,result.stdout+result.stderr
            for backup in target.parent.glob(target.name+'.orig'):
                backup.unlink()
            patches.append(patch)
        else:
            assert file not in tree,'Added file already exists: '+file
            shutil.copy2(scoped_target,target)
        expected[file] = hashlib.sha256(target.read_bytes()).hexdigest()
    (OUT/'release.patch').write_text(''.join(patches))
    parent = 'mbbs-operator-app:packed-count-parent-'+before['imageId'].removeprefix('sha256:')
    docker('image','tag',before['imageId'],parent)
    (OUT/'stage/Dockerfile').write_text('FROM '+parent+'\nCOPY --chown=node:node overlay/ /app/\n')
    with (OUT/'build.log').open('wb') as log:
        subprocess.run(['sudo','-n','docker','build','--network','none','--pull=false','-t',IMAGE,str(OUT/'stage')],stdout=log,stderr=subprocess.STDOUT,check=True)
    assert json.loads(docker('run','--rm','--network','none','--entrypoint','node',IMAGE,'--input-type=module','-e',TREE))==expected
    for file in FILES:
        if file.endswith('.js'):
            docker('run','--rm','--network','none','--entrypoint','node',IMAGE,'--check',file)
    docker('run','--rm','--network','none','-e','MBBS_ENV_FILE=/nonexistent','-e','NETSUITE_DIRECT_ACCESS_ENABLED=false','-e','NETSUITE_MIRROR_ROLE=disabled',
           '--entrypoint','node',IMAGE,'--input-type=module','-e',"await import('./src/server.js');process.exit(0)")
    for kind,image in [('release',IMAGE),('rollback',before['imageId'])]:
        (OUT/('compose.'+kind+'.yml')).write_text('services:\n  app:\n    image: '+image+'\n')
    assert metadata(APP)==before,'Live app changed during preparation'
    save('manifest.json',{'before':before,'dependencies':dependencies,'image':IMAGE,'imageId':docker('image','inspect','--format','{{.Id}}',IMAGE).decode().strip(),
        'expectedTree':expected,'workspace':{file:hashlib.sha256((SERVER/file).read_bytes()).hexdigest() for file in FILES}})
    print(json.dumps({'prepared':True,'files':len(FILES),'image':IMAGE}),flush=True)


def publish():
    release = state()
    checks = json.loads((OUT/'checks.json').read_text())
    assert checks['passed'] and checks['imageId']==release['imageId'],'Candidate verification required'
    assert metadata(APP)==release['before'],'Live application changed; recapture'
    assert {name:metadata(name) for name in DEPENDENCIES}==release['dependencies']
    assert all(hashlib.sha256((OUT/'stage/overlay'/file).read_bytes()).hexdigest()==release['expectedTree'][file] for file in FILES),'Prepared source changed after verification'
    args = ['sudo','-n','docker','compose','--project-directory',str(SERVER.parent),'--env-file',str(SERVER.parent/'docker/env/.env')]
    for config in release['before']['configFiles'].split(','):
        args += ['-f',config]
    resolved = json.loads(subprocess.check_output(args+['-f',str(OUT/'compose.release.yml'),'config','--format','json']))['services']['app']
    image_config = json.loads(docker('image','inspect',IMAGE))[0]['Config']
    runtime_config = json.loads(docker('inspect',APP))[0]['Config']
    expected_env = dict(entry.split('=',1) for entry in image_config['Env'])
    expected_env.update({key:str(value) for key,value in resolved.get('environment',{}).items()})
    assert expected_env==dict(entry.split('=',1) for entry in runtime_config['Env']),'Compose would change environment'
    for name,options in [('schema-before.dump',['--schema-only']),('count-sheets-before.dump',['--table=public.inventory_count_sheet_counts','--table=public.inventory_count_sheets','--table=public.inventory_count_sheet_events'])]:
        with (OUT/name).open('wb') as log:
            subprocess.run(['sudo','-n','docker','exec',DB,'pg_dump','-U','mbbs_app','-d','mbbs_yard','--format=custom',*options],stdout=log,check=True)
        with (OUT/name).open('rb') as source:
            toc=docker('exec','-i',DB,'pg_restore','--list',stdin=source)
        assert b'inventory_count_sheet' in toc
    sql=(OUT/'stage/overlay/migrations'/MIGRATION).read_text()
    assert database("SELECT count(*) FROM schema_migrations WHERE filename='"+MIGRATION+"';").strip()=='0'
    (OUT/'migration-rehearsal.log').write_text(database("BEGIN; SET LOCAL lock_timeout='5s';\n"+sql+'\nROLLBACK;'))
    (OUT/'migration.log').write_text(database("BEGIN; SET LOCAL lock_timeout='5s';\n"+sql+"\nINSERT INTO schema_migrations(filename) VALUES('"+MIGRATION+"'); COMMIT;"))
    try:
        subprocess.run(args+['-f',str(OUT/'compose.release.yml'),'up','-d','--no-deps','--no-build','app'],check=True)
        core.ready(release['imageId'])
        after=metadata(APP)
        assert after['configuration']==release['before']['configuration']
        assert {name:metadata(name) for name in DEPENDENCIES}==release['dependencies']
        assert json.loads(docker('exec',APP,'node','--input-type=module','-e',TREE))==release['expectedTree']
        public={file:digest for file,digest in release['expectedTree'].items() if file in FILES and file.startswith('public/')}
        probe="""import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
        for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
          for(const [file,hash] of Object.entries(FILES)) {const r=await fetch(base+'/'+file.replace('public/','')+'?v=20261003-packed-count-v1');assert.equal(r.status,200);assert.equal(createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex'),hash);}
          assert.equal((await fetch(base+'/api/count-sheets/3')).status,401);
          assert.equal((await fetch(base+'/api/cycle-count/draft')).status,401);
        }console.log(JSON.stringify({publicAndLocalAssets:true,anonymousApis:401}));""".replace('FILES',json.dumps(public))
        result=json.loads(docker('exec','-i',APP,'node','--input-type=module',input=probe.encode()))
        save('published.json',{'published':True,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'imageId':after['imageId'],'configurationPreserved':True,'dependenciesUnchanged':True,**result})
        print(json.dumps({'published':True,**result}),flush=True)
    except Exception:
        subprocess.run(args+['-f',str(OUT/'compose.rollback.yml'),'up','-d','--no-deps','--no-build','app'],check=True)
        core.ready(release['before']['imageId'])
        save('rollback.json',{'rolledBack':True,'additiveMigrationRetained':True})
        raise


if __name__=='__main__':
    {'prepare':prepare,'publish':publish}[sys.argv[1]]()

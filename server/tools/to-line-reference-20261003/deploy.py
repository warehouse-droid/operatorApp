"""Prepare a reviewed app-image overlay; preserve the running service configuration."""
import hashlib,json,pathlib,shutil,subprocess,sys

root=pathlib.Path(__file__).resolve().parents[2]
evidence=root/'test-artifacts/to-line-reference-20261003'
backup=pathlib.Path('/home/ubuntu/operatorapp-investigations/to-line-reference-20261003')
release=backup/'release';release.mkdir(exist_ok=True)
files=json.loads((root/'tools/to-line-reference-20261003/deployment-files.json').read_text())
before=json.loads((backup/'app-current/container.private.json').read_text());before=before[0] if isinstance(before,list) else before
image='mbbs-operator-app:to-background-posting-20261003-v1'
base_image='mbbs-operator-app:to-background-base-'+before['Image'].split(':')[1][:12]
def run(*args,**kwargs):return subprocess.check_output(args,text=True,**kwargs).strip()
def inspect():return json.loads(run('docker','inspect','mbbs-operator-app-app-1'))[0]
def compose(override):
 labels=before['Config']['Labels'];args=['sudo','-n','docker','compose','--project-name',labels['com.docker.compose.project'],
 '--project-directory',labels['com.docker.compose.project.working_dir'],'--env-file',labels['com.docker.compose.project.environment_file']]
 for file in labels['com.docker.compose.project.config_files'].split(','):args+=['-f',file]
 return args+['-f',str(override)]

phase=sys.argv[1]
if phase=='prepare':
 assert inspect()['Image']==before['Image'],'Running app changed; recapture before deployment.'
 manifest={}
 for file in files:
  original=backup/'app-current'/file;baseline=backup/'baseline'/file
  if baseline.exists():assert original.read_bytes()==baseline.read_bytes(),f'Unreviewed runtime difference: {file}'
  destination=release/'overlay'/file;destination.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(root/file,destination)
  manifest[file]=hashlib.sha256(destination.read_bytes()).hexdigest()
 run('docker','tag',before['Image'],base_image)
 (release/'Dockerfile').write_text(f"FROM {base_image}\nCOPY overlay/ /app/\n")
 (release/'compose.release.yml').write_text(f'services:\n  app:\n    image: {image}\n    pull_policy: never\n')
 (release/'compose.rollback.yml').write_text(f"services:\n  app:\n    image: {base_image}\n    pull_policy: never\n")
 (evidence/'deployment-manifest.json').write_text(json.dumps({'baseImage':before['Image'],'candidateImage':image,'files':manifest},indent=2)+'\n')
 print(f'Prepared {len(files)} reviewed app files. The webhook worker has no posting runtime and needs no change.')
elif phase=='build':
 assert run('docker','image','inspect','--format','{{.Id}}',base_image)==before['Image']
 subprocess.run(['docker','build','--network=none','--pull=false','-t',image,str(release)],check=True)
elif phase=='review':
 before_config=before['Config'];config=json.loads(run(*compose(release/'compose.release.yml'),'config','--format','json'))
 service=config['services']['app']
 (release/'compose.resolved.private.json').write_text(json.dumps(config));(release/'compose.resolved.private.json').chmod(0o600)
 current_env=dict(value.split('=',1) for value in before_config['Env'])
 changed={key:[current_env.get(key),str(value)] for key,value in service.get('environment',{}).items() if current_env.get(key)!=str(value)}
 assert not changed,'Service environment changed; review privately before deployment.'
 assert service['image']==image
 print(json.dumps({'image':image,'environmentUnchanged':True,'ports':service.get('ports'),'volumes':service.get('volumes')}))
elif phase=='migrate':
 assert inspect()['Image']==before['Image'],'Runtime changed since capture.'
 filename='264_transfer_order_background_posting.sql'
 sql=(root/'migrations'/filename).read_text().removeprefix('BEGIN;').removesuffix('\n').removesuffix('COMMIT;')
 script="import {query,withTransaction,closeDb} from './src/db.js';\n"
 script+="try { await withTransaction(async()=> {\n"
 script+="const before=(await query(\"SELECT to_regclass('public.transfer_order_posting_jobs') AS name\")).rows[0].name;\n"
 script+=f"await query({json.dumps(sql)});\n"
 script+=f"await query('INSERT INTO schema_migrations(filename) VALUES($1) ON CONFLICT DO NOTHING',[{json.dumps(filename)}]);\n"
 script+="console.log(JSON.stringify({previousTable:before,jobs:(await query('SELECT count(*)::int AS count FROM transfer_order_posting_jobs')).rows[0].count}));\n"
 script+="}); } finally {await closeDb();}\n"
 result=subprocess.run(['docker','exec','-i','-w','/app','mbbs-operator-app-app-1','node','--input-type=module'],input=script,text=True,capture_output=True)
 (evidence/'migration-live.log').write_text(result.stdout+result.stderr)
 assert result.returncode==0,'Migration failed; inspect migration-live.log before proceeding.'
 print(result.stdout.strip())
elif phase=='deploy':
 assert inspect()['Image']==before['Image'],'Runtime changed since capture.'
 manifest=json.loads((evidence/'deployment-manifest.json').read_text())
 assert all(hashlib.sha256((root/f).read_bytes()).hexdigest()==digest for f,digest in manifest['files'].items()),'Source changed since image preparation.'
 subprocess.run(compose(release/'compose.release.yml')+['up','-d','--no-deps','--no-build','app'],check=True)
elif phase=='rollback':
 subprocess.run(compose(release/'compose.rollback.yml')+['up','-d','--no-deps','--no-build','app'],check=True)
else:raise SystemExit('Expected prepare, build, review, migrate, deploy or rollback')

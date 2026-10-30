#!/usr/bin/env python3
"""Apply only the approved BIN workflow and selection changes over the current live app."""
import hashlib,json,subprocess,shutil,sys,difflib,time,os,re
from pathlib import Path
SERVER=Path(__file__).resolve().parents[1]
REPO=SERVER.parent
OUT=SERVER/'deployments/bin-selection-20261022'
APP='mbbs-operator-app-app-1'
SERVICES={'app':APP,'db':'mbbs-operator-app-db-1','worker':'mbbs-operator-app-webhook-worker-1','ollama':'mbbs-operator-app-ollama-1'}
FILES=json.loads((SERVER/'tools/bin-selection-files.json').read_text())
FEATURE=json.loads((SERVER/'tools/bin-order-workflow-files.json').read_text())
IMAGE='mbbs-operator-app:bin-selection-20261022'
ROLLBACK='mbbs-operator-app:bin-selection-rollback-20261022'
def docker(*args,data=None):
    return subprocess.check_output(['sudo','-n','docker',*args],input=data).decode().strip()
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def save(path,value):
    path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(value,indent=2)+'\n')
def metadata(name):
    row=json.loads(docker('inspect',name))[0]
    config={k:row['Config'][k] for k in ['Env','User','Entrypoint','Cmd','WorkingDir']};config['Env']=sorted(config['Env'])
    host=dict(row['HostConfig']);host['Binds']=sorted(host.get('Binds') or [])
    return {'imageId':row['Image'],'imageRef':row['Config']['Image'],
      'configurationHash':hashlib.sha256(json.dumps({'config':config,'host':host},sort_keys=True).encode()).hexdigest(),
      'compose':row['Config']['Labels']}
def gitfile(revision,file):
    result=subprocess.run(['git','show',f'{revision}:server/{file}'],cwd=REPO,capture_output=True)
    return result.stdout if result.returncode==0 else b''
def merge(current,base,updated,file,stage):
    if base==updated: return current
    if current==base or current==updated: return updated
    paths=[]
    for suffix,content in [('current',current),('base',base),('updated',updated)]:
      path=OUT/'merge-inputs'/stage/(file+'.'+suffix);path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(content);paths.append(path)
    result=subprocess.run(['git','merge-file','-p',*map(str,paths)],capture_output=True)
    if result.returncode: print('CONFLICT',stage,file)
    return result.stdout

def prepare():
    OUT.mkdir(parents=True,exist_ok=True)
    state={key:metadata(name) for key,name in SERVICES.items()}
    if (OUT/'capture.json').exists():
      assert json.loads((OUT/'capture.json').read_text())==state,'Live application changed; capture and rebase again'
    else:
      before=OUT/'live-before';before.mkdir(exist_ok=True)
      for name in ['src','public','migrations','package.json','package-lock.json']:
        subprocess.run(['sudo','-n','docker','cp',APP+':/app/'+name,str(before/name)],check=True)
      subprocess.run(['sudo','-n','chown','-R',f'{os.getuid()}:{os.getgid()}',str(before)],check=True)
      assert state=={key:metadata(name) for key,name in SERVICES.items()},'Live changed while capturing'
      save(OUT/'capture.json',state)
    candidate=OUT/'candidate'
    shutil.copytree(OUT/'live-before',candidate,dirs_exist_ok=True)
    patches=[];conflicts=[]
    for file in FILES:
      live=(OUT/'live-before'/file).read_bytes() if (OUT/'live-before'/file).exists() else b''
      content=live
      if file in FEATURE: content=merge(content,gitfile('946ae51',file),gitfile('edc6145',file),file,'workflow')
      baseline=OUT/'workspace-before'/file
      if baseline.exists(): content=merge(content,baseline.read_bytes(),(SERVER/file).read_bytes(),file,'selection')
      elif file not in FEATURE: content=(SERVER/file).read_bytes()
      if file=='public/mbt-planning.html':
        # Resolve only resource includes/cache keys; preserve the live shell and styles.
        text=live.decode()
        text=text.replace('    <link rel="stylesheet" href="/delivery-instructions.css',
          '    <link rel="stylesheet" href="/bin-order-workflow.css?v=20261020-bin-workflows" />\n    <link rel="stylesheet" href="/delivery-instructions.css')
        text=re.sub(r'    <script src="/mbt-planning.js[^" ]*"></script>',
          '    <script src="/bin-order-workflow-ui.js?v=20261022-bin-selection"></script>\n    <script src="/mbt-planning.js?v=20261022-bin-selection"></script>',text)
        text=re.sub(r'/dispatch.js\?v=[^" ]*','/dispatch.js?v=20261022-bin-selection',text)
        content=text.encode()
      target=candidate/file;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(content)
      if b'<<<<<<< ' in content: conflicts.append(file)
      patches.extend(difflib.unified_diff(live.decode().splitlines(True),content.decode().splitlines(True),fromfile='live/'+file,tofile='candidate/'+file))
    (OUT/'release.patch').write_text(''.join(patches))
    save(OUT/'prepared.json',{'baseImage':state['app']['imageRef'],'conflicts':conflicts,
      'sourceHashes':{f:sha(candidate/f) for f in FILES},'workspaceHashes':{f:sha(SERVER/f) for f in FILES}})
    print(json.dumps({'baseImage':state['app']['imageRef'],'files':len(FILES),'conflicts':conflicts}))
def ensure_sources():
    prepared=json.loads((OUT/'prepared.json').read_text())
    assert not prepared['conflicts'],'Resolve candidate source conflicts first'
    for file,expected in prepared['sourceHashes'].items():
      assert sha(OUT/'candidate'/file)==expected,'Candidate source changed: '+file
    return prepared

def build():
    prepared=ensure_sources();state=json.loads((OUT/'capture.json').read_text())
    assert metadata(APP)==state['app'],'Live application changed before build'
    context=OUT/'image-context';context.mkdir(exist_ok=True)
    for file in FILES:
      target=context/file;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(OUT/'candidate'/file,target)
    docker('tag',state['app']['imageId'],ROLLBACK)
    (context/'Dockerfile').write_text('FROM '+ROLLBACK+'\nCOPY --link . /app/\n')
    (context/'.dockerignore').write_text('/Dockerfile\n/.dockerignore\n')
    result=subprocess.run(['sudo','-n','docker','build','--network=none','-t',IMAGE,str(context)],capture_output=True,text=True)
    (OUT/'build-audit.log').write_text(result.stdout+result.stderr)
    assert result.returncode==0,(result.stdout+result.stderr)[-4000:]
    save(OUT/'built.json',{'image':IMAGE,'imageId':json.loads(docker('image','inspect',IMAGE))[0]['Id'],
      'sourceHashes':prepared['sourceHashes']})
    save(OUT/'compose.release.json',{'services':{'app':{'image':IMAGE}}})
    save(OUT/'compose.rollback.json',{'services':{'app':{'image':ROLLBACK}}})
    print(json.dumps({'built':IMAGE,'files':len(FILES)}))

def compose(state,override):
    labels=state['app']['compose']
    args=['sudo','-n','docker','compose','-p',labels['com.docker.compose.project'],
      '--project-directory',labels['com.docker.compose.project.working_dir']]
    if labels.get('com.docker.compose.project.environment_file'):
      args+=['--env-file',labels['com.docker.compose.project.environment_file']]
    for file in labels['com.docker.compose.project.config_files'].split(','): args+=['-f',file]
    return args+['-f',str(override),'up','-d','--no-deps','--no-build','app']

def health():
    for _ in range(50):
      result=subprocess.run(['curl','-fsS','--max-time','3','http://127.0.0.1:3000/health'],capture_output=True)
      if result.returncode==0 and json.loads(result.stdout).get('ok'): return True
      time.sleep(1)
    return False

def db(sql):
    return docker('exec','-i',SERVICES['db'],'sh','-c',
      'psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"',data=sql.encode())

def apply_migration():
    name='297_bin_order_workflows.sql'
    if db("SELECT filename FROM schema_migrations WHERE filename='"+name+"';"):
      return {'filename':name,'alreadyApplied':True}
    sql=(OUT/'candidate/migrations'/name).read_text()
    db("BEGIN; SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s';\n"+sql+
      "\nINSERT INTO schema_migrations(filename) VALUES ('"+name+"'); COMMIT;")
    return {'filename':name,'applied':True,'sha256':sha(OUT/'candidate/migrations'/name)}

def deploy():
    prepared=ensure_sources();state=json.loads((OUT/'capture.json').read_text())
    built=json.loads((OUT/'built.json').read_text());validation=json.loads((OUT/'validation.json').read_text())
    assert validation['passed'] and validation['sourceHashes']==prepared['sourceHashes'],'Validate this exact candidate first'
    assert built['sourceHashes']==prepared['sourceHashes']
    assert json.loads(docker('image','inspect',IMAGE))[0]['Id']==built['imageId']
    assert {key:metadata(name) for key,name in SERVICES.items()}==state,'Live services changed before release'
    migration=apply_migration();save(OUT/'migration-audit.json',migration)
    try:
      assert metadata(APP)==state['app'],'Live application changed during migration'
      result=subprocess.run(compose(state,OUT/'compose.release.json'),capture_output=True,text=True)
      (OUT/'deployment-audit.log').write_text(result.stdout+result.stderr)
      assert result.returncode==0,(result.stdout+result.stderr)[-4000:]
      assert health(),'Application health did not recover'
      current=metadata(APP);assert current['imageId']==built['imageId']
      assert current['configurationHash']==state['app']['configurationHash'],'Application configuration changed'
      for key,name in SERVICES.items():
        if key!='app': assert metadata(name)==state[key],'Another service changed: '+key
      verify()
    except BaseException:
      # Roll back only this deployment; never overwrite a newer concurrent release.
      if metadata(APP)['imageId']==built['imageId']:
        result=subprocess.run(compose(state,OUT/'compose.rollback.json'),capture_output=True,text=True)
        (OUT/'rollback-audit.log').write_text(result.stdout+result.stderr)
        assert result.returncode==0 and health(),'Rollback failed'
      raise
    save(OUT/'deployment.json',{'deployedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),
      'image':IMAGE,'imageId':built['imageId'],'healthy':True,'configurationPreserved':True,
      'otherServicesPreserved':True,'migration':migration})
    print(json.dumps({'deployed':IMAGE,'healthy':True,'configurationPreserved':True}))

def verify():
    prepared=ensure_sources()
    for file,expected in prepared['sourceHashes'].items():
      assert docker('exec',APP,'sha256sum','/app/'+file).split()[0]==expected,file
    results=[]
    for path,expected in [('/health',200),('/mbt/planning',200),('/mbt/frontdesk',200),('/driver',200),
      ('/bin-order-workflow-ui.js',200),('/mbt-planning.js',200),('/api/mbt/planning?planDate=2026-10-23',401)]:
      status=subprocess.check_output(['curl','-sS','--max-time','15','-o','/dev/null','-w','%{http_code}',
        'http://127.0.0.1:3000'+path],text=True)
      assert int(status)==expected,path+': '+status
      results.append({'path':path,'status':int(status)})
    assert db("SELECT to_regclass('public.mbt_bin_orders');")== 'mbt_bin_orders'
    save(OUT/'live-verification.json',{'sourceHashesVerified':True,'http':results})
    print(json.dumps({'liveVerification':'passed','files':len(FILES)}))

if __name__=='__main__': {'prepare':prepare,'build':build,'deploy':deploy,'verify':verify}[sys.argv[1]]()


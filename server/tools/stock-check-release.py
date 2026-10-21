"""Publish the authorized Stock Check module over captured live code, with app rollback."""
import datetime,hashlib,importlib.util,json,os,pathlib,subprocess,time
SERVER=pathlib.Path(__file__).resolve().parents[1]
ROOT=SERVER.parent
RELEASE=SERVER/'deployments/stock-check-20261014'
OUT=SERVER/'test-artifacts/stock-check'
APP='mbbs-operator-app-app-1'
DB='mbbs-operator-app-db-1'
DEPS=[DB,'mbbs-operator-app-webhook-worker-1','mbbs-operator-app-ollama-1']
IMAGE='mbbs-operator-app:stock-check-20261014'
MIGRATION='288_stock_check_module.sql'
spec=importlib.util.spec_from_file_location('stock_release_helpers',SERVER/'tools/mbr-equipment-release.py')
helpers=importlib.util.module_from_spec(spec);spec.loader.exec_module(helpers)
def save(name,value):
    (RELEASE/name).write_text(json.dumps(value,indent=2)+'\n')
def docker(*args,data=None):
    return subprocess.check_output(['sudo','-n','docker',*args],input=data).decode().strip()
def configuration(name):
    row=json.loads(docker('inspect',name))[0]
    config={key:row['Config'][key] for key in ['Env','User','Entrypoint','Cmd','WorkingDir']}
    config['Env']=sorted(value for value in config['Env'] if not value.startswith('PLAYWRIGHT_BROWSERS_PATH='))
    host=dict(row['HostConfig']);host['Binds']=sorted(host.get('Binds') or [])
    return hashlib.sha256(json.dumps({'config':config,'host':host},sort_keys=True).encode()).hexdigest()
def db(sql):
    return docker('exec','-i',DB,'sh','-c','psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"',data=sql.encode())
def active():
    activity=json.loads(db("""SET default_transaction_read_only=on;SELECT json_build_object(
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'quantityApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying'),
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
      'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'),
      'webhookRunning',(SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status='running'))"""))
    if db("SELECT to_regclass('scm_stock_check_jobs') IS NOT NULL")=='t':
        activity['stockCheckActive']=int(db("SELECT count(*) FROM scm_stock_check_jobs WHERE status IN ('queued','running')"))
    return activity
def tree():
    code="""const fs=require('fs'),path=require('path'),crypto=require('crypto');const hashes={};
    function walk(p){for(const e of fs.readdirSync(p,{withFileTypes:true})){const q=path.join(p,e.name);if(e.isDirectory())walk(q);else if(e.isFile())hashes[q.replace('/app/','')]=crypto.createHash('sha256').update(fs.readFileSync(q)).digest('hex')}}
    for(const p of ['src','public','migrations'])walk('/app/'+p);for(const p of ['package.json','package-lock.json'])hashes[p]=crypto.createHash('sha256').update(fs.readFileSync('/app/'+p)).digest('hex');console.log(JSON.stringify(hashes));"""
    return json.loads(docker('exec',APP,'node','-e',code))
def prepare():
    os.umask(0o077)
    capture=json.loads((RELEASE/'capture.json').read_text());app=helpers.metadata(APP)
    previous=json.loads((RELEASE/'state.json').read_text()) if (RELEASE/'state.json').exists() else None
    if app['imageId']==capture['image_id']:
        expected={key:value for key,value in capture['source_hashes'].items() if key!='Dockerfile'}
    else:
        assert previous and app['imageId']==previous['candidateImageId'],'The live application changed outside this release.'
        expected=json.loads((RELEASE/'published-source.json').read_text())
    assert tree()==expected,'The captured live source changed.'
    state={'app':app,'configuration':configuration(APP),'dependencies':{name:helpers.metadata(name) for name in DEPS},
      'candidateImageId':docker('image','inspect','--format','{{.Id}}',IMAGE)}
    save('state.json',state)
    docker('tag',app['imageId'],'mbbs-operator-app:stock-check-rollback-20261014')
    save('compose.release.json',{'services':{'app':{'image':IMAGE}}})
    save('compose.rollback.json',{'services':{'app':{'image':'mbbs-operator-app:stock-check-rollback-20261014'}}})
    with (RELEASE/'schema-before.dump').open('wb') as output:
        subprocess.run(['sudo','-n','docker','exec',DB,'sh','-c','pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --schema-only --format=custom'],stdout=output,check=True)
    print(json.dumps({'prepared':True,'candidateImageId':state['candidateImageId']}))
def ready():
    for _ in range(50):
        result=subprocess.run(['curl','-fsS','--max-time','3','http://127.0.0.1:3000/health'],capture_output=True)
        if result.returncode==0 and json.loads(result.stdout).get('ok'):return
        time.sleep(1)
    raise RuntimeError('Application health did not recover.')
def verify():
    state=json.loads((RELEASE/'state.json').read_text());ready()
    assert helpers.metadata(APP)['imageId']==state['candidateImageId']
    assert configuration(APP)==state['configuration'],'Application settings changed outside the browser-path addition.'
    assert {name:helpers.metadata(name) for name in DEPS}==state['dependencies'],'An unrelated production service changed.'
    expected=json.loads((RELEASE/'candidate-source.json').read_text());expected.pop('Dockerfile',None)
    assert tree()==expected,'Published source differs from the reviewed candidate.'
    save('published-source.json',expected)
    routes={}
    for route in ['/scm/stock-check','/scm/stock-check/test','/scm/stock-check/setup']:
        result=subprocess.run(['curl','-fsS','--max-time','10','http://127.0.0.1:3000'+route],capture_output=True);assert result.returncode==0 and b'scm-stock-check.js' in result.stdout;routes[route]=200
    result={'deployed':True,'healthy':True,'onlyAppChanged':True,'migration':MIGRATION,'routes':routes,'at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
    (OUT/'deployment.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
def deploy():
    state=json.loads((RELEASE/'state.json').read_text())
    assert helpers.metadata(APP)==state['app'] and {name:helpers.metadata(name) for name in DEPS}==state['dependencies']
    activity=active();(OUT/'active-before.json').write_text(json.dumps(activity,indent=2)+'\n');assert not any(activity.values()),'Wait for active operational work before switching the app.'
    log=(OUT/'final.log').read_text();assert '# fail 0' in log and '# pass 83' in log,'Run the complete module validation before release.'
    assert (OUT/'final-cleanup.log').exists(),'Validation teardown evidence is missing.'
    assert 'app-1 Healthy' in (OUT/'boot-green.log').read_text(),'The exact runtime image must pass its isolated startup health check.'
    assert docker('image','inspect','--format','{{.Id}}',IMAGE)==state['candidateImageId']
    if db("SELECT count(*) FROM schema_migrations WHERE filename='"+MIGRATION+"'")=='0':
        sql="BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';\n"+(RELEASE/'candidate/migrations'/MIGRATION).read_text()+"\nINSERT INTO schema_migrations(filename) VALUES('"+MIGRATION+"');COMMIT;"
        (OUT/'migration-production.log').write_text(db(sql)+'\n')
    try:
        with (OUT/'production-publish.log').open('w') as output:
            subprocess.run(helpers.compose(state,RELEASE/'compose.release.json')+['up','-d','--no-build','--no-deps','--pull','never','app'],cwd=ROOT,stdout=output,stderr=subprocess.STDOUT,check=True,timeout=60)
        verify()
    except BaseException:
        (OUT/'production-failed-startup.log').write_text(docker('logs','--tail','100',APP))
        with (OUT/'production-rollback.log').open('w') as output:
            subprocess.run(helpers.compose(state,RELEASE/'compose.rollback.json')+['up','-d','--no-build','--no-deps','--pull','never','app'],cwd=ROOT,stdout=output,stderr=subprocess.STDOUT,check=True,timeout=60)
        ready();raise
if __name__=='__main__':
    import sys
    {'prepare':prepare,'deploy':deploy,'verify':verify}[sys.argv[1]]()

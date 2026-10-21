"""Apply the validated request-loading overlay, with app and schema rollback."""
import atexit,difflib,importlib.util,json,os,shutil,subprocess,sys,tempfile
from pathlib import Path
SERVER=Path(__file__).resolve().parents[2]
ROOT=SERVER.parent
RELEASE=SERVER/'deployments/request-loading-performance-20261008'
OUT=SERVER/'test-artifacts/request-loading-performance-20261008'
spec=importlib.util.spec_from_file_location('release_helpers',SERVER/'tools/delivery-scm-release.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
r.RELEASE=RELEASE;r.IMAGE='mbbs-operator-app:request-loading-20261008';r.ROLLBACK=r.IMAGE+'-rollback'
r.READ_NAME='mbbs-request-loading-reader';r.CHECK_NAME='mbbs-request-loading-image-check'
MIGRATION='275_request_completion_lookup.sql'

def prepare():
    captured=json.loads((RELEASE/'capture.json').read_text())
    r.current({**captured,'candidateTree':r.files_at(RELEASE/'candidate'),'workspace':{}})
    before=r.files_at(RELEASE/'before');candidate=r.files_at(RELEASE/'candidate')
    changed=sorted(n for n in before.keys()|candidate.keys() if before.get(n)!=candidate.get(n))
    assert len(changed)==8,changed
    assert (RELEASE/'before/package-lock.json').read_bytes()==(RELEASE/'candidate/package-lock.json').read_bytes()
    patch=''.join(''.join(difflib.unified_diff((RELEASE/'before'/n).read_text().splitlines(True) if (RELEASE/'before'/n).exists() else [],
        (RELEASE/'candidate'/n).read_text().splitlines(True),fromfile='a/'+n,tofile='b/'+n)) for n in changed)
    (RELEASE/'candidate.patch').write_text(patch)
    r.save('manifest.json',{**captured,'workspace':{},'files':changed,'beforeTree':before,'candidateTree':candidate,
        'candidateTreeHash':r.sha(json.dumps(candidate,sort_keys=True).encode())})
    print(json.dumps({'changedFiles':changed}),flush=True)

def merge_workspace():
    data=r.state()
    # Merge only the validated before-to-candidate delta. Other work in this
    # shared checkout may have changed since capture and must be retained.
    staged=Path(tempfile.mkdtemp(prefix='workspace-merge-',dir=RELEASE))
    observed={};patch=''
    for n in data['files']:
        live=SERVER/n;before=RELEASE/'before'/n;candidate=RELEASE/'candidate'/n
        observed[n]=r.sha(live.read_bytes()) if live.exists() else None
        if live.exists():
            (staged/n).parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(live,staged/n)
        if live.exists() and live.read_bytes()==candidate.read_bytes():continue
        if before.exists():assert live.exists(),'Workspace file disappeared: '+n
        else:assert not live.exists(),'New migration/file collides: '+n
        patch+=''.join(difflib.unified_diff(before.read_text().splitlines(True) if before.exists() else [],
            candidate.read_text().splitlines(True),fromfile='a/'+n,tofile='b/'+n))
    if patch:r.apply_patch(staged,patch,'workspace-merge')
    for n in data['files']:
        live=SERVER/n
        assert (r.sha(live.read_bytes()) if live.exists() else None)==observed[n],'Concurrent workspace edit during merge: '+n
    backup=RELEASE/'workspace-merge-before';backup.mkdir(exist_ok=False)
    for n in data['files']:
        live=SERVER/n
        if live.exists():
            (backup/n).parent.mkdir(parents=True,exist_ok=True);shutil.copy2(live,backup/n)
        live.parent.mkdir(parents=True,exist_ok=True)
        pending=live.with_name(live.name+'.request-loading-pending')
        shutil.copy2(staged/n,pending);os.replace(pending,live)
    r.save('workspace-merge.json',{'files':data['files'],'beforeHashes':observed,
        'hashes':{n:r.sha((SERVER/n).read_bytes()) for n in data['files']},'staging':str(staged)})

def validated():
    data=r.state();r.current(data)
    report=json.loads((OUT/'evidence.json').read_text())
    assert report['readyForRelease'], 'Required checks not complete'
    assert data['candidateTree']==r.files_at(RELEASE/'candidate')
    assert report['sourceTreeHash']==data['candidateTreeHash']
    r.save('validation-passed.json',{'passed':True,'candidateTreeHash':data['candidateTreeHash'],'report':str(OUT/'evidence.json')})

def backup_schema():
    if not (RELEASE/'schema-before.sql').exists():
        with (RELEASE/'schema-before.sql').open('wb') as output:
            subprocess.run(['docker','exec',r.DB,'pg_dump','-U','mbbs_app','-d','mbbs_yard','--schema-only','--no-owner','--no-acl'],stdout=output,check=True,timeout=30)
    old=r.sql("SELECT pg_get_viewdef('dispatch_effective_order_completion_events'::regclass,true)")
    old_stage=r.sql("SELECT pg_get_viewdef('special_stock_workflow_stages'::regclass,true)")
    old_status=r.sql("SELECT pg_get_viewdef('dispatch_order_completion_status'::regclass,true)")
    rollback="BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='20s';\nCREATE OR REPLACE VIEW dispatch_effective_order_completion_events AS\n"+old.rstrip(';')+";\nCREATE OR REPLACE VIEW special_stock_workflow_stages AS\n"+old_stage.rstrip(';')+";\nCREATE OR REPLACE VIEW dispatch_order_completion_status AS\n"+old_status.rstrip(';')+";\nDROP FUNCTION dispatch_completion_evidence_priority(text);\nDROP INDEX IF EXISTS idx_dispatch_snapshot_planning_refs;\nDROP FUNCTION IF EXISTS dispatch_snapshot_planning_refs(jsonb,jsonb);\nDELETE FROM schema_migrations WHERE filename='"+MIGRATION+"';\nCOMMIT;\n"
    path=RELEASE/'rollback.sql'
    if path.exists():
        # A lock-timeout rolls the transaction back. Retry only when the live
        # view definitions still produce the identical retained rollback.
        assert path.read_text()==rollback,'Live schema changed since rollback capture'
        assert r.sql("SELECT count(*) FROM schema_migrations WHERE filename='"+MIGRATION+"'")=='0'
    else:path.write_text(rollback)

def verify():
    data=r.state();r.ready(data['candidateImageId']);live=r.metadata(r.APP)
    assert live['configuration']==data['app']['configuration']
    assert [r.metadata(name) for name in r.DEPENDENCIES]==data['dependencies']
    assert json.loads(r.docker('exec',r.APP,'node','-e',r.HASH_SCRIPT))==data['candidateTree']
    assert r.sql("SELECT count(*) FROM schema_migrations WHERE filename='"+MIGRATION+"'")=='1'
    assert r.sql("SELECT indisvalid FROM pg_index WHERE indexrelid='idx_dispatch_snapshot_planning_refs'::regclass")=='t'
    result={'deployed':True,'at':r.now(),'imageId':live['imageId'],'configurationPreserved':True,'dependenciesPreserved':True,'files':data['files']}
    r.save('deployment-result.json',result);print(json.dumps(result),flush=True)

def apply():
    data=r.state();r.current(data);r.config_check(data)
    assert json.loads((RELEASE/'image-check.json').read_text())['passed']
    r.assert_no_active_operations(r.preflight());backup_schema()
    args=['up','-d','--no-build','--no-deps','--pull','never','app']
    migrated=False;cutover_started=False
    try:
        sql=(RELEASE/'candidate/migrations'/MIGRATION).read_text()
        r.sql("BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';\n"+sql+
            "\nINSERT INTO schema_migrations(filename) VALUES('"+MIGRATION+"'); COMMIT;")
        migrated=True;r.current(data);r.assert_no_active_operations(r.preflight())
        cutover_started=True
        with (RELEASE/'cutover.log').open('wb') as output:
            subprocess.run(r.compose(data,'release')+args,cwd=ROOT,stdout=output,stderr=subprocess.STDOUT,check=True,timeout=60)
        verify()
    except BaseException:
        if cutover_started:
            with (RELEASE/'rollback.log').open('wb') as output:
                subprocess.run(r.compose(data,'rollback')+args,cwd=ROOT,stdout=output,stderr=subprocess.STDOUT,check=True,timeout=60)
            r.ready(data['app']['imageId'])
        if migrated:r.sql((RELEASE/'rollback.sql').read_text())
        raise

if __name__=='__main__':
    os.umask(0o022)
    if sys.argv[1]=='build':atexit.register(r.cleanup_manual)
    {'prepare':prepare,'merge':merge_workspace,'validated':validated,'build':r.build,'apply':apply,'verify':verify}[sys.argv[1]]()

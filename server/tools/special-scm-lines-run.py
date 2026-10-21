"""Run checks in the existing isolated runner; never print or use production credentials."""
from pathlib import Path
import subprocess, json, os, sys
from urllib.parse import urlsplit
SERVER=Path(__file__).resolve().parents[1]
OUT=SERVER/'test-artifacts/special-scm-lines-20261003'
RUNNER='mbbs-special-review-runner'
REMOTE='/tmp/special-scm-lines-20261003'
def docker(*args,**kwargs):
    return subprocess.check_output(['docker',*args],**kwargs)
def sync(source=None):
    source=Path(source) if source else SERVER
    docker('exec',RUNNER,'node','-e',"const fs=require('fs'),p=process.argv[1];fs.mkdirSync(p,{recursive:true});",REMOTE)
    for folder in ['src','public','migrations','test','tools']:
        root=source if folder in ['src','public','migrations'] else SERVER
        docker('cp',str(root/folder),RUNNER+':'+REMOTE+'/')
    evidence=SERVER/'test-artifacts/special-scm-lines-20261003'
    docker('exec',RUNNER,'node','-e',"require('fs').mkdirSync(process.argv[1],{recursive:true})",REMOTE+'/test-artifacts/special-scm-lines-20261003')
    for name in ['before','changed-diffs.json']:
        if (evidence/name).exists():docker('cp',str(evidence/name),RUNNER+':'+REMOTE+'/test-artifacts/special-scm-lines-20261003/')
    for name in ['package.json','package-lock.json','netsuite-smart-scm-picking-ticket-restlet.js']:
        root=source if (source/name).exists() else SERVER
        docker('cp',str(root/name),RUNNER+':'+REMOTE+'/'+name)
    docker('exec',RUNNER,'node','-e',"const f=require('fs'),p=process.argv[1];if(!f.existsSync(p))f.symlinkSync('/app/node_modules',p,'dir')",REMOTE+'/node_modules')
def run(label,command):
    info=json.loads(docker('inspect',RUNNER))[0]
    env=dict(value.split('=',1) for value in info['Config']['Env'])
    assert env['MBT_TEST_ISOLATED']=='1' and env['NETSUITE_DIRECT_ACCESS_ENABLED']=='false'
    url=urlsplit(env['DATABASE_URL']);assert url.hostname=='mbbs-special-review-db'
    test_env={'DATABASE_URL':url._replace(path='/mbt_verify').geturl(),'MBT_TEST_ISOLATED':'1',
      'NETSUITE_DIRECT_ACCESS_ENABLED':'false','PLAYWRIGHT_BROWSERS_PATH':'/browsers','MBBS_ENV_FILE':'/nonexistent'}
    args=['docker','exec',*[arg for key,value in test_env.items() for arg in ['-e',key+'='+value]],'-w',REMOTE,RUNNER,*command]
    OUT.mkdir(parents=True,exist_ok=True)
    with (OUT/(label+'.log')).open('wb') as log:
        result=subprocess.run(args,stdout=log,stderr=subprocess.STDOUT)
    log=(OUT/(label+'.log')).read_text()
    print(json.dumps({'label':label,'exitCode':result.returncode,'tail':log[-4500:]}),flush=True)
    return result.returncode
if __name__=='__main__':
    if sys.argv[1]=='sync':sync();print('Isolated source synced.')
    elif sys.argv[1]=='collect':
        OUT.mkdir(parents=True,exist_ok=True);docker('cp',RUNNER+':'+REMOTE+'/test-artifacts/special-scm-lines-20261003/.',str(OUT))
    else:sys.exit(run(sys.argv[1],sys.argv[2:]))

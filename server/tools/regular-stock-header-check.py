"""Fresh isolated regression, SQL/property, coverage and mutation checks for the SO header fix."""
import json
import hashlib
import subprocess
import time
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
SERVER=ROOT/'server'
OUT=SERVER/'test-artifacts/regular-stock-header'
OUT.mkdir(exist_ok=True)
docker=lambda *args: subprocess.check_output(['sudo','-n','docker',*args])
runner=json.loads(docker('inspect','mbbs-regular-v2-runner'))[0]
env=dict(value.split('=',1) for value in runner['Config']['Env'])
assert env['MBT_TEST_ISOLATED']=='1' and env['NETSUITE_DIRECT_ACCESS_ENABLED']=='false'
network='mbbs-regular-header-test-internal'
db='mbbs-regular-header-test-db'
baseline=json.loads((SERVER/'tools/regular-stock-header-baseline.json').read_text())
assert hashlib.sha256((SERVER/'package.json').read_bytes()).hexdigest()==baseline['packageSha256']
layers=[]
try:
    docker('network','create','--internal',network)
    image=json.loads(docker('inspect','mbbs-regular-v2-db-1'))[0]['Image']
    docker('run','-d','--name',db,'--network',network,'--network-alias','db','--tmpfs','/var/lib/postgresql',
        '-e','POSTGRES_DB=mbt_test','-e','POSTGRES_USER=mbt_test','-e','POSTGRES_PASSWORD=mbt_test_password',
        '-e','PGDATA=/var/lib/postgresql/data',image)
    for attempt in range(60):
        ready=subprocess.run(['sudo','-n','docker','exec',db,'pg_isready','-U','mbt_test','-d','mbt_test'],capture_output=True)
        if ready.returncode==0: break
        time.sleep(.5)
    else: raise RuntimeError('Disposable database failed to start')
    args=['sudo','-n','docker','run','--rm','--network',network,'--read-only','--tmpfs','/tmp:uid=1000,gid=1000,mode=1777',
        '--tmpfs','/app/data:uid=1000,gid=1000,mode=0700']
    for key,value in env.items(): args+=['-e',key+'='+value]
    for path in ['src','public','migrations','tools','test','package.json']:
        args+=['-v',str(SERVER/path)+':/app/'+path+':ro']
    # Keep this run's full-suite logs separate from the earlier release evidence.
    args+=['-v',str(OUT)+':/app/test-artifacts','-v',str(OUT)+':/app/test-artifacts/regular-stock-header']
    for name,command in [('migrations',['node','src/migrate.js']),('regressions',['node','tools/regular-stock-v2-tests.mjs']),
                         ('header-gauntlet',['node','tools/regular-stock-header-check.mjs'])]:
        started=time.monotonic()
        with (OUT/(name+'.log')).open('wb') as log:
            result=subprocess.run(args+['mbbs-regular-v2:test']+command,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT)
        record={'layer':name,'exitCode':result.returncode,'seconds':round(time.monotonic()-started,2)}
        layers.append(record);print(json.dumps(record),flush=True)
        (OUT/'gauntlet.json').write_text(json.dumps(layers,indent=2)+'\n')
        assert result.returncode==0,'Inspect '+str(OUT/(name+'.log'))
finally:
    subprocess.run(['sudo','-n','docker','rm','-f',db],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    subprocess.run(['sudo','-n','docker','network','rm',network],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)

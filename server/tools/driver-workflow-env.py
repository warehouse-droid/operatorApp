"""Own only disposable Driver browser containers; never connect to live data."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT=Path(__file__).resolve().parents[1]
ART=ROOT/'test-artifacts/driver-workflow'
NET='mbbs-driver-workflow-test'
DB=NET+'-db'
APP=NET+'-app'
BROWSER=NET+'-browser'
IMAGE='mbbs-operator-app:sor-rentals-20260924-v1'
EXPECTED='sha256:e8ca312feea3c012da428cbf829b70f9b5c00aa1330e5391e6959b7c16eec1d3'
def docker(*args,**kwargs):return subprocess.run(['docker',*args],check=True,**kwargs)
def start():
 ART.mkdir(parents=True,exist_ok=True)
 if os.environ.get('SUDO_UID'):os.chown(ART,int(os.environ['SUDO_UID']),int(os.environ['SUDO_GID']))
 image=subprocess.check_output(['docker','image','inspect','--format','{{.Id}}',IMAGE],text=True).strip()
 assert image==EXPECTED
 (ART/'image.json').write_text(json.dumps({'image':IMAGE,'id':image}))
 docker('network','create','--internal',NET)
 docker('run','-d','--name',DB,'--network',NET,'--network-alias','db','--tmpfs','/var/lib/postgresql',
  '-e','POSTGRES_USER=workflow','-e','POSTGRES_PASSWORD=workflow_test_only','-e','POSTGRES_DB=driver_pwa_workflow','postgres:18-alpine')
 for _ in range(30):
  if subprocess.run(['docker','exec',DB,'pg_isready','-U','workflow','-d','driver_pwa_workflow'],stdout=subprocess.DEVNULL).returncode==0:break
  time.sleep(1)
 else:raise RuntimeError('Disposable database did not become ready')
 env={'NODE_ENV':'test','MBT_TEST_ISOLATED':'1','MBBS_ENV_FILE':'.env.isolated-driver-workflow-does-not-exist',
  'DATABASE_URL':'postgres://workflow:workflow_test_only@db:5432/driver_pwa_workflow','NETSUITE_DIRECT_ACCESS_ENABLED':'false',
  'SAMSARA_WRITES_ENABLED':'false','MBT_NETSUITE_WRITES_ENABLED':'false','SMART_SCM_LIVE_EXECUTION_ENABLED':'false','SALES_PUBLIC_ACCESS_ENABLED':'false',
  'PHOTO_UPLOAD_PROVIDER':'r2_worker','PHOTO_UPLOAD_WORKER_URL':'http://127.0.0.1:3101','PHOTO_UPLOAD_TOKEN_SECRET':'isolated-workflow-signing-key-not-for-production',
  'APP_BASE_URL':'http://127.0.0.1:3000'}
 envargs=[value for key,value in env.items() for value in ['-e',key+'='+value]]
 docker('run','-d','--name',APP,'--network',NET,'--read-only','--tmpfs','/tmp','--tmpfs','/app/data',
  '-v',str(ROOT/'tools')+':/app/tools:ro',
  '-v',str(ROOT/'public/driver.js')+':/app/public/driver.js:ro',
  '-v',str(ROOT/'public/driver.html')+':/app/public/driver.html:ro',
  '-v',str(ROOT/'public/driver-service-worker.js')+':/app/public/driver-service-worker.js:ro',
  *envargs,'--entrypoint','sh',IMAGE,'-c','node src/migrate.js && node tools/driver-workflow-server.mjs')
def run():
 docker('run','--rm','--name',BROWSER,'--network','container:'+APP,'--read-only','--tmpfs','/tmp:mode=1777',
  '--shm-size','256m','-e','PLAYWRIGHT_BROWSERS_PATH=/ms-playwright',
  '-v',str(ROOT/'test-artifacts/sor-rentals/browsers')+':/ms-playwright:ro',
  '-v',str(ROOT/'test-artifacts/sor-rentals/node_modules')+':/app/node_modules:ro',
  '-v',str(ROOT/'tools')+':/app/tools:ro','-v',str(ART)+':/app/test-artifacts/driver-workflow',
  '-w','/app','--entrypoint','node','mbbs-return-batch-browser-test:20260918','tools/driver-workflow-browser.mjs')
def stop():
 for name in [BROWSER,APP,DB]:subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 docker('network','rm',NET)
def reset():
 stop()
 start()
{'start':start,'run':run,'stop':stop,'reset':reset}[sys.argv[1]]()

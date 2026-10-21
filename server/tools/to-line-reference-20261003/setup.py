import json, pathlib, subprocess

root=pathlib.Path(__file__).resolve().parents[2]
network='mbbs-to-reference-20261003'
def run(*args):return subprocess.check_output(args,text=True).strip()
def exists(kind,name):return subprocess.run(['docker',kind,'inspect',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
if not exists('network',network):run('docker','network','create','--internal',network)
if not exists('container',network+'-db'):
 run('docker','run','-d','--name',network+'-db','--network',network,'--network-alias','db','--tmpfs','/var/lib/postgresql',
     '-e','POSTGRES_USER=mbt_test','-e','POSTGRES_PASSWORD=mbt_test_password','-e','POSTGRES_DB=mbt_test','postgres:18-alpine')
if not exists('container',network+'-runner'):
 args=['docker','run','-d','--name',network+'-runner','--network',network,'--ipc=host','--user','1000:1000',
   '-e','MBT_TEST_ISOLATED=1','-e','MBT_ENABLED=true','-e','MBBS_ENV_FILE=/nonexistent','-e','NODE_ENV=test',
   '-e','MBBS_REPO_ROOT=/workspace','-e','DISPATCH_PLANNER_ORDER_POOL_MODE=off',
   '-e','DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test']
 for folder in ['src','public','test','migrations','tools','contracts']:args+=['-v',f'{root/folder}:/app/{folder}:ro']
 for file in root.iterdir():
  if file.is_file() and (file.suffix in ['.json','.js'] or file.name.startswith('Dockerfile')):args+=['-v',f'{file}:/app/{file.name}:ro']
 args+=['-v',f'{root/"test-artifacts"}:/app/test-artifacts','-v',f'{root.parent}:/workspace:ro',
   '-v','/home/ubuntu/operatorapp-investigations/to-line-reference-20261003/baseline:/baseline:ro',
   '--entrypoint','sleep','mbbs-regular-v2:e2e','infinity']
 run(*args)
print(json.dumps({'runner':network+'-runner','database':network+'-db','network':network}))

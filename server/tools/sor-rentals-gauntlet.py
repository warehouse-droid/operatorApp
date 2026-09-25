"""Reproduce SOR validation. Run with sudo; all database work is disposable."""
import json
import os
from pathlib import Path
import subprocess
import sys
ROOT=Path(__file__).resolve().parents[1]
ART=ROOT/'test-artifacts/sor-rentals'
CANDIDATE='/home/ubuntu/operatorapp-deploy-backups/sor-rentals-20260924-v1/candidate'

def run(name,command,mode='current',env=None,expect_success=True):
    print(name,flush=True)
    with (ART/name).open('w') as output:
        result=subprocess.run(['bash','tools/sor-rentals-test-env.sh','run',mode,*command],cwd=ROOT,
            env={**os.environ,**(env or {})},stdout=output,stderr=subprocess.STDOUT)
    if expect_success:assert result.returncode==0,name
    return result.returncode

def quick():
    env={'SOR_TEST_DATABASE':'mbt_test_file_50a188aabbcc_focus','SOR_CANDIDATE_ROOT':CANDIDATE}
    run('candidate-focused.log',['bash','-c','SOR_SHUFFLE_SEED=20260924 node tools/sor-rentals-focused.mjs'],'candidate',env)
    run('candidate-browser.log',['bash','-c','node tools/sor-rentals-browser.mjs && node tools/sor-rentals-admin-browser.mjs && node tools/sor-rentals-browser-coverage.mjs'],'candidate',env)
    for mode in ['baseline','current']:
        run('lint-'+mode+'.log',['node','tools/sor-rentals-static.mjs',mode],mode)
        run('types-'+mode+'-focused.log',['bash','tools/sor-rentals-types.sh',mode],mode,expect_success=False)
    subprocess.run(['python3','tools/sor-rentals-mutations.py'],cwd=ROOT,check=True)
    run('migration-check.log',['node','tools/sor-rentals-migration.mjs'],env=env)

def broad():
    run('full-baseline-valid.log',['npm','run','test:mbt'],'baseline',expect_success=False)
    run('dispatch-baseline.log',['npm','run','test:dispatch:performance'],'baseline',expect_success=False)
    run('full-final-shuffled.log',['bash','-c','MBT_SHUFFLE_SEED=20260924 npm run test:mbt:shuffled'],expect_success=False)
    run('dispatch-current.log',['node','tools/sor-rentals-dispatch-coverage.mjs'],expect_success=False)
    run('integration-compatibility.log',['node','tools/sor-rentals-integration-coverage.mjs'],'candidate',{'SOR_CANDIDATE_ROOT':CANDIDATE})

def runtime():
    for suffix,command,log in [
        ('rollout','node tools/sor-rentals-rollout-fixture.mjs','rollout-rehearsal.log'),
        ('driverflow','node_modules/.bin/c8 --all=false --check-coverage=false --include="src/*.js" --temp-directory=/tmp/sor-flow-coverage --report-dir=test-artifacts/sor-rentals/flow-coverage --reporter=json node tools/sor-rentals-driver-flow.mjs','driver-flow.log')]:
        database='mbt_test_file_188188188188_'+suffix
        subprocess.run(['docker','exec','mbbs-sor-rentals-test-db','psql','-U','mbt_test','-d','postgres','-v','ON_ERROR_STOP=1',
            '-c','DROP DATABASE IF EXISTS '+database+' WITH (FORCE)','-c','CREATE DATABASE '+database],check=True,cwd=ROOT)
        env={'SOR_TEST_DATABASE':database,'SOR_CANDIDATE_ROOT':CANDIDATE}
        run(log,['bash','-c','node src/migrate.js && '+command],'candidate',env)
    run('startup.log',['node_modules/.bin/c8','--all=false','--check-coverage=false','--include=src/*.js',
        '--temp-directory=/tmp/sor-startup-coverage','--report-dir=test-artifacts/sor-rentals/startup-coverage','--reporter=json',
        'node','tools/sor-rentals-startup.mjs'],'candidate',{'SOR_TEST_DATABASE':'mbt_test_file_188188188188_rollout','SOR_CANDIDATE_ROOT':CANDIDATE})
    run('cache-check.log',['node_modules/.bin/c8','--all=false','--check-coverage=false','--include=public/driver-service-worker.js',
        '--temp-directory=/tmp/sor-cache-coverage','--report-dir=test-artifacts/sor-rentals/cache-coverage','--reporter=json',
        'node','tools/sor-rentals-cache-check.mjs'],'candidate',{'SOR_CANDIDATE_ROOT':CANDIDATE})
    with (ART/'image-smoke.json').open('w') as output,(ART/'image-smoke.log').open('w') as errors:
        subprocess.run(['docker','run','--rm','-i','--network','mbbs-sor-rentals-test','--read-only','--tmpfs','/tmp','--tmpfs','/app/data',
            '-e','NODE_ENV=test','-e','DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test_file_188188188188_rollout',
            '-e','NETSUITE_DIRECT_ACCESS_ENABLED=false','-e','SAMSARA_WRITES_ENABLED=false','-e','MBT_NETSUITE_WRITES_ENABLED=false',
            '--entrypoint','node','mbbs-operator-app:sor-rentals-20260924-v1','--input-type=module'],cwd=ROOT,
            input=(ROOT/'tools/sor-rentals-image-smoke.mjs').read_text(),text=True,stdout=output,stderr=errors,check=True)

mode=sys.argv[1] if len(sys.argv)>1 else 'all'
assert mode in ['quick','broad','runtime','evidence','all']
if mode in ['broad','all']:broad()
if mode in ['runtime','all']:runtime()
if mode in ['quick','all']:quick()
if mode in ['evidence','all']:subprocess.run(['python3','tools/sor-rentals-evidence.py'],cwd=ROOT,check=True)

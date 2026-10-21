"""Collect the completed isolated damage retry gauntlet against deployable hashes."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

SERVER=Path(__file__).resolve().parents[1]
OUT=SERVER/'test-artifacts/damage-posting-retry-20261001'
spec=importlib.util.spec_from_file_location('damage_release',SERVER/'tools/damage-posting-retry-deploy.py')
release=importlib.util.module_from_spec(spec);spec.loader.exec_module(release)
def command(args):
    return subprocess.run(args,cwd=SERVER,check=True)
def coverage():
    command(['python3','tools/damage-posting-retry-evidence.py','changed'])
    remote=release.REMOTE+'/test-artifacts/damage-posting-retry-20261001/changed-lines.json'
    release.docker('exec','-i',release.RUNNER,'node','-e',
                   'require("fs").writeFileSync(process.argv[1],require("fs").readFileSync(0))',remote,input=(OUT/'changed-lines.json').read_bytes())
    result=release.docker('exec','-w',release.REMOTE,release.RUNNER,'node','tools/damage-posting-retry-coverage.mjs')
    print(result.decode().strip(),flush=True);release.collect()
def collect():
    for stage in ['compare','types','supply','source']:
        command(['python3','tools/damage-posting-retry-evidence.py',stage])
    coverage()
    checks=json.loads((OUT/'candidate/checks.json').read_text())
    assert checks['completed'] and checks['sourceHashes']==release.parent.state()['sourceHashes']
    assert checks['focused']['fail']==0 and checks['reordered']['fail']==0
    assert not json.loads((OUT/'candidate/static.json').read_text())['newLintFindings']
    assert all(row['killed'] for row in json.loads((OUT/'candidate/mutations.json').read_text()))
    print(json.dumps({'gauntletCollected':True,'focusedPassed':checks['focused']['pass']}),flush=True)
def setup(name,source):
    runner=name+'-runner'
    if subprocess.run(['sudo','-n','docker','inspect',runner],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode:
        command(['sudo','-n','env','DAMAGE_RETRY_TEST_NAME='+name,'DAMAGE_RETRY_SOURCE_ROOT='+str(source),
                 *(['DAMAGE_RETRY_SUBNET=10.254.71.0/24'] if name.endswith('comparison-final') else []),
                 'bash','tools/damage-posting-retry-env.sh','start'])
def run():
    # Frozen broad sources retain the current unrelated features and identical
    # tests. The deployable candidate is separately checked using its own hashes.
    metadata=json.loads((OUT/'frozen-comparison.json').read_text())
    setup('mbbs-damage-posting-retry-comparison-baseline',OUT/'comparison-baseline')
    setup('mbbs-damage-posting-retry-comparison-final',OUT/metadata['finalSourceRoot'])
    setup('mbbs-damage-posting-retry-test',SERVER)
    command(['sudo','-n','docker','exec','-w','/app',release.RUNNER,'npm','run','migrate'])
    found=release.docker('exec','mbbs-damage-posting-retry-test-db','psql','-U','mbt_test','-d','mbt_test','-XAt','-c',
                         "SELECT count(*) FROM pg_database WHERE datname='mbt_focus'").decode().strip()
    if found=='0': release.docker('exec','mbbs-damage-posting-retry-test-db','createdb','-U','mbt_test','-T','mbt_test','mbt_focus')
    workers=[]
    for label in ['baseline','final']:
        log=(OUT/(label+'-watch.log')).open('wb')
        workers.append((subprocess.Popen(['python3','tools/damage-posting-retry-full-run.py',label,'--comparison'],cwd=SERVER,stdout=log,stderr=subprocess.STDOUT),log))
    release.validate_candidate()
    for label in ['baseline','final']:
        runner='mbbs-damage-posting-retry-comparison-'+label+'-runner'
        with (OUT/('types-'+label+'.log')).open('wb') as log:
            result=subprocess.run(['sudo','-n','docker','exec','-w','/app',runner,'node','node_modules/typescript/bin/tsc','--project','tsconfig.mbt.json','--noEmit'],stdout=log,stderr=subprocess.STDOUT)
        assert result.returncode in [0,1,2] and (result.returncode==0 or 'error TS' in (OUT/('types-'+label+'.log')).read_text())
    for worker,log in workers:
        assert worker.wait()==0;log.close()
    command(['python3','tools/damage-posting-retry-run-rehearsal.py'])
    collect()
if __name__=='__main__':
    {'run':run,'collect':collect,'coverage':coverage}[sys.argv[1]]()

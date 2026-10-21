"""Re-run the isolated damage-photo gauntlet, or collect the completed run."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

SERVER=Path(__file__).resolve().parents[1]
OUT=SERVER/'test-artifacts/damage-photos-20261001'
spec=importlib.util.spec_from_file_location('damage_release',SERVER/'tools/damage-photos-deploy.py')
release=importlib.util.module_from_spec(spec);spec.loader.exec_module(release)

def command(args,**kwargs):
    return subprocess.run(args,cwd=SERVER,check=True,**kwargs)

def coverage():
    command(['python3','tools/damage-photos-evidence.py','changed'])
    remote=release.REMOTE+'/test-artifacts/damage-photos-20261001/changed-lines.json'
    release.docker('exec','-i',release.RUNNER,'node','-e',
                   'require("fs").writeFileSync(process.argv[1],require("fs").readFileSync(0))',remote,
                   input=(OUT/'changed-lines.json').read_bytes())
    result=release.docker('exec','-w',release.REMOTE,release.RUNNER,'node','tools/damage-photos-coverage.mjs')
    print(result.decode().strip(),flush=True)
    release.collect()

def collect():
    command(['python3','tools/damage-photos-evidence.py','compare'])
    command(['python3','tools/damage-photos-evidence.py','types'])
    command(['python3','tools/damage-photos-evidence.py','supply'])
    coverage()
    command(['python3','tools/damage-photos-zip-check.py'])
    checks=json.loads((OUT/'candidate/checks.json').read_text())
    assert checks['completed'] and checks['sourceHashes']==release.parent.state()['sourceHashes']
    assert checks['focused']['fail']==0 and checks['reordered']['fail']==0
    assert not json.loads((OUT/'candidate/static.json').read_text())['newLintFindings']
    assert all(row['killed'] for row in json.loads((OUT/'candidate/mutations.json').read_text()))
    print(json.dumps({'gauntletCollected':True,'sourceHashes':checks['sourceHashes']}),flush=True)

def setup(name,source):
    runner=name+'-runner'
    if subprocess.run(['sudo','-n','docker','inspect',runner],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode:
        env={**os.environ,'DAMAGE_PHOTOS_TEST_NAME':name,'DAMAGE_PHOTOS_SOURCE_ROOT':str(source)}
        command(['sudo','-n','-E','bash','tools/damage-photos-env.sh','start'],env=env)
        command(['sudo','-n','docker','exec','-w','/app',runner,'npm','run','migrate'])

def run():
    # Frozen baseline source is captured before runtime edits; it is never
    # silently regenerated from the changed workspace.
    assert (OUT/'baseline-source/test').is_dir()
    setup('mbbs-damage-photos-baseline',OUT/'baseline-source')
    setup('mbbs-damage-photos-test',SERVER)
    focus=release.docker('exec','mbbs-damage-photos-test-db','psql','-U','mbt_test','-d','mbt_test','-XAt','-c',
                         "SELECT count(*) FROM pg_database WHERE datname='mbt_focus'").decode().strip()
    if focus=='0': release.docker('exec','mbbs-damage-photos-test-db','createdb','-U','mbt_test','-T','mbt_test','mbt_focus')
    workers=[]
    for label in ['baseline','final']:
        log=(OUT/(label+'-watch.log')).open('wb')
        workers.append((subprocess.Popen(['python3','tools/damage-photos-full-run.py',label],cwd=SERVER,stdout=log,stderr=subprocess.STDOUT),log))
    release.validate_candidate()
    for label,runner in [('baseline','mbbs-damage-photos-baseline-runner'),('final',release.RUNNER)]:
        with (OUT/('types-'+label+'.log')).open('wb') as log:
            result=subprocess.run(['sudo','-n','docker','exec','-w','/app',runner,'node','node_modules/typescript/bin/tsc',
                                   '--project','tsconfig.mbt.json','--noEmit'],stdout=log,stderr=subprocess.STDOUT)
        assert result.returncode==0 or (result.returncode in [1,2] and 'error TS' in (OUT/('types-'+label+'.log')).read_text()), 'Type checker failed to execute'
    for worker,log in workers:
        assert worker.wait()==0;log.close()
    collect()
    command(['python3','tools/damage-photos-live-probe.py'])

if __name__=='__main__':
    {'run':run,'collect':collect}[sys.argv[1]]()

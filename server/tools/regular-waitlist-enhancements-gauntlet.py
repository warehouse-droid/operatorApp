"""Reproduce enhancement validation with fresh snapshots and no production writes."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT=Path(__file__).resolve().parents[1]
RECORDED=ROOT/'test-artifacts/regular-waitlist-enhancements-20261002'
RELEASE=ROOT/'deployments/regular-waitlist-enhancements-20261002'


def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'tools'/file)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report-only',action='store_true')
    args=parser.parse_args()
    if args.report_only:
        subprocess.run(['python3','tools/regular-waitlist-enhancements-report.py'],cwd=ROOT,check=True)
        return
    os.umask(0o077)
    runner=load('enhancement_repro_runner','regular-waitlist-run.py')
    report=load('enhancement_repro_report','regular-waitlist-enhancements-report.py')
    saved=RECORDED/'frozen-baseline'
    recorded_tests=RELEASE/'validation-candidate/test'
    assert saved.exists() and (RELEASE/'candidate').exists() and recorded_tests.exists()
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    out=RECORDED/('reproduce-'+stamp);out.mkdir(exist_ok=False)
    runner.OUT,runner.REMOTE=out,'/tmp/mbbs-waitlist-enhancements-repro-'+stamp
    files=json.loads((ROOT/'tools/regular-waitlist-enhancements-files.json').read_text())
    baseline=out/'source-baseline';shutil.copytree(saved,baseline)
    final=out/'source-final';shutil.copytree(saved,final)
    candidate=out/'source-candidate';shutil.copytree(RELEASE/'candidate',candidate)
    live_before=out/'source-parent';shutil.copytree(RELEASE/'before',live_before)
    for target in [baseline,final,candidate,live_before]:
        shutil.copytree(ROOT/'tools',target/'tools',dirs_exist_ok=True,ignore=shutil.ignore_patterns('__pycache__'))
    for target in [candidate,live_before]:
        shutil.copytree(recorded_tests,target/'test')
        shutil.copy2(saved/'netsuite-smart-scm-picking-ticket-restlet.js',target)
        shutil.copy2(ROOT/'tools/regular-waitlist-enhancements-files.json',target/'tools/regular-waitlist-files.json')
    for group in ['unit','property','integration','adversarial']:
        for source in (recorded_tests/'mbt'/group).glob('regular-waitlist*.test.js'):
            shutil.copy2(source,final/'test/mbt'/group/source.name)
    shutil.copy2(recorded_tests/'support/regular-waitlist-list-harness.mjs',final/'test/support/regular-waitlist-list-harness.mjs')
    for file in files:
        dest=final/file;dest.parent.mkdir(parents=True,exist_ok=True)
        shutil.copy2(candidate/file,dest)
    diffs={}
    for file in files:
        before=RECORDED/'before'/file
        if before.exists():
            dest=out/'before'/file;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(before,dest)
        if file.endswith('.js'):
            with tempfile.NamedTemporaryFile() as blank:
                diff=subprocess.run(['git','diff','--no-index','--unified=0','--',str(before if before.exists() else Path(blank.name)),str(candidate/file)],capture_output=True,text=True)
            assert diff.returncode in [0,1],diff.stderr
            diffs[file]={'sourceHash':hashlib.sha256((candidate/file).read_bytes()).hexdigest(),'diff':diff.stdout}
    (out/'changed-diffs.json').write_text(json.dumps({'files':diffs},indent=2))
    for target in [candidate,live_before]:
        evidence=target/'test-artifacts/regular-waitlist'
        evidence.mkdir(parents=True);shutil.copytree(out/'before',evidence/'before')
        shutil.copy2(out/'changed-diffs.json',evidence/'changed-diffs.json')
    runner.setup()
    runner.docker('exec','-u','0',runner.RUNNER,'node','-e',"const fs=require('fs');if(!fs.existsSync('/browsers'))fs.symlinkSync('/ms-playwright','/browsers','dir')")
    remote=runner.REMOTE
    for suffix,source in [('',candidate),('-baseline',baseline),('-final',final),('-parent',live_before)]:
        path=remote+suffix
        runner.docker('exec',runner.RUNNER,'node','-e',"const fs=require('fs'),p=process.argv[1];fs.rmSync(p,{recursive:true,force:true});fs.mkdirSync(p)",path)
        runner.docker('cp',str(source)+'/.',runner.RUNNER+':'+path)
        runner.docker('exec',runner.RUNNER,'node','-e',"require('fs').symlinkSync('/app/node_modules',process.argv[1]+'/node_modules','dir')",path)
    def run(label,command):
        assert runner.run(label,command)==0,'Verification failed: '+label
    run('schema',['node','src/migrate.js'])
    with ThreadPoolExecutor(max_workers=2) as executor:
        full=[executor.submit(runner.run,label,['node','tools/regular-waitlist-supervised.mjs',label]) for label in ['baseline-full','final-full']]
        run('focused',['node','tools/regular-waitlist-focused.mjs'])
        run('static',['node','tools/regular-waitlist-static.mjs'])
        run('mutations',['node','tools/regular-waitlist-mutations.mjs'])
        run('enhancement-mutations',['node','tools/regular-waitlist-enhancements-mutations.mjs'])
        run('shuffled',['node','tools/regular-waitlist-focused.mjs','--shuffle','--no-coverage'])
        run('c8',['node','node_modules/c8/bin/c8.js','report','--temp-directory=test-artifacts/regular-waitlist/coverage/raw','--report-dir=test-artifacts/regular-waitlist/coverage','--reporter=json'])
        run('coverage',['node','tools/regular-waitlist-coverage.mjs'])
        run('safety',['node','tools/regular-waitlist-safety-check.mjs'])
        assert runner.run('baseline-full-fixture',['node','tools/regular-waitlist-fixture-replay.mjs','baseline'])==0
        run('fixture',['node','tools/regular-waitlist-fixture-replay.mjs','final'])
        versions="const fs=require('fs'),packages={};for(const name of ['typescript','eslint','c8','fast-check','@playwright/test','v8-to-istanbul','pg'])packages[name]=JSON.parse(fs.readFileSync('node_modules/'+name+'/package.json')).version;fs.writeFileSync('test-artifacts/regular-waitlist/versions.json',JSON.stringify({node:process.version,packages},null,2));"
        run('versions',['node','-e',versions])
        for result in full:
            assert result.result() in [0,1], 'The full comparison must finish with its footer.'
    # The parent is the captured live source, separate from the immutable full baseline.
    for label,path in [('affected-baseline',remote+'-parent'),('affected-final',remote)]:
        with (out/(label+'.log')).open('wb') as log:
            subprocess.run(['sudo','-n','docker','exec','-w',path,runner.RUNNER,'node','tools/regular-waitlist-suite.mjs','--affected'],stdout=log,stderr=subprocess.STDOUT,check=False)
    runner.docker('cp',runner.RUNNER+':'+remote+'/test-artifacts/regular-waitlist/.',str(out))
    runner.docker('cp',runner.RUNNER+':'+remote+'-baseline/test-artifacts/regular-waitlist/fixture-baseline.json',str(out/'fixture-baseline.json'))
    for name in ['baseline','final']:
        runner.docker('cp',runner.RUNNER+':'+remote+'-'+name+'/test-artifacts/regular-waitlist/'+name+'-full-timeouts.json',str(out/(name+'-full-timeouts.json')))
    subprocess.run(['sudo','-n','chown','-R',str(os.getuid())+':'+str(os.getgid()),str(out)],check=True)
    result=report.aggregate(out,out,focused='focused.log',shuffled='shuffled.log',affected=['affected-baseline.log','affected-final.log'],fixture_logs=['baseline-full-fixture.log','fixture.log'])
    assert result['sourceHashes']==json.loads((RELEASE/'manifest.json').read_text())['sourceHashes'],'Evidence must match the recorded candidate.'
    (out/'checks.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'completed':True,'evidence':str(out/'checks.json'),'featureTests':result['feature']['pass'],'newFailingFiles':result['newFailures']}))


if __name__=='__main__':
    main()

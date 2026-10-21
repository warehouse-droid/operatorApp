"""Reproduce every verification layer without production writes or NetSuite access.

Requires the recorded cached Docker images; uses a fresh source directory each run.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT=Path(__file__).resolve().parents[1]


def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'tools'/file)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report-only',action='store_true',help='Aggregate the final completed run; do not rerun tests.')
    args=parser.parse_args()
    if args.report_only:
        subprocess.run(['python3','tools/regular-waitlist-report.py','--final','final-full-complete.log','--focused','release-focused-complete.log','--shuffled','release-shuffled-complete.log','--affected-final','release-affected-complete.log'],cwd=ROOT,check=True)
        return
    os.umask(0o077)
    runner=load('waitlist_repro_runner','regular-waitlist-run.py')
    report=load('waitlist_repro_report','regular-waitlist-report.py')
    saved=ROOT/'test-artifacts/regular-waitlist/frozen-baseline'
    captured=ROOT/'test-artifacts/regular-waitlist/before'
    release=ROOT/'deployments/regular-waitlist-20261002'
    assert saved.exists() and (release/'candidate').exists(), 'Preserved baseline and scoped candidate are required.'
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    out=ROOT/'test-artifacts/regular-waitlist'/('reproduce-'+stamp)
    out.mkdir(exist_ok=False)
    runner.OUT=out
    runner.REMOTE='/tmp/mbbs-waitlist-reproduce-'+stamp
    files=json.loads((ROOT/'tools/regular-waitlist-files.json').read_text())
    after=out/'source-after'
    before=out/'source-before'
    for target in [before,after]:
        shutil.copytree(saved,target)
        shutil.rmtree(target/'test')
        for folder in ['test','tools']:
            shutil.copytree(ROOT/folder,target/folder,ignore=shutil.ignore_patterns('__pycache__'))
        shutil.copy2(ROOT/'netsuite-smart-scm-picking-ticket-restlet.js',target)
    for file in files:
        target=after/file
        target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copy2(release/'candidate'/file,target)
        original=captured/file
        if original.exists():
            target=out/'before'/file
            target.parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(original,target)
    diffs={}
    for file in files:
        if not file.endswith('.js'):
            continue
        original=captured/file
        with tempfile.NamedTemporaryFile() as blank:
            result=subprocess.run(['git','diff','--no-index','--unified=0','--',str(original if original.exists() else Path(blank.name)),str(after/file)],capture_output=True,text=True)
        assert result.returncode in [0,1],result.stderr
        diffs[file]={'sourceHash':hashlib.sha256((after/file).read_bytes()).hexdigest(),'diff':result.stdout}
    (out/'changed-diffs.json').write_text(json.dumps({'files':diffs},indent=2))
    runner.setup()
    runner.docker('exec','-u','0',runner.RUNNER,'node','-e',"const fs=require('fs');if(!fs.existsSync('/browsers'))fs.symlinkSync('/ms-playwright','/browsers','dir')")
    runner.ROOT=after
    runner.sync()
    runner.ROOT=ROOT
    remote=runner.REMOTE
    for suffix,source in [('-baseline',before),('-final',after)]:
        runner.docker('exec',runner.RUNNER,'node','-e',"const fs=require('fs'),p=process.argv[1];fs.rmSync(p,{recursive:true,force:true});fs.mkdirSync(p)",remote+suffix)
        runner.docker('cp',str(source)+'/.',runner.RUNNER+':'+remote+suffix)
        runner.docker('exec',runner.RUNNER,'node','-e',"require('fs').symlinkSync('/app/node_modules',process.argv[1]+'/node_modules','dir')",remote+suffix)
    def run(label,command):
        assert runner.run(label,command)==0,'Verification failed: '+label
    run('schema',['node','src/migrate.js'])
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures=[executor.submit(runner.run,label,['node','tools/regular-waitlist-supervised.mjs',mode,*arguments])
                 for label,mode,arguments in [('baseline-full-reproduce','baseline-full',['--baseline']),('final-full-reproduce','final-full',[])]]
        run('focused',['node','tools/regular-waitlist-focused.mjs'])
        run('static',['node','tools/regular-waitlist-static.mjs'])
        run('mutations',['node','tools/regular-waitlist-mutations.mjs'])
        run('shuffled',['node','tools/regular-waitlist-focused.mjs','--shuffle','--no-coverage'])
        run('c8',['node','node_modules/c8/bin/c8.js','report','--temp-directory=test-artifacts/regular-waitlist/coverage/raw','--report-dir=test-artifacts/regular-waitlist/coverage','--reporter=json'])
        run('coverage',['node','tools/regular-waitlist-coverage.mjs'])
        run('safety',['node','tools/regular-waitlist-safety-check.mjs'])
        run('migration-reset',['node','tools/regular-waitlist-verify-setup.mjs','--reset'])
        run('migration',['--verify','node','tools/regular-waitlist-migration.mjs'])
        for future in futures:
            assert future.result() in [0,1], 'A full suite must finish and provide its failure footer.'
    versions="""const fs=require('fs'),packages={};for(const name of ['typescript','eslint','c8','fast-check','@playwright/test','v8-to-istanbul','pg'])packages[name]=JSON.parse(fs.readFileSync('node_modules/'+name+'/package.json')).version;fs.writeFileSync('test-artifacts/regular-waitlist/versions.json',JSON.stringify({node:process.version,packages},null,2));"""
    run('versions',['node','-e',versions])
    runner.docker('cp',runner.RUNNER+':'+remote+'/test-artifacts/regular-waitlist/.',str(out))
    subprocess.run(['sudo','-n','chown','-R',str(os.getuid())+':'+str(os.getgid()),str(out)],check=True)
    result=report.aggregate(out,out,'baseline-full-reproduce.log','final-full-reproduce.log','focused.log','shuffled.log')
    (out/'checks.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'completed':True,'evidence':str(out/'checks.json'),'featureTests':result['feature']['tests'],'newFailingFiles':result['newFailures']}))


if __name__=='__main__':
    main()

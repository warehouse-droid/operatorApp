"""Repeat every scoped verification layer in the isolated Special Order runner.

Uses the frozen release tree when available so unrelated workspace edits cannot
enter the result. Requires the recorded test runner, browser and isolated DB.
Never publishes a release or writes production business data.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess

SERVER=Path(__file__).resolve().parents[1]
OUT=SERVER/'test-artifacts/special-case-fields-20261003'
spec=importlib.util.spec_from_file_location('special_fields_runner',SERVER/'tools/special-case-fields-run.py')
runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)

def main():
    source=SERVER/'deployments/special-case-fields-20261003/candidate-app'
    if not source.exists():source=SERVER
    files=json.loads((SERVER/'tools/special-case-fields-files.json').read_text())
    differences={}
    for file in files:
        old=OUT/'before'/file
        result=subprocess.run(['git','diff','--no-index','--histogram','--unified=0','--',str(old) if old.exists() else '/dev/null',str(source/file)],capture_output=True,text=True)
        assert result.returncode in [0,1],result.stderr
        differences[file]={'sourceHash':hashlib.sha256((source/file).read_bytes()).hexdigest(),
          'baselineHash':hashlib.sha256(old.read_bytes()).hexdigest() if old.exists() else None,'diff':result.stdout}
    OUT.mkdir(exist_ok=True,parents=True)
    (OUT/'changed-diffs.json').write_text(json.dumps({'files':differences},indent=2))
    runner.sync(source)
    try:
        for label,script,args in [('final-exact','check',['all']),('final-mutations','mutations',[]),
            ('final-supplement','supplement',[]),('final-coverage','coverage',[])]:
            assert runner.run(label,['node','tools/special-case-fields-'+script+'.mjs',*args])==0,label+' failed'
    finally:
        runner.docker('cp',runner.RUNNER+':'+runner.REMOTE+'/test-artifacts/special-case-fields-20261003/.',str(OUT))

if __name__=='__main__':main()

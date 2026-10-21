"""Run the isolated Operator group/camera regression and mutation checks."""
from pathlib import Path
import json
import subprocess
import sys
import re
import shutil
import time

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / 'test-artifacts/operator-group-camera'
RUNNER = 'mbbs-regular-v2-runner'
BROWSER = 'mbbs-regular-v2-browser'
GROUP = 'test/mbt/integration/operator-group-draft.test.js'
CAMERA = 'test/dispatch/frontend/operator-auto-camera.browser.test.mjs'

def failures(output):
    return sorted(re.findall(r'^not ok \d+ - (.+)$',output,re.M))

def run(label, container, args, env=None, expect=0, baseline=None):
    cmd = ['sudo','-n','docker','exec']
    for key,value in (env or {}).items(): cmd += ['-e',key+'='+value]
    cmd += [container,'node',*args]
    result = subprocess.run(cmd,capture_output=True,timeout=180)
    (ART/(label+'.log')).write_bytes(result.stdout+result.stderr)
    actual = result.returncode
    ok = actual == 0 if expect == 0 else actual != 0
    known = failures((ART/baseline).read_text()) if baseline else []
    failed = failures(result.stdout.decode())
    if baseline:
        relevant = known if label=='camera' else [name for name in known if name.startswith('P2 ')]
        ok = actual in (0,1) and failed == relevant
    if expect != 0:
        ok = ok and b'not ok' in result.stdout and (b'ERR_ASSERTION' in result.stdout or b'Timeout' in result.stdout)
    row = {'name':label,'exit':actual,'passed':ok,'failures':failed,'baseline':baseline}
    print(json.dumps(row),flush=True)
    return row

def main():
    ART.mkdir(parents=True,exist_ok=True)
    results=[]
    mode=sys.argv[1] if len(sys.argv)>1 else 'all'
    if mode in ('all','tests'):
        for folder in ['node-coverage','browser-coverage']:
            if (ART/folder).exists(): shutil.move(str(ART/folder),str(ART/(folder+'-previous-'+str(time.time_ns()))))
        results.append(run('packing',RUNNER,['--test','--test-concurrency=1',GROUP,
            'test/mbt/integration/group-underpack.test.js','test/dispatch/integration/co-source-packing-handoff.test.js',
            'test/mbt/unit/operator-posting-responsiveness.test.js','test/mbt/unit/operator-delivery-refresh.test.js',
            'test/mbt/unit/operator-delivery-reference.test.js'],
            {'NODE_V8_COVERAGE':'/app/test-artifacts/operator-group-camera/node-coverage'},baseline='legacy-cache-baseline.log'))
        results.append(run('camera',BROWSER,['--test','--test-concurrency=1',CAMERA,
            'test/dispatch/frontend/consolidation-load.browser.test.mjs'],{'OPERATOR_CAMERA_COVERAGE':'1'},baseline='consolidation-baseline.log'))
        results.append(run('static',RUNNER,['tools/operator-group-camera-static.mjs']))
        results.append(run('types',RUNNER,['tools/operator-group-camera-types.mjs']))
    if mode in ('all','mutations'):
        for name,pattern in [('owner','mixed packed'),('draft','current draft returns'),('packing','complete remaining'),('ownership','another operator')]:
            results.append(run('mutant-'+name,RUNNER,['--loader','./tools/operator-group-camera-mutants.mjs',
                '--test','--test-name-pattern='+pattern,GROUP],{'OPERATOR_GROUP_CAMERA_MUTANT':name},1))
        for name,pattern in [('video','desktop: live photo'),('timeout','missing camera frames'),('stale','playback rejection'),('resolution','bounded tablet'),('viewport','Android bottom')]:
            results.append(run('mutant-'+name,BROWSER,['--test','--test-name-pattern='+pattern,CAMERA],{'OPERATOR_GROUP_CAMERA_MUTANT':name},1))
    (ART/(mode+'-results.json')).write_text(json.dumps(results,indent=2))
    if not all(row['passed'] for row in results): sys.exit(1)

if __name__=='__main__': main()

"""Run repair rehearsals on the isolated, already-tested release candidate."""
import json
from pathlib import Path
import subprocess

SERVER=Path(__file__).resolve().parents[1]
OUT=SERVER/'test-artifacts/damage-posting-retry-20261001'
RUNNER='mbbs-damage-posting-retry-test-runner'
REMOTE='/tmp/damage-posting-retry-candidate-20261001'
for file in ['damage-posting-retry-recover.mjs','damage-posting-retry-rehearsal.mjs','damage-posting-retry-recovery-loader.mjs']:
    subprocess.run(['sudo','-n','docker','exec','-i',RUNNER,'node','-e',
                    'require("fs").writeFileSync(process.argv[1],require("fs").readFileSync(0))',
                    REMOTE+'/tools/'+file],input=(SERVER/'tools'/file).read_bytes(),check=True)
results=[]
with (OUT/'rehearsal.log').open('w') as log:
    for mode in ['success','already-repaired','existing-ucara','ambiguous-pisa','bad-backup']:
        run=subprocess.run(['sudo','-n','docker','exec','-w',REMOTE,
                            '-e','DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_focus',RUNNER,
                            'node','--experimental-loader','./tools/damage-posting-retry-recovery-loader.mjs',
                            'tools/damage-posting-retry-rehearsal.mjs',mode],text=True,capture_output=True,timeout=30)
        log.write(mode+'\n'+run.stdout+run.stderr+'\n');log.flush()
        assert run.returncode==0,mode+': '+run.stderr[-2000:]
        result=json.loads(run.stdout.strip().splitlines()[-1]);assert result['rehearsalPassed']
        results.append(result);print(json.dumps(result),flush=True)
(OUT/'rehearsal.json').write_text(json.dumps(results,indent=2)+'\n')

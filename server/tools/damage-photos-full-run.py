"""Run the normal MBT suite; bound pre-existing test-file hangs equally in both runs."""
import json
from pathlib import Path
import subprocess
import sys
import time

SERVER=Path(__file__).resolve().parents[1]
OUT=SERVER/'test-artifacts/damage-photos-20261001'
label=sys.argv[1]
assert label in ['baseline','final']
runner='mbbs-damage-photos-'+('baseline' if label=='baseline' else 'test')+'-runner'
probe=r"""const fs=require('fs');const uptime=Number(fs.readFileSync('/proc/uptime','utf8').split(' ')[0]);
const rows=fs.readdirSync('/proc').filter(p=>/^\d+$/.test(p)).flatMap(p=>{try{const fields=fs.readFileSync('/proc/'+p+'/stat','utf8').replace(/^\d+ \(.*\) /,'').split(' ');return [{pid:Number(p),ppid:Number(fields[1]),seconds:uptime-Number(fields[19])/100,args:fs.readFileSync('/proc/'+p+'/cmdline','utf8').split('\0')}];}catch{return [];}});
const alive=rows.some(r=>r.args.some(a=>a.endsWith('/run-node-tests.mjs')||a==='test/support/run-node-tests.mjs'));
const hung=rows.filter(r=>r.args.includes('--test')&&r.args.includes('--test-reporter=spec')&&r.seconds>60);
for(const root of hung){const children=[];function descend(pid){for(const r of rows.filter(r=>r.ppid===pid)){descend(r.pid);children.push(r.pid);}}descend(root.pid);
for(const pid of [...children,root.pid]){try{process.kill(pid,'SIGKILL');}catch{}}}
console.log(JSON.stringify({alive,hung:hung.map(r=>({file:r.args.at(-2),seconds:Math.round(r.seconds),pid:r.pid}))}));"""
process=None
initial=json.loads(subprocess.check_output(['sudo','-n','docker','exec',runner,'node','-e',probe]))
if not initial['alive']:
    with (OUT/(label+'-full.log')).open('wb') as log:
        process=subprocess.Popen(['sudo','-n','docker','exec','-w','/app',runner,'npm','test'],stdout=log,stderr=subprocess.STDOUT)
    time.sleep(2)
interventions=[]
while True:
    state=json.loads(subprocess.check_output(['sudo','-n','docker','exec',runner,'node','-e',probe]))
    for item in state['hung']:
        interventions.append(item)
        print(json.dumps({'testFileTimeout':item}),flush=True)
    if not state['alive']:
        break
    time.sleep(5)
if process is not None:
    code=process.wait(timeout=10)
else:
    code=None
(OUT/(label+'-timeouts.json')).write_text(json.dumps({'fileBudgetSeconds':60,'interventions':interventions,'exitCode':code},indent=2)+'\n')
print(json.dumps({'label':label,'fileTimeouts':len(interventions),'exitCode':code}),flush=True)

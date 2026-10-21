"""Run the normal MBT suite; bound pre-existing test-file hangs equally in both runs."""
import json
from pathlib import Path
import subprocess
import sys
import time

SERVER=Path(__file__).resolve().parents[1]
OUT=SERVER/'test-artifacts/damage-posting-retry-20261001'
label=sys.argv[1]
assert label in ['baseline','final']
runner=('mbbs-damage-posting-retry-comparison-'+label+'-runner' if '--comparison' in sys.argv
        else 'mbbs-damage-posting-retry-'+('baseline' if label=='baseline' else 'test')+'-runner')
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
    # MBT clones this base database for every file. Finish initialization before
    # any clone starts; a simultaneous migration can be terminated by cloning.
    with (OUT/(label+'-fixture-setup.log')).open('wb') as log:
        subprocess.run(['sudo','-n','docker','exec','-w','/app',runner,'npm','run','migrate'],
                       stdout=log,stderr=subprocess.STDOUT,check=True,timeout=120)
    verify=r"""import assert from 'node:assert/strict';import fs from 'node:fs';import pg from 'pg';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED,'false');
const db=new pg.Client({connectionString:process.env.DATABASE_URL});await db.connect();
try {const applied=(await db.query('SELECT filename FROM schema_migrations ORDER BY filename')).rows.map(r=>r.filename);
assert.deepEqual(applied,fs.readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort());
assert.ok((await db.query("SELECT to_regclass('inventory_damage_reports') AS table_name")).rows[0].table_name);
console.log(JSON.stringify({fullyMigrated:true,migrations:applied.length}));}finally{await db.end();}"""
    verified=subprocess.check_output(['sudo','-n','docker','exec','-w','/app',runner,'node','--input-type=module','-e',verify])
    (OUT/(label+'-fixture-verified.json')).write_bytes(verified)
    print(verified.decode().strip(),flush=True)
    with (OUT/(label+'-full.log')).open('wb') as log:
        process=subprocess.Popen(['sudo','-n','docker','exec','-w','/app',runner,'npm','test'],stdout=log,stderr=subprocess.STDOUT)
    time.sleep(2)
state_file=OUT/(label+'-timeouts.json')
interventions=(json.loads(state_file.read_text()).get('interventions',[]) if process is None and state_file.exists() else [])
while True:
    state=json.loads(subprocess.check_output(['sudo','-n','docker','exec',runner,'node','-e',probe]))
    for item in state['hung']:
        interventions.append(item)
        print(json.dumps({'testFileTimeout':item}),flush=True)
        state_file.write_text(json.dumps({'fileBudgetSeconds':60,'interventions':interventions,'exitCode':None,'running':True},indent=2)+'\n')
    if not state['alive']:
        if process is not None and process.poll() is None:
            time.sleep(1)
            continue
        confirmation=json.loads(subprocess.check_output(['sudo','-n','docker','exec',runner,'node','-e',probe]))
        if not confirmation['alive']: break
    time.sleep(5)
if process is not None:
    code=process.wait(timeout=10)
else:
    code=None
(OUT/(label+'-timeouts.json')).write_text(json.dumps({'fileBudgetSeconds':60,'interventions':interventions,'exitCode':code},indent=2)+'\n')
print(json.dumps({'label':label,'fileTimeouts':len(interventions),'exitCode':code}),flush=True)

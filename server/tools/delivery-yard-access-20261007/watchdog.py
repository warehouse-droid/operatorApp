"""Bound stalled full-suite files without touching any production process."""
import json
import re
import subprocess
import sys
import time
from pathlib import Path

OUT = Path(__file__).resolve().parents[2] / 'test-artifacts/delivery-yard-access-20261007'
tasks = {
    'mbbs-delivery-yard-access-20261007-component-baseline': OUT / 'component-baseline-runner.log',
    'mbbs-delivery-yard-access-20261007-gauntlet': OUT / 'gauntlet-runner.log',
    'mbbs-delivery-yard-access-20261007': OUT / 'baseline-runner.log',
    'mbbs-delivery-yard-access-20261007-final': OUT / 'full-final.log',
    'mbbs-delivery-yard-access-20261007-baseline': OUT / 'baseline-runner.log'
}
if len(sys.argv) > 1:
    tasks = {sys.argv[1]: tasks[sys.argv[1]]}
events = []
seen = set()
observed = {}
probe = """const fs=require('fs');const target=process.argv[1];
const roots=[],parents=new Map();
for(const name of fs.readdirSync('/proc')){
 if(!/^\\d+$/.test(name)||Number(name)===process.pid)continue;
 let args;try{args=fs.readFileSync('/proc/'+name+'/cmdline','utf8').split('\\0');}catch{continue;}
 try{parents.set(Number(name),Number(fs.readFileSync('/proc/'+name+'/status','utf8').match(/^PPid:\\s+(\\d+)/m)[1]));}catch{continue;}
 if(args[0]?.endsWith('/node')&&args.some(arg=>arg===target||arg==='/app/'+target))roots.push(Number(name));
}
const victims=new Set(roots);
for(let changed=true;changed;){changed=false;for(const [pid,parent] of parents){if(victims.has(parent)&&!victims.has(pid)){victims.add(pid);changed=true;}}}
for(const pid of [...victims].reverse()){
 try{process.kill(pid,'SIGKILL');console.log(JSON.stringify({killedTestPid:pid,file:target}));}catch(error){if(error.code!=='ESRCH')throw error;}
}"""
idle = 0
while idle < 12:
    alive = False
    for project, log in tasks.items():
        ids = subprocess.check_output(['docker', 'ps', '--filter', 'label=com.mbbs.task=' + project,
                                      '--filter', 'label=com.mbbs.lifecycle=disposable-test', '--format', '{{.ID}}']).decode().split()
        containers = [json.loads(subprocess.check_output(['docker', 'inspect', identifier]))[0] for identifier in ids]
        runners = [row for row in containers if row['Config']['Labels'].get('com.docker.compose.service') == 'test']
        if not runners or not log.exists():
            continue
        alive = True
        text = log.read_text(errors='replace')
        boundaries = re.findall(r'^\[isolation\].*? ((?:/app/)?test/mbt/.*)$', text, re.M)
        if not boundaries:
            continue
        file = boundaries[-1].removeprefix('/app/')
        identity = (project, file)
        if project not in observed or observed[project][0] != file:
            observed[project] = (file, time.monotonic())
        if identity in seen or time.monotonic() - observed[project][1] < 120:
            continue
        row = runners[0]
        assert row['HostConfig']['CgroupParent'] == 'mbbs-tests.slice'
        assert row['HostConfig']['PidMode'] != 'host'
        assert row['Config']['Labels']['com.mbbs.task'] == project
        result = subprocess.run(['docker', 'exec', row['Id'], 'node', '-e', probe, file], capture_output=True, text=True, check=True)
        if result.stdout.strip():
            seen.add(identity)
            with log.open('a') as output:
                output.write('\n[gauntlet-timeout] ' + file + '\n')
            events.append({'project': project, 'file': file, 'maxFileSeconds': 120, 'processes': result.stdout.strip().splitlines()})
            (OUT / 'watchdog.json').write_text(json.dumps(events, indent=2))
            print(json.dumps(events[-1]), flush=True)
    idle = 0 if alive else idle + 1
    time.sleep(5)

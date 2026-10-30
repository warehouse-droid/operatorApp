"""Fail a stuck disposable Node test without blocking subsequent test files.

Node's own 180-second timeout can wait on a blocked browser cleanup. After a
30-second grace period this kills only descendants of that file's --test
process, leaving the Node reporter alive to record the failed file.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
project = sys.argv[1]
parent_pid = int(project.removeprefix('mbbs-worktree-check-'))
assert project == 'mbbs-worktree-check-' + str(parent_pid)
report_path = ROOT / 'server/test/whole-worktree-deployment-20261030-timeouts.json'
events = []
script = r"""
const fs=require('fs');const rows=[];const ticks=Number(process.argv[1]);
const uptime=Number(fs.readFileSync('/proc/uptime','utf8').split(' ')[0]);
for(const id of fs.readdirSync('/proc')){
 if(!/^\d+$/.test(id))continue;
 try{const raw=fs.readFileSync('/proc/'+id+'/stat','utf8');const fields=raw.slice(raw.lastIndexOf(')')+2).split(' ');
 const args=fs.readFileSync('/proc/'+id+'/cmdline','utf8').split('\0');
 rows.push({pid:Number(id),parent:Number(fields[1]),elapsed:uptime-Number(fields[19])/ticks,args});}catch{}
}
for(const row of rows){
 const file=row.args.find(v=>/^\/app\/test\/.*\.test\.(?:js|mjs)$/.test(v));
 if(!row.args.includes('--test')||!file||row.elapsed<210)continue;
 const descendants=[];function visit(pid){for(const child of rows.filter(r=>r.parent===pid)){visit(child.pid);descendants.push(child.pid);}}
 visit(row.pid);if(!descendants.length)continue;
 for(const pid of descendants){try{process.kill(pid,'SIGKILL');}catch{}}
 console.log(JSON.stringify({file,elapsedSeconds:Math.round(row.elapsed),terminatedTestChildren:descendants.length}));
}
"""

while Path('/proc/' + str(parent_pid)).exists():
    try:
        ids = subprocess.check_output(['docker', 'ps', '-q', '--filter', 'label=com.docker.compose.project=' + project,
            '--filter', 'label=com.mbbs.lifecycle=disposable-test']).decode().split()
        if ids:
            rows = json.loads(subprocess.check_output(['docker', 'inspect', *ids]))
            for row in rows:
                if row['Config']['Labels'].get('com.docker.compose.service') != 'test': continue
                output = subprocess.run(['docker', 'exec', row['Id'], 'node', '-e', script, str(os.sysconf('SC_CLK_TCK'))],
                    capture_output=True, text=True, timeout=10)
                for line in output.stdout.splitlines():
                    event = json.loads(line)
                    source = next(m['Source'] for m in row['Mounts'] if m['Destination'] == '/app/src')
                    event['source'] = 'baseline' if '/live-source/' in source else 'candidate'
                    events.append(event)
                    report_path.write_text(json.dumps({'fileDeadlineSeconds': 180, 'cleanupGraceSeconds': 30, 'events': events}, indent=2) + '\n')
                    print(json.dumps(event), flush=True)
    except (subprocess.SubprocessError, OSError, ValueError):
        pass
    time.sleep(5)

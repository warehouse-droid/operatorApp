"""Bound hung isolated test files; report every timeout as a failure, never a skip."""
import json, pathlib, subprocess, time

out=pathlib.Path(__file__).resolve().parents[2]/'test-artifacts/to-linked-so-20261004/timeouts.jsonl'
deadline=time.time()+7200
while time.time()<deadline:
    result=subprocess.run(['docker','exec','mbbs-to-reference-20261003-runner','ps','-eo','pid,etimes,args'],capture_output=True,text=True)
    for line in result.stdout.splitlines():
        parts=line.strip().split(None,2)
        if len(parts)!=3 or not parts[0].isdigit() or not parts[1].isdigit(): continue
        pid,seconds,command=parts
        if int(seconds)<120 or '--test-concurrency=1 /' not in command: continue
        if '/baseline/test/mbt/' not in command and '/app/test/mbt/' not in command: continue
        with out.open('a') as f: f.write(json.dumps({'pid':pid,'seconds':int(seconds),'command':command})+'\n')
        subprocess.run(['docker','exec','mbbs-to-reference-20261003-runner','kill','-KILL',pid],capture_output=True)
    time.sleep(10)

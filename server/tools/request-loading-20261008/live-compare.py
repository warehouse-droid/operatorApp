"""Read-only differential probe; no test containers or persistent DB writes."""
import json,subprocess,sys
from pathlib import Path
root=Path(__file__).resolve().parents[2]
release=root/'deployments/request-loading-performance-20261008'
out=root/'test-artifacts/request-loading-performance-20261008'
mode=sys.argv[1] if len(sys.argv)>1 else 'live-compare'
pid=json.loads(subprocess.check_output(['docker','inspect','mbbs-operator-app-app-1']))[0]['State']['Pid']
sources={}
for name in ['special-stock-planning.js','special-stock-request-repository.js','stock-request-repository.js']:
    sources['file:///app/src/'+name]=(release/'candidate/src'/name).read_text()
sql=(release/'candidate/migrations/275_request_completion_lookup.sql').read_text().split(' AS\n',1)[1].split(';\n',1)[0]
stage_sql=(release/'candidate/migrations/275_request_completion_lookup.sql').read_text().split('CREATE OR REPLACE VIEW special_stock_workflow_stages AS\n')[1].split(';\n',1)[0]
priority_sql=(release/'candidate/migrations/275_request_completion_lookup.sql').read_text().split('dispatch_completion_evidence_priority(evidence_type text)',1)[1].split('SELECT ',1)[1].split(';',1)[0]
script='const priorityExpression='+json.dumps(priority_sql)+';\nconst candidateStageView='+json.dumps(stage_sql)+';\nconst inlinePlanningIndex='+json.dumps(mode.startswith('live-index-equivalence'))+';\nconst indexDefinition='+json.dumps((release/'candidate/migrations/275_request_completion_lookup.sql').read_text().split('AS $$',1)[1].split('$$;',1)[0])+';\nconst sourceFiles='+json.dumps(sources)+';\nconst candidateView='+json.dumps(sql)+';\n'+(Path(__file__).parent/(mode+'.mjs') if (Path(__file__).parent/(mode+'.mjs')).exists() else Path(__file__).with_suffix('.mjs')).read_text()
unit='mbbs-request-load-compare'
command=['sudo','-n','systemd-run','--quiet','--collect','--wait','--pipe','--unit='+unit,'--slice=mbbs-tests.slice',
 '-p','CPUQuota=100%','-p','MemoryMax=1G','-p','MemorySwapMax=0','-p','TasksMax=128','-p','RuntimeMaxSec=240',
 '/usr/bin/nsenter','--target',str(pid),'--mount','--net','--pid','--root','--wd','--','/usr/local/bin/node','--input-type=module','-']
try:
    with (out/(mode+'.jsonl')).open('w') as log:
        result=subprocess.run(command,input=script,text=True,stdout=log,stderr=subprocess.STDOUT,timeout=250)
    print(json.dumps({'exit':result.returncode,'evidence':str(out/(mode+'.jsonl'))}),flush=True)
    sys.exit(result.returncode)
finally:
    subprocess.run(['sudo','-n','systemctl','stop',unit],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)

import json,subprocess
from pathlib import Path
here=Path(__file__).resolve().parent;server=here.parents[1];out=Path('/home/ubuntu/operatorapp-investigations/operator-review-navigation-20261003')
args=['docker','run','--rm','--network','container:mbbs-incident-review-db','-w','/app','-e','DATABASE_URL=postgres://incident_test:incident_local_test@127.0.0.1:5432/incident_test','-e','APP_ENV=test','-e','NETSUITE_DIRECT_ACCESS_ENABLED=false']
for src,dst in [(out/'candidate/src','/app/src'),(out/'candidate/public','/app/public'),(out/'candidate/migrations','/app/migrations'),(server/'test','/app/test'),(here,'/app/tools/incident')]:args+=['--mount',f'type=bind,src={src},dst={dst},readonly']
args+=['--entrypoint','node','mbbs-regular-v2:e2e']
for name,command in [('db-migrations',['src/migrate.js']),('db-regression',['--test','--test-concurrency=1','test/mbt/integration/operator-netsuite-posting-repository.red.test.js','test/mbt/concurrency/operator-netsuite-posting-concurrency.test.js','tools/incident/review-rule-db.test.mjs'])]:
 r=subprocess.run(args+command,text=True,capture_output=True,timeout=240);(out/(name+'.log')).write_text(r.stdout+r.stderr)
 report={'exit':r.returncode,'counts':[l for l in r.stdout.splitlines() if l.startswith(('# tests ','# pass ','# fail '))]};(out/(name+'.json')).write_text(json.dumps(report));print(name,json.dumps(report))
 if r.returncode:raise SystemExit(r.returncode)

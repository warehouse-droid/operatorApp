"""Capture read-only production preparation metadata, without credentials."""
import hashlib
import json
from pathlib import Path
import subprocess

ROOT=Path(__file__).resolve().parents[2]
TASK=ROOT/'tools/backorder-enhancements-20261007'
OUT=ROOT/'test-artifacts/backorder-enhancements-20261007'
APP='mbbs-operator-app-app-1'
sha=lambda value:hashlib.sha256(value).hexdigest()

def docker(*args):
    return subprocess.check_output(['docker',*args])

def main():
    baseline={}
    for file in json.loads((TASK/'files.json').read_text()):
        old=TASK/'baseline'/file
        if old.exists():
            live=docker('exec',APP,'cat','/app/'+file)
            assert sha(live)==sha(old.read_bytes()),'Production source differs from captured baseline: '+file
            baseline[file]=sha(live)
    script="import {query,closeDb} from './src/db.js';try{console.log(JSON.stringify((await query('SELECT filename FROM schema_migrations ORDER BY filename')).rows.map(r=>r.filename)));}finally{await closeDb();}"
    migrations=json.loads(docker('exec','-w','/app',APP,'node','--input-type=module','-e',script))
    (OUT/'production-migrations.json').write_text(json.dumps(migrations,indent=2))
    images={name:docker('inspect','--format','{{.Image}}',name).decode().strip() for name in [APP,'mbbs-operator-app-db-1','mbbs-operator-app-webhook-worker-1','mbbs-operator-app-ollama-1']}
    result={'migrationCount':len(migrations),'migration268Applied':'268_regular_backorder.sql' in migrations,'baselineHashes':baseline,'images':images}
    (OUT/'production-baseline.json').write_text(json.dumps(result,indent=2));print(json.dumps({'migrationCount':len(migrations),'sourceFilesMatched':len(baseline)}))

if __name__=='__main__':main()

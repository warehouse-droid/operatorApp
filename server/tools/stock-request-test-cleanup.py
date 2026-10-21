"""Exact-scope SPREQ backup, rollback rehearsal, and user-authorized local deletion."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess

SERVER = Path(__file__).resolve().parents[1]
PRIVATE = SERVER / 'test-artifacts/stock-request-cleanup-layout/private'

def durable(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)

def run(mode, expected=None):
    module = base64.b64encode(Path(__file__).with_suffix('.mjs').read_bytes()).decode()
    code = "import {pool} from './src/db.js'; const client=await pool.connect(); try { const {execute}=await import('data:text/javascript;base64," + module + "'); console.log(JSON.stringify(await execute(client," + json.dumps({'mode':mode,'expected':expected}) + "))); } catch(error) { console.error(error.message); process.exitCode=1; } finally {client.release(); await pool.end();}"
    result = subprocess.run(['sudo','-n','docker','exec','-i','-w','/app','mbbs-operator-app-app-1','node','--input-type=module','-'],input=code,capture_output=True,text=True)
    if result.returncode:
        raise RuntimeError(result.stderr[-2000:])
    return json.loads(result.stdout)

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('mode',choices=['backup','rehearse','apply'])
    args=parser.parse_args()
    PRIVATE.mkdir(parents=True,exist_ok=True,mode=0o700)
    PRIVATE.chmod(0o700)
    backup=PRIVATE/'SPREQ-000002-through-000009.json'
    if args.mode == 'backup':
        result=run('backup')
        durable(backup,result['payload'].encode())
        snapshot=json.loads(result['payload'])
        print(json.dumps({'backup':str(backup),'sha256':hashlib.sha256(backup.read_bytes()).hexdigest(),'counts':{table:len(rows) for table,rows in snapshot['rows'].items()}}))
        return
    expected=hashlib.sha256(backup.read_bytes()).hexdigest()
    if args.mode == 'apply':
        proof=json.loads((PRIVATE/'rehearsal.json').read_text())
        assert proof['restorationVerified'] and proof['backupSha256']==expected
        # Persist intent before COMMIT so even a lost response is auditable.
        durable(PRIVATE/'apply-intent.json',json.dumps({'backupSha256':expected,'scope':'application SPREQ only; preserve NetSuite and local orders'}).encode())
    result=run(args.mode,expected)
    durable(PRIVATE/('rehearsal.json' if args.mode=='rehearse' else 'deletion-receipt.json'),json.dumps(result,indent=2).encode())
    print(json.dumps(result))

if __name__ == '__main__':
    main()

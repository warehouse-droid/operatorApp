"""Run the authorized TOB01208 repair through verified, durable posting."""
import base64
import datetime
import json
import os
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
STATE = pathlib.Path('/home/ubuntu/operatorapp-deploy-backups/to01208-delivery-prep')


def source():
    proof = (ROOT / 'server/tools/operator-to-yard-flow-reconciliation-proof.mjs').read_text().replace("from '../src/", "from 'file:///app/src/")
    uri = 'data:text/javascript;base64,' + base64.b64encode(proof.encode()).decode()
    program = (ROOT / 'server/tools/operator-to-direct-customer-reconcile.mjs').read_text()
    return program.replace("'./operator-to-yard-flow-reconciliation-proof.mjs'", json.dumps(uri)).replace("from '../src/", "from './src/")


if __name__ == '__main__':
    os.umask(0o077)
    mode = sys.argv[1]
    assert mode in ['plan', 'apply', 'verify']
    evidence_path = sorted(STATE.glob('netsuite-*.private.json'))[-1]
    evidence = json.loads(evidence_path.read_text())
    program = source() + '\nimport {closeDb} from "./src/db.js";\nconst evidence=' + json.dumps(evidence) + ';\n'
    action = 'verifyAndReconcileDirectReceipt(evidence)' if mode == 'verify' else 'reconcileCompletedDirectTransfer(evidence,{apply:' + str(mode == 'apply').lower() + '})'
    program += 'try{console.log("MBBS_TO_DIRECT_RESULT:"+JSON.stringify(await ' + action + '));}finally{await closeDb();}\n'
    completed = subprocess.run(['sudo', '-n', 'docker', 'exec', '-i', '-w', '/app',
        'mbbs-operator-app-app-1', 'node', '--input-type=module'], input=program, text=True, cwd=ROOT, capture_output=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    target = STATE / f'direct-{mode}-{stamp}.private.json'
    log = STATE / f'direct-{mode}-{stamp}.logs.private.json'
    log.write_text(json.dumps({'exitCode': completed.returncode, 'stdout': completed.stdout, 'stderr': completed.stderr}, indent=2) + '\n')
    log.chmod(0o600)
    if completed.returncode:
        target.write_text(json.dumps({'exitCode': completed.returncode, 'stdout': completed.stdout, 'stderr': completed.stderr}, indent=2) + '\n')
        target.chmod(0o600)
        print(json.dumps({'status': 'error', 'exitCode': completed.returncode, 'privateEvidence': str(target)}))
        sys.exit(completed.returncode)
    rows = [line.removeprefix('MBBS_TO_DIRECT_RESULT:') for line in completed.stdout.splitlines()
            if line.startswith('MBBS_TO_DIRECT_RESULT:')]
    assert len(rows) == 1, 'Inspect the saved private execution log before any retry.'
    result = json.loads(rows[0])
    target.write_text(json.dumps(result, indent=2) + '\n')
    target.chmod(0o600)
    safe = {key: value for key, value in result.items() if key not in ['command', 'result']}
    if 'command' in result:
        safe['commandStatus'] = result['command'].get('status') if result['command'] else None
        safe['transactions'] = result.get('result', {}).get('transactions', [])
    print(json.dumps(safe, indent=2))

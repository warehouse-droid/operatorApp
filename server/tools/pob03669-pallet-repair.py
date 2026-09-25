#!/usr/bin/env python3
"""Scoped incident runner. All snapshots are private; default action is capture."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

parser = argparse.ArgumentParser()
parser.add_argument('mode', choices=['capture', 'rehearse', 'apply', 'verify'], nargs='?', default='capture')
parser.add_argument('--fault', choices=['source', 'quantity', 'orderline'], default='')
args = parser.parse_args()
if args.fault and args.mode != 'rehearse':
    parser.error('Fault injection is allowed only in a rollback rehearsal.')
root = Path(__file__).resolve().parents[2]
script_path = Path(__file__).with_suffix('.mjs')
backup = Path('/home/ubuntu/operatorapp-deploy-backups/pob03669-pallet-repair-20260916')
backup.mkdir(mode=0o700, parents=True, exist_ok=True)
os.chmod(backup, 0o700)
os.umask(0o077)
source = script_path.read_text()
source_hash = hashlib.sha256(source.encode()).hexdigest()
evidence = None if args.mode == 'capture' else json.loads((backup / 'evidence.json').read_text())
if args.mode == 'apply':
    rehearsal = json.loads((backup / 'rehearse.json').read_text())
    if rehearsal['sourceHash'] != source_hash or not rehearsal['rollbackVerified']:
        raise SystemExit('A successful rehearsal of this exact runner is required.')
    if rehearsal['evidenceHash'] != hashlib.sha256(json.dumps(evidence, sort_keys=True).encode()).hexdigest():
        raise SystemExit('Rehearse the current evidence before applying.')
    for fault in ['source', 'quantity', 'orderline']:
        result = json.loads((backup / f'rehearse-{fault}.json').read_text())
        if result['sourceHash'] != source_hash or not result['rejected'] or not result['rollbackVerified']:
            raise SystemExit('All negative rollback checks must pass for this runner.')
prefix = 'const evidenceInput = JSON.parse(' + json.dumps(json.dumps(evidence)) + ');\n'
command = ['docker', 'exec', '-i', 'mbbs-operator-app-app-1', 'node', '--input-type=module', '-', args.mode, args.fault]
result = subprocess.run(command, input=prefix + source, text=True, capture_output=True, timeout=240)
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
name = args.mode + ('-' + args.fault if args.fault else '')
(backup / f'{name}-{stamp}.stderr.log').write_text(result.stderr)
if result.returncode:
    print(result.stderr[-6000:], file=sys.stderr)
    raise SystemExit(result.returncode)
line = next((line for line in result.stdout.splitlines() if line.startswith('POB03669_REPAIR_RESULT ')), None)
if line is None:
    raise SystemExit('Runner did not produce a result; inspect production before retrying.')
output = json.loads(line.removeprefix('POB03669_REPAIR_RESULT '))
output['sourceHash'] = source_hash
output['evidenceHash'] = hashlib.sha256(json.dumps(evidence, sort_keys=True).encode()).hexdigest()
output['checkedAt'] = stamp
if args.mode == 'capture':
    (backup / 'evidence.json').write_text(json.dumps(output['evidence'], indent=2) + '\n')
(backup / f'{name}-{stamp}.json').write_text(json.dumps(output, indent=2) + '\n')
(backup / f'{name}.json').write_text(json.dumps(output, indent=2) + '\n')
safe = {key: value for key, value in output.items() if key not in ['evidence', 'after', 'result']}
if args.mode == 'capture':
    safe['capturedAt'] = output['evidence']['capturedAt']
    safe['receipts'] = output['evidence']['receipts']
    safe['linkedReceiptCount'] = len({row['transactionId'] for row in output['evidence']['transactions']})
safe['privateBackup'] = str(backup)
print(json.dumps(safe))

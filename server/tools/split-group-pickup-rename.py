"""Back up, rehearse, guard and apply the requested group identity rename."""
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / 'test-artifacts/split-group-pickup'
PRIVATE = Path('/home/ubuntu/operatorapp-investigations/sob120921-20260923')
APP = 'mbbs-operator-app-app-1'


def invoke(options=None, check=True):
    result = subprocess.run(['sudo','-n','docker','exec','-i','-e','SPLIT_GROUP_RENAME_OPTIONS=' + json.dumps(options or {}),
                             APP,'node','--input-type=module'], input=(ROOT / 'tools/rename-split-group.mjs').read_bytes(), capture_output=True)
    if not check:
        return result
    if result.returncode:
        raise RuntimeError(result.stderr.decode())
    return json.loads(result.stdout)


def save(name, result):
    (ART / name).write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result), flush=True)


def challenge():
    before = invoke()
    assert before['rolledBack'] and not before['applied']
    backup = '/tmp/split-group-refused-' + uuid.uuid4().hex + '.json'
    result = invoke({'apply': True, 'requirePickupHidden': True, 'expectedFingerprint': 'stale', 'backupPath': backup}, check=False)
    assert result.returncode and b'Incident changed; rehearse again' in result.stderr, result.stderr.decode()
    assert subprocess.run(['sudo','-n','docker','exec',APP,'test','!','-e',backup]).returncode == 0
    after = invoke()
    assert after['beforeFingerprint'] == before['beforeFingerprint']
    save('rename-guard.json', {'staleStateRefused': True, 'stateUnchangedAfterRehearsal': True,
                              'backupNotWrittenOnRefusal': True, 'fingerprint': after['beforeFingerprint']})


def apply():
    before = invoke({'requirePickupHidden': True})
    save('rename-rehearsal.json', before)
    if before.get('alreadyCorrect'):
        save('rename-idempotence.json', before)
        return
    backup = '/tmp/split-group-before-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '.json'
    try:
        result = invoke({'apply': True, 'requirePickupHidden': True,
                         'expectedFingerprint': before['beforeFingerprint'], 'backupPath': backup})
    finally:
        captured = subprocess.run(['sudo','-n','docker','exec',APP,'cat',backup], capture_output=True)
        if captured.returncode == 0:
            PRIVATE.mkdir(parents=True, exist_ok=True)
            with (PRIVATE / Path(backup).name).open('xb') as output:
                output.write(captured.stdout)
    assert result['applied'] and result['checks']['pickupHidden']
    save('rename-applied.json', result)
    repeated = invoke({'requirePickupHidden': True})
    assert repeated['alreadyCorrect'] and not repeated['applied'] and int(repeated['revision']) == result['newRevision']
    save('rename-idempotence.json', repeated)


if __name__ == '__main__':
    os.umask(0o077)
    {'challenge': challenge, 'apply': apply,
     'verify': lambda: save('rename-verification.json', invoke({'requirePickupHidden': True}))}[sys.argv[1]]()

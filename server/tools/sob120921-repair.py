"""Rehearse, challenge, apply and verify the authorized SOB120921 repair."""
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

SERVER = Path(__file__).resolve().parents[1]
ARTIFACTS = SERVER / 'test-artifacts/rejected-edit-lifecycle'
PRIVATE = Path('/home/ubuntu/operatorapp-investigations/sob120921-20260923')
APP = 'mbbs-operator-app-app-1'


def invoke(options=None, check=True):
    command = ['sudo', '-n', 'docker', 'exec', '-i', '-e',
               'SOB120921_REPAIR_OPTIONS=' + json.dumps(options or {}), APP, 'node', '--input-type=module']
    result = subprocess.run(command, input=(SERVER / 'tools/repair-sob120921-group.mjs').read_bytes(), capture_output=True)
    if check:
        if result.returncode:
            raise RuntimeError(result.stderr.decode())
        return json.loads(result.stdout)
    return result


def save(name, result):
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    (ARTIFACTS / name).write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result), flush=True)


def rehearse():
    result = invoke()
    save('repair-rehearsal.json', result)
    return result


def challenge():
    before = invoke()
    assert before['rolledBack'] and not before['applied']
    backup = '/tmp/sob120921-refused-' + uuid.uuid4().hex + '.json'
    result = invoke({'apply': True, 'expectedFingerprint': 'stale-state', 'backupPath': backup}, check=False)
    assert result.returncode != 0 and b'Incident state changed; rehearse again' in result.stderr, result.stderr.decode()
    absent = subprocess.run(['sudo', '-n', 'docker', 'exec', APP, 'test', '!', '-e', backup])
    assert absent.returncode == 0, 'A rejected repair unexpectedly wrote a backup'
    after = invoke()
    assert after['beforeFingerprint'] == before['beforeFingerprint'], 'Rollback or rejected repair changed live state'
    save('repair-guard.json', {'staleFingerprintRejected': True, 'stateUnchanged': True,
                              'backupNotCreatedOnRejection': True, 'fingerprint': after['beforeFingerprint']})


def apply():
    before = rehearse()
    if before.get('alreadyCorrect'):
        save('repair-idempotence.json', before)
        return
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = '/tmp/sob120921-before-' + stamp + '.json'
    PRIVATE.mkdir(parents=True, exist_ok=True)
    try:
        result = invoke({'apply': True, 'expectedFingerprint': before['beforeFingerprint'], 'backupPath': backup})
    finally:
        captured = subprocess.run(['sudo', '-n', 'docker', 'exec', APP, 'cat', backup], capture_output=True)
        if captured.returncode == 0:
            with (PRIVATE / Path(backup).name).open('xb') as output:
                output.write(captured.stdout)
    assert result['applied'] and not result['rolledBack']
    save('repair-applied.json', result)
    after = invoke()
    assert after['alreadyCorrect'] and not after['applied'] and after['revision'] == result['newRevision']
    save('repair-idempotence.json', after)


if __name__ == '__main__':
    os.umask(0o077)
    {'rehearse': rehearse, 'challenge': challenge, 'apply': apply, 'verify': rehearse}[sys.argv[1]]()

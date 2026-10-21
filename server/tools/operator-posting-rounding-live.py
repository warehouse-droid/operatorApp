"""Save private live recovery evidence without printing order/photo payloads."""
import datetime
import importlib.util
import json
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
STATE = pathlib.Path('/home/ubuntu/operatorapp-deploy-backups/operator-rounding-20261010')
ARTIFACT = ROOT / 'server/test-artifacts/operator-posting-rounding'
spec = importlib.util.spec_from_file_location('rounding_live', ROOT / 'server/tools/operator-to-yard-flow-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
os.umask(0o077)
mode = sys.argv[1]
assert mode in ['inspect', 'recover', 'verify']
manifest = json.loads((ARTIFACT / 'manifest.json').read_text())
assert core.inspect(core.SERVICES['app'])['Image'] == manifest['candidateImage']
source = (ROOT / 'server/tools/operator-posting-rounding-live.mjs').read_text().replace("from '../src/", "from './src/")
source = 'globalThis.roundingLiveMode = ' + json.dumps(mode) + ';\n' + source
name = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
output = core.run(core.DOCKER + ['exec', '-i', '-w', '/app', core.SERVICES['app'],
                           'node', '--input-type=module'], input=source)
(STATE / f'live-{mode}-{name}.private.log').write_text(output)
data = None
for line in reversed(output.splitlines()):
    try:
        value = json.loads(line)
    except json.JSONDecodeError:
        continue
    if isinstance(value, dict) and value.get('mode') == mode and value.get('summary', {}).get('commandId') == 'e7790160-40e2-4cbb-a259-d21f29460ca4':
        data = value
        break
assert data is not None, 'Live evidence was not found; preserve logs and inspect current state before retrying.'
if mode != 'inspect':
    original = sorted(STATE.glob('live-inspect-*.private.json'))
    assert original, 'Preserve a read-only pre-recovery snapshot.'
    prior = json.loads(original[0].read_text())
    assert data['immutableFingerprint'] == prior['immutableFingerprint']
core.save(STATE / f'live-{mode}-{name}.private.json', data)
if mode != 'inspect':
    core.save(ARTIFACT / 'recovered.json', {'at': data['at'], **data['summary'],
                                         'quantityHoldCount': len(data['quantityHolds'])})
print(json.dumps({'at': data['at'], **data['summary'], 'quantityHoldCount': len(data['quantityHolds'])}))

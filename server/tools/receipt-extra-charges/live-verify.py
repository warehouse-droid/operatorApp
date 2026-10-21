"""Read the deployed receipt adapter and verify POB04042; no transaction writes."""
import json
from pathlib import Path
import subprocess

server = Path(__file__).resolve().parents[2]
release = server / 'deployments/receipt-extra-charges-20261019'
manifest = json.loads((release / 'manifest.json').read_text())
image = subprocess.check_output(['docker', 'inspect', '--format', '{{.Image}}', 'mbbs-operator-app-app-1'], text=True).strip()
assert image == manifest['candidateImageId'], 'Verify the exact deployed candidate'
script = (Path(__file__).with_suffix('.mjs')).read_text().replace('../../src/', 'file:///app/src/')
result = subprocess.run(['docker', 'exec', '-i', 'mbbs-operator-app-app-1', 'node', '--input-type=module'],
    input=script, text=True, capture_output=True, timeout=120)
(release / 'live-receipt-verification.log').write_text(result.stdout + result.stderr)
assert result.returncode == 0, result.stderr
start = result.stdout.find('{\n')
evidence = json.loads(result.stdout[start:])
(release / 'live-receipt-verification.json').write_text(json.dumps(evidence, indent=2) + '\n')
print(json.dumps(evidence, indent=2))

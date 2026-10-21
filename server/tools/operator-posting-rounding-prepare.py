"""Keep the release candidate and exact scoped source evidence current."""
import difflib
import hashlib
import json
import pathlib
import shutil

ROOT = pathlib.Path(__file__).resolve().parents[2]
STATE = pathlib.Path('/home/ubuntu/operatorapp-deploy-backups/operator-rounding-20261010')
ARTIFACT = ROOT / 'server/test-artifacts/operator-posting-rounding'
data = json.loads((ARTIFACT / 'manifest.json').read_text())
patch = ''
for name, change in data['changes'].items():
    path = ROOT / 'server' / name
    shutil.copy2(path, STATE / 'candidate' / name)
    change['after'] = hashlib.sha256(path.read_bytes()).hexdigest()
    old = STATE / 'baseline/app' / name
    patch += ''.join(difflib.unified_diff(old.read_text().splitlines(True) if old.exists() else [],
        path.read_text().splitlines(True), fromfile='a/' + name if old.exists() else '/dev/null', tofile='b/' + name))
(ARTIFACT / 'manifest.json').write_text(json.dumps(data, indent=2) + '\n')
(ARTIFACT / 'release.patch').write_text(patch)
print(json.dumps({'files': len(data['changes']), 'sourcePrepared': True}))

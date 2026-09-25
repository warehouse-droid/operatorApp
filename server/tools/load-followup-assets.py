"""Overlay only this change onto the frozen production frontend."""
import difflib
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
ARTIFACT = ROOT / 'test-artifacts/load-followup'
STAGE = ARTIFACT / 'release'
STAGE.mkdir(parents=True, exist_ok=True)
subprocess.run(['docker', 'cp', 'mbbs-operator-app-app-1:/app/public', str(STAGE)], check=True)
for suffix in ['.rej', '.orig']:
    for name in ['operator.js', 'operator.html', 'service-worker.js']:
        (STAGE / 'public' / (name + suffix)).unlink(missing_ok=True)
patches = []
for name in ['operator.js', 'operator.html', 'service-worker.js']:
    file = 'public/' + name
    original = (ARTIFACT / 'baseline' / file).read_text()
    live = (ARTIFACT / 'live-before' / file).read_text()
    assert (STAGE / file).read_text() == live, 'Live frontend changed: ' + file
    patch = ''.join(difflib.unified_diff(original.splitlines(True), (ROOT / file).read_text().splitlines(True),
        fromfile='a/' + file, tofile='b/' + file, n=3 if name == 'service-worker.js' else 5))
    patches.append(patch)
    result = subprocess.run(['patch', '--fuzz=0', '--batch', '--forward', '-p1'], cwd=STAGE,
                            input=patch, text=True, capture_output=True)
    assert result.returncode == 0, result.stdout + result.stderr
    print(result.stdout.strip())
(ARTIFACT / 'frontend-release.patch').write_text(''.join(patches))

# Preserve a reproducible reverse patch for the task baseline, including new modules.
files = json.loads((ARTIFACT / 'files.json').read_text()) + [
    'src/operator-load-state.js', 'src/operator-load-state-repository.js',
    'test/mbt/unit/operator-yard-assets.test.js',
    'test/mbt/unit/operator-page-confirm-ui.contract.test.js',
    'test/mbt/unit/operator-customer-pickup-photo-gate-ui.contract.test.js']
patches = []
for file in files:
    baseline = ARTIFACT / 'baseline' / file
    original = baseline.read_text() if baseline.exists() else ''
    patches.append(''.join(difflib.unified_diff(original.splitlines(True), (ROOT / file).read_text().splitlines(True),
        fromfile='a/' + file if baseline.exists() else '/dev/null', tofile='b/' + file)))
(ROOT / 'test/support/load-followup-baseline.patch').write_text(''.join(patches))

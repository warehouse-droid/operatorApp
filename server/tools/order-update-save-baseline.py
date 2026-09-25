"""Reconstruct the pre-task runtime without touching the working tree."""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess

root = Path(__file__).resolve().parents[1]
baseline = root / 'test-artifacts/order-update-save/baseline'
baseline.mkdir(parents=True, exist_ok=True)
for directory in ['src', 'public']:
    shutil.copytree(root / directory, baseline / directory, dirs_exist_ok=True)
for name in ['package.json', 'package-lock.json']:
    shutil.copy2(root / name, baseline / name)
subprocess.run(['patch', '--batch', '-p1'], cwd=baseline,
               input=(root / 'test/support/order-update-save-baseline.patch').read_bytes(), check=True)
for name in ['dispatch-plan-maintenance.js', 'dispatch-plan-maintenance-queue.js']:
    (baseline / 'src' / name).unlink(missing_ok=True)
for name, expected in json.loads((root / 'test/support/order-update-save-baseline-hashes.json').read_text()).items():
    assert hashlib.sha256((baseline / name).read_bytes()).hexdigest() == expected, name
print('Reconstructed pre-task runtime and verified its recorded hashes.')

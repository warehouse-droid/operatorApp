"""Reproduce the final checks, with cleanup registered by each bounded test run."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

TASK = Path(__file__).resolve().parent
SERVER = TASK.parents[1]
OUT = SERVER / 'test-artifacts/split-quantity-20261020'
OUT.mkdir(parents=True, exist_ok=True)

def hashes():
    files = sorted(path for path in (TASK / 'candidate').rglob('*') if path.is_file())
    return {str(path.relative_to(TASK / 'candidate')): hashlib.sha256(path.read_bytes()).hexdigest() for path in files}

before = hashes()
(OUT / 'verified-source.json').write_text(json.dumps(before, indent=2) + '\n')
for mode in ['baseline', 'static', 'final', 'browser', 'mutations', 'health']:
    subprocess.run([sys.executable, str(TASK / 'run.py'), mode], check=True, cwd=SERVER.parent)
    assert hashes() == before, 'Source changed during verification'
subprocess.run([sys.executable, str(TASK / 'coverage.py')], check=True, cwd=SERVER.parent)
subprocess.run([sys.executable, str(TASK / 'evidence.py')], check=True, cwd=SERVER.parent)

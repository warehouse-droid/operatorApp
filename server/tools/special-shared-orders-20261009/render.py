"""Rebase the exact task patch onto the existing webhook-worker source."""
import difflib
from pathlib import Path
import subprocess

SERVER = Path(__file__).resolve().parents[2]
TASK = Path(__file__).resolve().parent
OUT = TASK / 'worker'
FILES = ['src/special-stock-request-repository.js', 'src/server.js']
for file in FILES:
    target = OUT / file
    target.parent.mkdir(parents=True, exist_ok=True)
    worker = TASK / 'baseline/src' / ('worker-' + Path(file).name)
    target.write_bytes(worker.read_bytes())
    before = (TASK / 'baseline' / file).read_text()
    after = (SERVER / file).read_text()
    patch = ''.join(difflib.unified_diff(before.splitlines(True), after.splitlines(True), fromfile='a/' + file, tofile='b/' + file, n=1))
    result = subprocess.run(['patch', '-p1', '--batch', '--forward', '--fuzz=0', '--directory', str(OUT)], input=patch, capture_output=True, text=True)
    assert result.returncode == 0, file + ': ' + result.stdout + result.stderr
    for suffix in ['.rej', '.orig']:
        Path(str(target) + suffix).unlink(missing_ok=True)
    print(result.stdout.strip())

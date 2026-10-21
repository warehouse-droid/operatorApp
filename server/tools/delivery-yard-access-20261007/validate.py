"""One entry point for fresh baseline and candidate Delivery validation."""
import signal
import subprocess
import sys
from pathlib import Path

RUN = Path(__file__).with_name('run.py')
REPO = RUN.resolve().parents[3]
child = None

def interrupted(_signal, _frame):
    raise KeyboardInterrupt('Tearing down the disposable validation environment')

signal.signal(signal.SIGINT, interrupted)
signal.signal(signal.SIGTERM, interrupted)
# Child run.py registers its Compose teardown before starting any tests.
try:
    for mode in ['component-baseline', 'gauntlet']:
        child = subprocess.Popen([sys.executable, str(RUN.resolve()), mode], cwd=REPO)
        status = child.wait()
        allowed = [0, 1] if mode == 'component-baseline' else [0]
        assert status in allowed, f'{mode} exited {status}'
finally:
    if child and child.poll() is None:
        child.terminate()
        child.wait(timeout=30)

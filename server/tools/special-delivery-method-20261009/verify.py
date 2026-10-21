"""Reproduce baseline, final checks and the final evidence on disposable stacks."""
from pathlib import Path
import signal
import subprocess
import sys

TASK = Path(__file__).resolve().parent
REPO = TASK.parents[2]

def interrupted(_signal, _frame):
    raise KeyboardInterrupt('Stop verification and tear down the current disposable project')

signal.signal(signal.SIGINT, interrupted)
signal.signal(signal.SIGTERM, interrupted)
for phase in ['baseline', 'final', 'finish']:
    child = None
    try:
        child = subprocess.Popen([sys.executable, str(TASK / 'run.py'), phase], cwd=REPO)
        status = child.wait()
        if status:
            raise SystemExit(status)
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            child.wait(timeout=60)

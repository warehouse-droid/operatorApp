"""Reproduce the checks and evidence; each runner invocation guarantees teardown."""
from pathlib import Path
import subprocess
import sys

task = Path(__file__).resolve().parent
repo = task.parents[2]
runner = str(task / 'run.py')
for mode, script in [('final', 'gauntlet.mjs'), ('audit', 'audit.mjs')]:
    subprocess.run([sys.executable, runner, mode, 'node', 'tools/return-credit-memo-20261008/' + script], cwd=repo, check=True)
subprocess.run([sys.executable, str(task / 'evidence.py')], cwd=repo, check=True)

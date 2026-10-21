"""Reproduce the candidate checks, with teardown owned by each run."""
from pathlib import Path
import subprocess
import sys

task = Path(__file__).resolve().parent
repo = task.parents[2]
for mode in sys.argv[1:] or ["final", "static", "mutations", "health"]:
    subprocess.run([sys.executable, str(task / "run.py"), mode], cwd=repo, check=True)
subprocess.run([sys.executable, str(task / "coverage.py")], cwd=repo, check=True)

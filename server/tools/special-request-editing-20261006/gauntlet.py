"""Reproduce the scoped gauntlet and the existing stable-view browser checks."""
import subprocess
import sys
from pathlib import Path

root=Path(__file__).resolve().parents[2]
stages=['audit','view'] if sys.argv[1:] == ['resume'] else ['all','view']
for mode in stages:
    subprocess.run([sys.executable,str(root/'tools/special-request-editing-20261006/run.py'),mode],cwd=root,check=True)

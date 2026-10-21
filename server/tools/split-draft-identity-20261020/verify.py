"""Repeat all release checks with isolated, disposable test resources."""
from pathlib import Path
import shutil
import subprocess
import sys

TASK = Path(__file__).resolve().parent
SERVER = TASK.parents[1]
OUT = SERVER / "test-artifacts/split-draft-identity-20261020"
for name in ["split-draft-identity.test.js", "split-draft-identity.browser.test.mjs"]:
    shutil.copy2(SERVER / "test/dispatch/frontend" / name, TASK / "tests/dispatch/frontend" / name)
for mode in sys.argv[1:] or ["final", "static", "mutations", "health"]:
    subprocess.run([sys.executable, str(TASK / "run.py"), mode], check=True)

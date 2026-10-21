from pathlib import Path
import subprocess
import sys
task = Path(__file__).resolve().parent
subprocess.run([sys.executable, str(task / 'run.py'), 'final', 'node',
    'tools/return-pallet-balance-sync-20261008/gauntlet.mjs'], check=True)
subprocess.run([sys.executable, str(task / 'evidence.py')], check=True)

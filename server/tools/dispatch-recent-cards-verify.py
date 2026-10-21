"""Re-run the complete isolated arrival-recency verification without deployment.

Pass --live to additionally verify the already deployed, pinned release.
"""
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
for tool in ['dispatch-recent-cards-check.py', 'dispatch-recent-cards-guard-mutant.py',
             'dispatch-recent-cards-migration-guard.py']:
    subprocess.run([sys.executable, str(root / 'tools' / tool)], cwd=root, check=True)
if '--live' in sys.argv:
    subprocess.run([sys.executable, str(root / 'tools/dispatch-recent-cards-release.py'), 'verify'], cwd=root, check=True)

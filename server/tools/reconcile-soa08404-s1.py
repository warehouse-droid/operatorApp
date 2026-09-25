"""Create the approved historical reconciliation for SOA08404-S1; rollback unless --apply."""
import argparse
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--apply', action='store_true')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
source = (root / 'tools/reconcile-soa08404-s1.mjs').read_text()
command = ['sudo','-n','docker','exec','-i','mbbs-operator-app-app-1','node','--input-type=module','-']
if args.apply:
    command.append('--apply')
result = subprocess.run(command, input=source, text=True, capture_output=True)
artifact = root / 'test-artifacts/soa08404-s1-historical-reconciliation'
artifact.mkdir(parents=True, exist_ok=True)
name = 'apply.log' if args.apply else 'rehearsal.log'
path = artifact / name
if path.exists():
    path = artifact / ('repeat-' + name)
path.write_text(result.stdout + result.stderr)
print(result.stdout + result.stderr, end='')
raise SystemExit(result.returncode)

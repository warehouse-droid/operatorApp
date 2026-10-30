#!/usr/bin/env python3
"""Record read-only live SO query timings without logging personal data or credentials."""
import subprocess
import sys
from pathlib import Path

server = Path(__file__).resolve().parents[1]
release = server / 'deployments/pallet-return-search-20261029'
phase = sys.argv[1]
assert phase in ('before', 'after')
args = ['sudo', '-n', 'docker', 'exec', '-i', '-e', 'PALLET_PROFILE_PHASE=' + phase]
args += ['mbbs-operator-app-app-1', 'node', '--input-type=module']
result = subprocess.run(args, input=(server / 'tools/pallet-return-search-profile.mjs').read_text(), text=True, capture_output=True)
(release / ('profile-' + phase + '.jsonl')).write_text(result.stdout)
print(result.stdout, end='')
if result.returncode:
    print(result.stderr, file=sys.stderr)
    raise SystemExit(result.returncode)

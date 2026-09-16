"""Capture changed lines and source hashes on the host (test image has no git)."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

repo = Path(__file__).resolve().parents[2]
files = [
    'src/netsuite.js', 'src/scm-netsuite-po-history-repository.js',
    'src/scm-netsuite-po-history-service.js', 'src/scm-netsuite-po-version.js',
    'src/smart-scm-created-po.js', 'src/smart-scm-vendor-workflow-repository.js',
]
manifest = {}
git = ['git', '-c', f'safe.directory={repo}']
for name in files:
    path = repo / 'server' / name
    tracked = subprocess.run(git + ['ls-files', '--error-unmatch', '--', f'server/{name}'], cwd=repo, capture_output=True)
    if tracked.returncode not in [0, 1]:
        raise RuntimeError(tracked.stderr.decode())
    if tracked.returncode == 1:
        added = list(range(1, len(path.read_text().splitlines()) + 1))
    else:
        diff = subprocess.check_output(git + ['diff', '--unified=0', '--', f'server/{name}'], cwd=repo, text=True)
        added = []
        line = 0
        for text in diff.splitlines():
            if text.startswith('@@'):
                line = int(re.search(r'\+(\d+)', text).group(1))
            elif text.startswith('+++'):
                continue
            elif text.startswith('+'):
                added.append(line)
                line += 1
            elif text.startswith(' '):
                line += 1
    manifest[name] = {'lines': added, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
output = repo / 'server/test-artifacts/smart-scm-created-po-sync/changed-lines.json'
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(manifest, indent=2) + '\n')
print(f'Captured changed lines for {len(manifest)} backend files.')

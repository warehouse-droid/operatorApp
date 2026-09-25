"""Bind evidence to runtime, schema, assertions and the verification tools."""
from pathlib import Path
import hashlib
import json
import re
import sys
from datetime import datetime, timezone

root = Path(__file__).resolve().parents[1]
directory = root / 'test-artifacts/order-update-save'
files = set(re.findall(r"'((?:src|migrations|public)/[^']+)'", (root / 'tools/order-update-save-files.mjs').read_text()))
files.update(str(p.relative_to(root)) for folder in ['tools', 'test'] for p in (root / folder).rglob('order-update-*') if p.is_file())
files.update(['package.json', 'package-lock.json', 'tools/dispatch-save-reliability-test.sh',
              'tools/dispatch-save-compare.py', 'tools/dispatch-save-performance.py',
              'tools/mbt-predeploy-readiness.mjs', 'test/mbt/integration/migration-upgrade.test.js',
              'test/mbt/integration/p3-predeploy-readiness.test.js'])
hashes = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in sorted(files) if not name.endswith('-evidence.md')}
value = {'sources': hashes, 'treeSha256': hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest(),
         'timestamp': datetime.now(timezone.utc).isoformat()}
if sys.argv[1] == 'begin':
    (directory / 'final-run-start.json').write_text(json.dumps(value, indent=2) + '\n')
else:
    previous = json.loads((directory / 'final-run-start.json').read_text())
    assert value['sources'] == previous['sources'], 'Source or test/tool changed during final verification'
    (directory / 'final-run-complete.json').write_text(json.dumps(value, indent=2) + '\n')
print(value['treeSha256'])

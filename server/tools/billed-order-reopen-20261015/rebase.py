"""Retain the concurrent release and apply only the already-verified overlay."""
import json
from pathlib import Path
import shutil

TASK = Path(__file__).resolve().parent
OUT = TASK.parents[1] / 'test-artifacts/billed-order-reopen-20261015'
FILES = ['src/operator-order-reopen-repository.js', 'public/dispatch.js', 'public/dispatch.html']
for file in FILES:
    assert (TASK / 'baseline' / file).read_bytes() == (TASK / 'latest' / file).read_bytes(), file
overlay = {file: (TASK / 'candidate' / file).read_bytes() for file in FILES}
shutil.copy2(OUT / 'summary.json', OUT / 'pre-rebase-summary.json')
shutil.copy2(OUT / 'static.json', OUT / 'pre-rebase-static.json')
shutil.copy2(OUT / 'baseline.json', OUT / 'pre-rebase-baseline.json')
shutil.copy2(TASK / 'capture.json', TASK / 'capture-original.json')
(TASK / 'baseline').rename(TASK / 'original-baseline')
(TASK / 'candidate').rename(TASK / 'original-candidate')
(TASK / 'latest').rename(TASK / 'baseline')
shutil.copytree(TASK / 'baseline', TASK / 'candidate')
shutil.copy2(TASK / 'capture-latest.json', TASK / 'capture.json')
for file, data in overlay.items():
    (TASK / 'candidate' / file).write_bytes(data)
print(json.dumps({'rebased': True, 'preservedConcurrentFiles': json.loads((TASK / 'concurrent-release-files.json').read_text())}))

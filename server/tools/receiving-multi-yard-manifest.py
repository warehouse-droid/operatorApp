"""Persist a scoped source manifest and the corresponding deployed-baseline patch."""
import argparse
import difflib
import hashlib
import json
from pathlib import Path
import shutil

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--baseline', type=Path)
args = parser.parse_args()
snapshots = root / 'test/support/receiving-multi-yard-baseline'
baseline = args.baseline or snapshots
files = ['src/receiving-yard-scope.js', 'src/receiving-repository.js', 'src/operator-yard-authorization.js',
         'src/operator-netsuite-posting-targets.js', 'src/server.js',
         'public/operator.js', 'public/operator.html', 'public/service-worker.js']
data = {'runtimeFiles': files, 'testFiles': ['test/mbt/unit/receiving-yard-scope.test.js',
        'test/mbt/unit/receiving-multi-yard-ui.test.js', 'test/mbt/integration/receiving-multi-yard.test.js',
        'test/mbt/unit/receiving-split-balance-ui.test.js'],
        'before': {}, 'after': {}, 'changedLines': {}}
patch = ''
for file in files:
    before_path, after_path = baseline / file, root / file
    old = before_path.read_text() if before_path.exists() else ''
    new = after_path.read_text()
    if old:
        data['before'][file] = hashlib.sha256(before_path.read_bytes()).hexdigest()
        if args.baseline:
            destination = snapshots / file
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(before_path, destination)
    data['after'][file] = hashlib.sha256(after_path.read_bytes()).hexdigest()
    data['changedLines'][file] = [line + 1
        for tag, _, _, start, end in difflib.SequenceMatcher(None, old.splitlines(), new.splitlines(), autojunk=False).get_opcodes()
        if tag in ('insert', 'replace') for line in range(start, end)]
    patch += ''.join(difflib.unified_diff(old.splitlines(True), new.splitlines(True), fromfile='a/' + file, tofile='b/' + file))
(root / 'test/receiving-multi-yard-manifest.json').write_text(json.dumps(data, indent=2) + '\n')
(root / 'test/receiving-multi-yard.changes.patch').write_text(patch)
print(json.dumps({'runtimeFiles': len(files), 'changedLines': sum(map(len, data['changedLines'].values()))}))

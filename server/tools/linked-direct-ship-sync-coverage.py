"""Measure coverage of new modules and this task's changes to existing files."""
import difflib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'test-artifacts/linked-direct-ship-sync'
coverage = json.loads((OUT / 'coverage/coverage-final.json').read_text())
summaries = json.loads((OUT / 'coverage/coverage-summary.json').read_text())
results = {}
with tempfile.TemporaryDirectory(prefix='direct-ship-coverage-') as temporary:
    baseline = Path(temporary)
    for name in ['order-sync-repository.js', 'order-dependency-repository.js', 'direct-to-completion-repository.js']:
        (baseline / 'src').mkdir(exist_ok=True)
        shutil.copyfile(ROOT / 'src' / name, baseline / 'src' / name)
    subprocess.run(['patch', '--silent', '-p1', '-i', str(ROOT / 'test/support/linked-direct-ship-sync-baseline.patch')], cwd=baseline, check=True)
    for name, cov in coverage.items():
        file = 'src/' + Path(name).name
        if file.startswith('src/linked-direct-ship-sync-'):
            results[file] = {'lines': summaries[name]['lines'], 'branches': summaries[name]['branches']}
            assert summaries[name]['lines']['pct'] == 100
            continue
        before = (baseline / file).read_text().splitlines()
        after = (ROOT / file).read_text().splitlines()
        changed, hits = set(), {}
        for tag, a, b, c, d in difflib.SequenceMatcher(a=before, b=after).get_opcodes():
            if tag in ('replace', 'insert'):
                changed.update(range(c + 1, d + 1))
        for key, record in cov['statementMap'].items():
            for line in range(record['start']['line'], record['end']['line'] + 1):
                hits[line] = max(hits.get(line, 0), cov['s'][key])
        executable = sorted(changed.intersection(hits))
        missing = [line for line in executable if hits[line] == 0]
        assert not missing, (file, missing)
        results[file] = {'changedLines': len(executable), 'covered': len(executable), 'missing': missing}
(OUT / 'changed-coverage.json').write_text(json.dumps(results, indent=2) + '\n')
print(json.dumps(results))

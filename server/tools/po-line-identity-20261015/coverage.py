"""Check executed changed lines against the captured production baseline."""
import difflib
import json
from pathlib import Path
import re

SERVER = Path(__file__).resolve().parents[2]
OUT = SERVER / 'test-artifacts/po-line-identity-20261015'
data = json.loads((OUT / 'coverage/coverage-final.json').read_text())
results = []
for filename in ['src/dispatch-order-target-repository.js', 'src/dispatch-delivery-group-repository.js', 'public/dispatch.js']:
    before = (OUT / 'runtime-baseline' / filename).read_text().splitlines()
    after = (OUT / 'candidate' / filename).read_text().splitlines()
    coverage = data['/app/' + filename]
    covered = {}
    for key, location in coverage['statementMap'].items():
        for line in range(location['start']['line'], location['end']['line'] + 1):
            covered[line] = max(covered.get(line, 0), coverage['s'][key])
    changed = []
    for tag, _, _, start, end in difflib.SequenceMatcher(a=before, b=after).get_opcodes():
        if tag in ['replace', 'insert']:
            changed += [line + 1 for line in range(start, end) if after[line].strip()
                and not re.fullmatch(r'[\s{}()[\],;]+', after[line])
                and not after[line].lstrip().startswith('//')]
    missing = [line for line in changed if covered.get(line, 0) == 0]
    results.append({'file': filename, 'covered': len(changed) - len(missing), 'total': len(changed), 'missing': missing})
(OUT / 'changed-coverage.json').write_text(json.dumps(results, indent=2) + '\n')
print(json.dumps(results), flush=True)
assert all(not row['missing'] for row in results)

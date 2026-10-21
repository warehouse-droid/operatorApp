"""Count executable changed-line coverage from the fresh Istanbul report."""
import difflib,hashlib,json
from pathlib import Path
SERVER=Path(__file__).resolve().parents[2];OUT=SERVER/'test-artifacts/special-local-adjustments-20261013'
files=['src/special-stock-local-adjustments.js','src/special-stock-quantity-service.js','src/special-stock-request-service.js','src/special-stock-request-repository.js']
coverage=json.loads((OUT/'coverage/coverage-final.json').read_text());result={}
for file in files:
    after=(SERVER/file).read_text().splitlines();baseline=OUT/'before'/file
    before=baseline.read_text().splitlines() if baseline.exists() else []
    changed=set()
    for tag,a,b,c,d in difflib.SequenceMatcher(None,before,after).get_opcodes():
        if tag in ['replace','insert']:changed.update(range(c+1,d+1))
    data=coverage['/app/'+file];counts={}
    for key,span in data['statementMap'].items():
        number=span['start']['line'];counts[number]=max(counts.get(number,0),data['s'][key])
    executable=changed.intersection(counts);missing=sorted(number for number in executable if not counts[number])
    result[file]={'changedExecutableLines':len(executable),'coveredExecutableLines':len(executable)-len(missing),'missingLines':missing,'sha256':hashlib.sha256((SERVER/file).read_bytes()).hexdigest()}
(OUT/'changed-coverage.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result),flush=True)
assert not any(r['missingLines'] for r in result.values()),'Missing changed-line coverage needs a meaningful test'

"""Report changed executable line coverage from the final c8 run."""
import difflib
import json
from pathlib import Path

SERVER = Path(__file__).resolve().parents[2]
TASK = Path(__file__).resolve().parent
OUT = SERVER / 'test-artifacts/control-order-reopen-20261012'
coverage = json.loads((OUT / 'coverage/coverage-final.json').read_text())
results = []
for file in json.loads((TASK/'files.json').read_text())['runtime']:
    if not file.endswith('.js'): continue
    before=(TASK/'baseline'/file).read_text().splitlines() if (TASK/'baseline'/file).exists() and file != 'src/operator-order-reopen-repository.js' else []
    after=(TASK/'candidate'/file).read_text().splitlines()
    changed=set()
    for tag, a, b, c, d in difflib.SequenceMatcher(a=before,b=after,autojunk=False).get_opcodes():
        if tag in ['insert','replace']:
            changed.update(range(c+1,d+1))
    record=next(value for key,value in coverage.items() if key.endswith('/'+file))
    executable={}
    for key,statement in record['statementMap'].items():
        for line in range(statement['start']['line'],statement['end']['line']+1):
            if line in changed and after[line-1].strip() and not after[line-1].lstrip().startswith(('//','*','import')):
                executable[line]=max(executable.get(line,0),record['s'][key])
    # SQL string literals are covered by their query call, not separate JS statements.
    missing=[line for line,count in executable.items() if not count]
    results.append({'file':file,'changedExecutable':len(executable),'covered':sum(bool(value) for value in executable.values()),'missing':missing})
result={'files':results,'missing':[{'file':row['file'],'line':line} for row in results for line in row['missing']]}
(OUT/'changed-coverage.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
assert not result['missing']

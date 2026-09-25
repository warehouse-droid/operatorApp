"""Compare recorded runs and bind release approval to their exact source hashes."""
import collections
import difflib
import hashlib
import json
from pathlib import Path
import re

ROOT=Path(__file__).resolve().parents[1]
ART=ROOT/'test-artifacts/sor-rentals'
RELEASE=Path('/home/ubuntu/operatorapp-deploy-backups/sor-rentals-20260924-v1')

def read(name): return (ART/name).read_text()
def data(name): return json.loads(read(name))
def digest(value): return hashlib.sha256(value).hexdigest()
def failed_tests(name):
    return collections.Counter(re.sub(r' \([\d.]+ms\)$','',line) for line in read(name).splitlines()
        if line.startswith('✖ ') and line!='✖ failing tests:')
def failed_files(name):
    matches=re.findall(r'Isolated .+ run failed in (\d+)/(\d+) file\(s\): (.+)',read(name))
    assert matches,'Incomplete full-suite log: '+name
    failures,total,files=matches[-1]
    return {'failed':int(failures),'total':int(total),'files':files.split(', ')}
def lint(name):
    return collections.Counter((row['file'],entry['ruleId'],re.sub(r'line \d+','line #',entry['message']))
        for row in data(name) for entry in row['messages'])
def types(name):
    return collections.Counter(re.sub(r'\(\d+,\d+\)','(LINE,COL)',line) for line in read(name).splitlines()
        if re.search(r'\(\d+,\d+\): error TS',line))

manifest=json.loads((RELEASE/'manifest.json').read_text())
files=json.loads((ROOT/'tools/sor-rentals-files.json').read_text())
workspace={file:digest((ROOT/file).read_bytes()) for file in files}
candidate={file:digest((RELEASE/'candidate'/file).read_bytes()) for file in files}
assert workspace==manifest['workspace'] and candidate==manifest['after'],'Sources changed after candidate preparation'
full=[]
for baseline,current in [('full-baseline-valid.log','full-final-shuffled.log'),('dispatch-baseline.log','dispatch-current.log')]:
    new=failed_tests(current)-failed_tests(baseline)
    full.append({'baseline':failed_files(baseline),'current':failed_files(current),'newFailedTests':list(new.elements())})
    assert not new,dict(new)
    assert not set(full[-1]['current']['files'])-set(full[-1]['baseline']['files'])
old_lint,new_lint=lint('lint-baseline.json'),lint('lint-current.json')
old_types,new_types=types('types-baseline-focused.log'),types('types-current-focused.log')
assert not new_lint-old_lint,dict(new_lint-old_lint)
assert not new_types-old_types,dict(new_types-old_types)
focused=read('candidate-focused.log')
assert '# fail 0' in focused and '# skipped 0' in focused
tests=int(re.search(r'^# tests (\d+)$',focused,re.M)[1])
assert 'Isolated SOR integration compatibility run passed:' in read('integration-compatibility.log')
mutations=data('mutations.json');assert all(row['killed'] for row in mutations if row['mode']=='focused')
for name in ['browser-result.json','admin-browser-result.json','migration-result.json','image-smoke.json','driver-flow-result.json','startup-result.json','cache-result.json']:
    assert data(name)['passed'],name
rehearsal=json.loads(read('rollout-rehearsal.log').splitlines()[-1])
assert rehearsal['enabled'] and len(rehearsal['returns'])==14 and not rehearsal['errors'] and rehearsal['pending']==0
coverage=data('coverage/lines.json')
changed_coverage={}
for file in files:
    if not file.endswith('.js'): continue
    base=RELEASE/'baseline'/file
    old=base.read_text().splitlines() if base.exists() else []
    new=(RELEASE/'candidate'/file).read_text().splitlines()
    changed=[n+1 for tag,a,b,c,d in difflib.SequenceMatcher(None,old,new,autojunk=False).get_opcodes()
        if tag in ('insert','replace') for n in range(c,d)]
    counters=coverage.get(file,{}).get('lines',{})
    measured=[n for n in changed if str(n) in counters]
    missing=[n for n in measured if not counters[str(n)]]
    changed_coverage[file]={'covered':len(measured)-len(missing),'measured':len(measured),'uncovered':missing,
        'notMeasured':[n for n in changed if str(n) not in counters]}
new_modules=[file for file in files if '/sor-' in file and file.endswith('.js')]
for file in new_modules:
    assert changed_coverage[file]['measured'] and not changed_coverage[file]['uncovered'],file
secrets=[]
for file in files:
    base=RELEASE/'baseline'/file
    old=base.read_text().splitlines() if base.exists() else []
    new=(RELEASE/'candidate'/file).read_text().splitlines()
    added='\n'.join(line[1:] for line in difflib.unified_diff(old,new) if line.startswith('+') and not line.startswith('+++'))
    if re.search(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[A-Z0-9]{16}|sk_live_[A-Za-z0-9]{20,}',added):secrets.append(file)
assert not secrets,secrets
assert 'package.json' not in files and 'package-lock.json' not in files
result={'passed':True,'workspace':workspace,'candidateSources':candidate,
    'sourceTreeSha256':digest(json.dumps(workspace,sort_keys=True).encode()),'imageId':manifest['candidateImageId'],
    'focusedTests':tests,'fullSuites':full,'lint':{'baseline':sum(old_lint.values()),'current':sum(new_lint.values()),'new':0},
    'types':{'baseline':sum(old_types.values()),'current':sum(new_types.values()),'new':0},
    'mutationKills':sum(row['killed'] for row in mutations if row['mode']=='focused'),
    'propertyOnlyMutationKills':sum(row['killed'] for row in mutations if row['mode']=='property'),
    'changedLineCoverage':changed_coverage,'newModuleCoverage':{file:coverage[file]['summary'] for file in new_modules},
    'rolloutRehearsal':rehearsal,'dependenciesAdded':0,'secretFindings':secrets,
    'knownLimits':['Legacy wiring coverage is reported per line, not claimed as 100%. Production scheduler, upload recovery, and some optional legacy endpoint branches are checked by contracts/compatibility tests rather than exhaustive runtime coverage.',
        'The property suite covers classification and split identity; four database/history/Driver mutants need integration tests.',
        'Existing suite failures remain. The unrelated stock-return test has an intermittent metadata-read expectation.']}
(ART/'verification.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({key:result[key] for key in ['passed','sourceTreeSha256','imageId','focusedTests','lint','types','mutationKills','propertyOnlyMutationKills']}))

"""Collect actual check results and enforce release gates without changing tests."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import re
import tarfile

SERVER=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('release',SERVER/'tools/count-sheet-refresh-deploy.py')
release=importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
OUT=release.OUT
EVIDENCE=OUT/'evidence'
BROAD=OUT.parent/'release'


def load(file):
    return json.loads((EVIDENCE/file).read_text())


def failures(path):
    source=path.read_text()
    completed=re.search(r'Isolated MBT main run failed in (\d+)/(\d+) file\(s\): (.+)',source)
    assert completed,'Broad run is not complete: '+str(path)
    files=completed.group(3).split(', ')
    cases=set()
    current=''
    for line in source.splitlines():
        if line.startswith('[isolation]'):
            current=line.split(' ')[-1]
        if line.startswith('✖ '):
            name=re.sub(r' \([0-9.]+ms\)$','',line[2:])
            cases.add((current,name))
    return {'files':files,'cases':sorted(cases),'totalFiles':int(completed.group(2))}


EVIDENCE.mkdir(exist_ok=True)
archive=release.docker('exec','mbbs-count-refresh-test-runner','tar','-C','/app/test-artifacts/count-sheet-refresh',
    '--exclude=v8','--exclude=merged-coverage.json','-cf','-','.')
with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
    tar.extractall(EVIDENCE,filter='data')
focused,ordered,coverage,mutants,source=[load(name+'.json') for name in ['focused','reordered','changed-coverage','mutations','source']]
for result in [focused,ordered]:
    assert result['fail']==0 and result['tests']==result['pass'] and result['cancelled']==0 and result['skipped']==0
assert coverage['covered']==coverage['executable']
assert len(mutants)==14 and all(m['killed'] for m in mutants)
baseline_types=json.loads((BROAD/'type-diagnostics-before.json').read_text())
new_types=sorted(set(load('type-diagnostics.json'))-set(baseline_types))
assert not new_types,new_types
state=release.state()
for file in release.FILES:
    assert source['files'][file]==state['expectedTree'][file],file
before,after=failures(BROAD/'full-before.log'),failures(BROAD/'full-after.log')
new_files=sorted(set(after['files'])-set(before['files']))
new_cases=sorted(set(map(tuple,after['cases']))-set(map(tuple,before['cases'])))
comparison={'before':before,'after':after,'newFailingFiles':new_files,'newFailingCases':new_cases}
(EVIDENCE/'broad-comparison.json').write_text(json.dumps(comparison,indent=2)+'\n')
assert not new_files and not new_cases,{'newFailingFiles':new_files,'newFailingCases':new_cases}
old_state=json.loads((BROAD/'manifest.json').read_text())
rebased=[file for file in release.FILES if old_state['expectedTree'][file]!=state['expectedTree'][file]]
assert set(rebased)<= {'public/operator.js','public/operator.html','public/service-worker.js'},rebased
report={'passed':True,'imageId':state['imageId'],'focused':focused,'reordered':{key:ordered[key] for key in focused},
    'changedExecutableLines':coverage['covered'],'manualMutantsKilled':len(mutants),'existingTypeDiagnostics':len(baseline_types),'newTypeDiagnostics':0,
    'broadFilesPerRun':before['totalFiles'],'broadBaselineFailingFiles':len(before['files']),'broadCandidateFailingFiles':len(after['files']),
    'newBroadFailures':0,'broadImages':[old_state['before']['imageId'],old_state['imageId']],
    'rebasedFilesRetested':rebased,'specApproval':'not obtained (autonomous run)',
    'sourceManifestSha256':hashlib.sha256((EVIDENCE/'source.json').read_bytes()).hexdigest()}
release.save('checks.json',report)
print(json.dumps(report))

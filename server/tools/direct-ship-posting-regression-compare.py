"""Compare every attempted test file and assertion with the saved baseline."""
import collections
import json
from pathlib import Path
import re

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'test-artifacts/direct-ship-posting-20261001'
PATTERN=re.compile(r'^\[isolation\].* (test/\S+)$',re.M)

def files(logs):
    result={}
    for name in logs:
        source=(OUT/name).read_text()
        events=list(PATTERN.finditer(source))
        for index,event in enumerate(events):
            file=event.group(1)
            assert file not in result,'Duplicate test execution in comparison: '+file
            block=source[event.end():events[index+1].start() if index+1<len(events) else len(source)]
            counts={key:int(value) for key,value in re.findall(r'^ℹ (tests|pass|fail|cancelled|skipped) (\d+)$',block,re.M)}
            timeout='TIMEOUT '+file in block
            assert 'duration_ms' in block or timeout,'Test file did not finish: '+file
            failures=collections.Counter(re.findall(r'^✖ (.+?) \([0-9.]+ms\)$',block,re.M))
            result[file]={'counts':counts,'timeout':timeout,'failures':failures}
    return result

before=files(['baseline-bounded-full.log'])
after=files(['candidate-full-1-419.log','candidate-full-420-599.log','candidate-full-600-771.log'])
assert len(before)==768 and len(after)==771,'Full test-file inventory must be complete'
assert set(before)<=set(after),'Existing regression files are missing'
expected={'test/mbt/unit/direct-ship-posting.test.js','test/mbt/integration/direct-ship-posting.test.js','test/mbt/integration/direct-ship-materializer-red.test.js'}
assert set(after)-set(before)==expected,'Unexpected test scope'
new=[]
for file,result in after.items():
    baseline=before.get(file,{'counts':{'fail':0,'cancelled':0},'timeout':False,'failures':collections.Counter()})
    added=list((result['failures']-baseline['failures']).elements())
    for key in ['fail','cancelled']:
        if result['counts'].get(key,0)>baseline['counts'].get(key,0):added.append(key+' count increased')
    if result['timeout'] and not baseline['timeout']:added.append('new timeout')
    if added:new.append({'file':file,'newFailures':added})
summary={'passed':not new,'baselineFiles':len(before),'candidateFiles':len(after),
 'baselineTests':sum(row['counts'].get('tests',0) for row in before.values()),
 'candidateTests':sum(row['counts'].get('tests',0) for row in after.values()),
 'baselineFailedTests':sum(row['counts'].get('fail',0) for row in before.values()),
 'candidateFailedTests':sum(row['counts'].get('fail',0) for row in after.values()),
 'baselineTimeouts':[file for file,row in before.items() if row['timeout']],
 'candidateTimeouts':[file for file,row in after.items() if row['timeout']],
 'newFailures':new}
(OUT/'regression-comparison.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary))
assert summary['passed'],'New regression failures block deployment'

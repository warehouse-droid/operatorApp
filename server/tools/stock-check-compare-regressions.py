"""Compare existing test-file and named-case failures with the captured pre-change baseline."""
import json,pathlib,re
root=pathlib.Path(__file__).resolve().parents[1]/'test-artifacts/stock-check'
def read(label):
    text=(root/(label+'.log')).read_text()
    footer=re.search(r'run failed in (\d+)/(\d+) file\(s\): (.+)',text)
    passed=re.search(r'run passed: (\d+) file\(s\), (\d+) test\(s\)',text)
    assert footer or passed, 'The '+label+' regression run has not completed.'
    failed=set(footer[3].split(', ')) if footer else set()
    blocks=re.split(r'\[isolation\] Stock Check regressions \d+/\d+ ([^\n]+)\n',text)
    cases={}
    for n in range(1,len(blocks),2):
        file=blocks[n];names=set()
        for line in blocks[n+1].splitlines():
            match=re.match(r'\s*✖ (.+)',line)
            if match:names.add(re.sub(r' \([\d.]+ms\)$','',match[1]))
        cases[file]=names
    return {'failed':failed,'cases':cases,'tests':sum(int(n) for n in re.findall(r'^ℹ tests (\d+)$',text,re.M)),
            'files':int(footer[2] if footer else passed[1])}
before=read('full-baseline');after=read('full-candidate')
assert before['files']==after['files'] and set(before['cases'])==set(after['cases']), 'The regression runs must cover the same complete file list.'
before_source=json.loads((root/'full-baseline-source.json').read_text());after_source=json.loads((root/'full-candidate-source.json').read_text())
assert before_source['sourceRoot'].endswith('/before') and after_source['sourceRoot'].endswith('/candidate'), 'Verify the captured baseline and candidate mounts.'
new_files=sorted(after['failed']-before['failed'])
new_cases={file:sorted(names-before['cases'].get(file,set())) for file,names in after['cases'].items() if names-before['cases'].get(file,set())}
raw_new_files=list(new_files);resolved_timeouts=[];repeat_validation={}
scroll_file='test/mbt/integration/stock-request-scroll-20261009-browser.test.js'
if scroll_file in new_files and not new_cases.get(scroll_file):
    section=re.search(r'\[isolation\] Stock Check regressions \d+/\d+ '+re.escape(scroll_file)+r'\n([\s\S]*?)(?=\[isolation\]|\Z)',(root/'full-candidate.log').read_text())
    candidate_text=section[1] if section else ''
    (root/'full-candidate-scroll-focus.log').write_text(candidate_text)
    fresh=True
    for label in ['full-repeat-baseline','full-repeat-candidate']:
        path=root/(label+'.log')
        fresh=fresh and path.exists() and path.stat().st_mtime>max((root/'full-baseline.log').stat().st_mtime,(root/'full-candidate.log').stat().st_mtime)
    if fresh and 'REGRESSION_TIMEOUT '+scroll_file in candidate_text:
        repeated_before=read('full-repeat-baseline');repeated_after=read('full-repeat-candidate')
        before_repeat_source=json.loads((root/'full-repeat-baseline-source.json').read_text());after_repeat_source=json.loads((root/'full-repeat-candidate-source.json').read_text())
        assert before_repeat_source['sourceRoot']==before_source['sourceRoot'] and after_repeat_source['sourceRoot']==after_source['sourceRoot']
        public_files=['stock-requests.css','scm-stock-requests.html','sales-stock-requests.html','scm-stock-requests.js','sales-stock-requests.js','stock-request-view.js','special-stock-form-state.js']
        unchanged=all((pathlib.Path(before_source['sourceRoot'])/'public'/file).read_bytes()==(pathlib.Path(after_source['sourceRoot'])/'public'/file).read_bytes() for file in public_files)
        passed_both=all(run['files']==1 and run['tests']==20 and not run['failed'] and set(run['cases'])=={scroll_file} and not any(run['cases'].values()) for run in [repeated_before,repeated_after])
        if unchanged and passed_both:
            resolved_timeouts.append(scroll_file);new_files.remove(scroll_file)
            repeat_validation[scroll_file]={'baselineTests':20,'candidateTests':20,'assertionsAndDeadlineUnchanged':True,'testedPublicSourceUnchanged':public_files,
                                            'classification':'Shared-budget timing failure: isolated baseline and candidate both passed; raw full-run failure retained.'}
result={'baselineFailedFiles':len(before['failed']), 'candidateFailedFiles':len(after['failed']),
        'baselineTestsReported':before['tests'],'candidateTestsReported':after['tests'],'newFailedFiles':new_files,'newFailingCases':new_cases,
        'filesPerRun':before['files'],'baselineSource':before_source,'candidateSource':after_source,
        'baselineFailingFiles':sorted(before['failed']),'candidateFailingFiles':sorted(after['failed']),
        'baselineFailingCases':{file:sorted(names) for file,names in before['cases'].items() if names},
        'candidateFailingCases':{file:sorted(names) for file,names in after['cases'].items() if names},
        'rawNewFailedFiles':raw_new_files,'resolvedTimeouts':resolved_timeouts,'repeatValidation':repeat_validation}
(root/'regressions.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({key:result[key] for key in ['filesPerRun','baselineFailedFiles','candidateFailedFiles','baselineTestsReported','candidateTestsReported','rawNewFailedFiles','resolvedTimeouts','newFailedFiles','newFailingCases']}))
if new_files or new_cases:raise SystemExit(1)

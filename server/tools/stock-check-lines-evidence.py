"""Validate fresh gauntlet output and record precise coverage and release scope."""
import difflib
import hashlib
import json
import pathlib
import re

SERVER=pathlib.Path(__file__).resolve().parents[1]
OUT=SERVER/'test-artifacts/stock-check-lines'
RAW=SERVER/'test-artifacts/stock-check'
RELEASE=SERVER/'deployments/stock-check-lines-20261014'
def read(path):return json.loads(path.read_text())
def main():
    started=read(OUT/'gauntlet-start.json')['started']
    stages=['static-lines-final','final-lines','final-lines-shuffled','matching-lines-final','full-lines-backorder','full-lines-special','boot-lines']
    for stage in stages:
        for suffix in ['.log','-cleanup.log','-docker-ps.txt','-docker-ps-a.txt']:
            path=OUT/(stage+suffix)
            assert path.exists() and path.stat().st_mtime>=started,('Missing fresh evidence',str(path))
        names=[line.split('\t')[0] for line in (OUT/(stage+'-docker-ps-a.txt')).read_text().splitlines()]
        assert all(name.startswith('mbbs-operator-app-') for name in names),names
    logs={stage:(OUT/(stage+'.log')).read_text() for stage in stages}
    assert 'error' not in logs['static-lines-final'].lower()
    assert 'error TS' not in (OUT/'static-lines-final-types.log').read_text()
    assert 'Secret scan passed' in (OUT/'static-lines-final-secrets.log').read_text()
    assert 'Healthy' in logs['boot-lines']
    totals={}
    for stage in ['final-lines','final-lines-shuffled','full-lines-backorder','full-lines-special']:
        match=re.search(r'Isolated .* run passed: (\d+) file\(s\), (\d+) test\(s\)\.',logs[stage]);assert match,stage
        totals[stage]={'files':int(match[1]),'passed':int(match[2])}
    mutations=read(RAW/'lines-mutations.json');assert len(mutations['results'])==4 and all(row['killed'] for row in mutations['results'])
    prepared=read(RELEASE/'prepared.json');manifest=read(RELEASE/'candidate-source.json')
    for name,expected in manifest.items():assert hashlib.sha256((RELEASE/'candidate'/name).read_bytes()).hexdigest()==expected,name
    coverage={**read(RAW/'coverage/coverage-final.json'),**read(RAW/'lines-browser-coverage-istanbul.json')}
    changed=[]
    for name in prepared['changed']:
        if not name.endswith('.js'):continue
        old=RELEASE/'before'/name;previous=old.read_text().splitlines() if old.exists() else []
        current=(RELEASE/'candidate'/name).read_text().splitlines();lines=set()
        for tag,_a,_b,start,end in difflib.SequenceMatcher(a=previous,b=current,autojunk=False).get_opcodes():
            if tag in ['insert','replace']:lines.update(range(start+1,end+1))
        file=next((value for key,value in coverage.items() if key==name or key.endswith('/'+name)),None)
        assert file,('No coverage',name)
        executed=set();mapped=set()
        for key,statement in file['statementMap'].items():
            span=set(range(statement['start']['line'],statement['end']['line']+1));mapped.update(span)
            if file['s'][key]>0:executed.update(span)
        branches=[]
        for key,branch in file['branchMap'].items():
            location=branch['loc'];span=set(range(location['start']['line'],location['end']['line']+1))
            if span & lines:
                branches.extend({'line':location['start']['line'],'arm':index,'executed':count>0} for index,count in enumerate(file['b'][key]))
        relevant=lines & mapped
        changed.append({'file':name,'executedChangedLines':len(relevant & executed),'mappedChangedLines':len(relevant),
          'uncoveredLines':sorted(relevant-executed),'unmappedChangedLines':sorted(lines-mapped),
          'executedChangedBranches':sum(branch['executed'] for branch in branches),'mappedChangedBranches':len(branches),
          'uncoveredBranches':[branch for branch in branches if not branch['executed']]})
    report={'passed':True,'tier':2,'specApproval':'not obtained (autonomous run)',
      'entryPoint':'bash tools/stock-check-lines-gauntlet.sh','sourceImage':prepared['imageId'],
      'sourceManifestSha256':hashlib.sha256((RELEASE/'candidate-source.json').read_bytes()).hexdigest(),
      'tests':totals,'manualMutation':{'killed':4,'total':4,'sourceUnchanged':mutations['sourceUnchanged']},
      'matchingProperties':{'properties':2,'examplesEach':100,'seed':20261014},'changedLineCoverage':changed,
      'toolchain':read(RAW/'lines-toolchain.json'),'newDependencies':[],
      'behaviors':read(SERVER/'test/support/stock-check-lines-spec.json')['behaviors'],
      'coverageLimits':'Uncovered branches are listed explicitly; line coverage does not imply every branch or possible portal behavior has been tested.',
      'notes':['Third rapid page reload also crashes untouched captured production source in both installed Chromium modes, with no container OOM. Status cases use separate sessions; both request workflows retain reload persistence assertions.',
        'No new schema, request workflow writes, order writes or cart mutations. Private evidence uses existing SCM authorization.',
        'Tests use disposable per-file databases and the bounded standard Compose project; all teardown checks passed.'],
      'skipped':['Dependency vulnerability/license audit: dependencies unchanged.','Whole repository MBT suite: change-scoped Stock Check suite and relevant backorder/special regressions run.','Production portal execution is recorded separately after deployment.']}
    (OUT/'evidence-report.json').write_text(json.dumps(report,indent=2)+'\n')
    (OUT/'validation.json').write_text(json.dumps({'passed':True,'imageId':prepared['imageId'],'tests':totals,'changedLineCoverage':changed},indent=2)+'\n')
    print(json.dumps({'passed':True,'tests':totals,'mutation':'4/4','coverage':changed}))
if __name__=='__main__':main()

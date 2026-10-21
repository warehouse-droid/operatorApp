"""Validate fresh gauntlet output and record precise coverage and release scope."""
import difflib
import hashlib
import json
import pathlib
import re
import subprocess

SERVER=pathlib.Path(__file__).resolve().parents[1]
OUT=SERVER/'test-artifacts/stock-check-description'
RAW=SERVER/'test-artifacts/stock-check'
RELEASE=SERVER/'deployments/stock-check-description-20261015'
def read(path):return json.loads(path.read_text())
def main():
    started=read(OUT/'gauntlet-start.json')['started']
    production={'mbbs-operator-app-app-1','mbbs-operator-app-db-1','mbbs-operator-app-webhook-worker-1','mbbs-operator-app-ollama-1'}
    current=set(subprocess.check_output(['sudo','-n','docker','ps','-a','--format','{{.Names}}'],text=True).splitlines())
    assert current==production,('Disposable resources still exist',sorted(current-production))
    concurrent=set()
    stages=['static-description-final','final-description','description-unit-final','matching-description-final','full-description-backorder','boot-description']
    for stage in stages:
        for suffix in ['.log','-cleanup.log','-docker-ps.txt','-docker-ps-a.txt']:
            path=OUT/(stage+suffix)
            assert path.exists() and path.stat().st_mtime>=started,('Missing fresh evidence',str(path))
        names=[line.split('\t')[0] for line in (OUT/(stage+'-docker-ps-a.txt')).read_text().splitlines()]
        assert not any(name.startswith('mbbs-stock-check-20261014-'+stage+'-') for name in names),names
        others=set(names)-production
        assert all(name.startswith('mbbs-') and name not in current for name in others),names
        concurrent.update(others)
    logs={stage:(OUT/(stage+'.log')).read_text() for stage in stages}
    assert 'error' not in logs['static-description-final'].lower()
    assert 'error TS' not in (OUT/'static-description-final-types.log').read_text()
    assert 'Secret scan passed' in (OUT/'static-description-final-secrets.log').read_text()
    assert 'Healthy' in logs['boot-description']
    totals={}
    for stage in ['final-description','full-description-backorder']:
        match=re.search(r'Isolated .* run passed: (\d+) file\(s\), (\d+) test\(s\)\.',logs[stage]);assert match,stage
        totals[stage]={'files':int(match[1]),'passed':int(match[2])}
    mutations=read(OUT/'mutations.json');assert len(mutations['results'])==4 and all(row['killed'] for row in mutations['results'])
    matching_mutations=read(RAW/'lines-mutations.json');assert len(matching_mutations['results'])==4 and all(row['killed'] for row in matching_mutations['results'])
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
        assert not relevant-executed,('Changed source lines were not executed',name,sorted(relevant-executed))
        changed.append({'file':name,'executedChangedLines':len(relevant & executed),'mappedChangedLines':len(relevant),
          'uncoveredLines':sorted(relevant-executed),'unmappedChangedLines':sorted(lines-mapped),
          'executedChangedBranches':sum(branch['executed'] for branch in branches),'mappedChangedBranches':len(branches),
          'uncoveredBranches':[branch for branch in branches if not branch['executed']]})
    report={'passed':True,'tier':2,'specApproval':'not obtained (autonomous run)',
      'entryPoint':'bash tools/stock-check-description-gauntlet.sh','sourceImage':prepared['imageId'],
      'sourceManifestSha256':hashlib.sha256((RELEASE/'candidate-source.json').read_bytes()).hexdigest(),
      'tests':totals,'manualMutation':{'killed':4,'total':4,'sourceUnchanged':mutations['sourceUnchanged']},
      'matchingProperties':{'existingPropertiesRetained':True,'manualMutation':{'killed':4,'total':4,'sourceUnchanged':matching_mutations['sourceUnchanged']}},'changedLineCoverage':changed,
      'cleanup':{'onlyProductionContainersAtValidation':True,'concurrentTestContainersInEarlierSnapshots':sorted(concurrent),'allObservedConcurrentContainersNowAbsent':True},
      'toolchain':read(RAW/'lines-toolchain.json'),'newDependencies':[],
      'behaviors':read(SERVER/'test/support/stock-check-description-spec.json')['behaviors'],
      'coverageLimits':'Uncovered branches are listed explicitly; line coverage does not imply every branch or possible portal behavior has been tested.',
      'notes':['Third rapid page reload also crashes untouched captured production source in both installed Chromium modes, with no container OOM. Status cases use separate sessions; both request workflows retain reload persistence assertions.',
        'No new schema, request workflow writes, order writes or cart mutations. Private evidence uses existing SCM authorization.',
        'Tests use disposable per-file databases and the bounded standard Compose project; all teardown checks passed.'],
      'skipped':['Dependency vulnerability/license audit: dependencies unchanged.','Whole repository MBT suite: change-scoped Stock Check suite and relevant backorder/special regressions run.','No new live portal or stock job execution: user requested read-only historical evaluation.']}
    history=read(OUT/'history-assessment.json');assert history['total']>=2 and history['incorrectAuto']==0 and history['userExampleMatched']
    assert history['descriptionSourceSha256']==manifest['src/stock-check/line-description.js'],'Historical evaluation used a different description implementation.'
    assert history['matchingSourceSha256']==manifest['src/stock-check/line-matching.js'],'Historical evaluation used a different candidate filter.'
    assert manifest['src/stock-check/ollama-matching.js']==read(RELEASE/'state.json')['sourceHashes']['src/stock-check/ollama-matching.js'],'Ollama must remain unchanged.'
    report['modelUnchanged']=True
    report['historicalEvaluation']=history
    report['references']=['https://docs.ollama.com/api/generate','https://github.com/ollama/ollama/blob/main/api/types.go']
    (OUT/'evidence-report.json').write_text(json.dumps(report,indent=2)+'\n')
    (OUT/'validation.json').write_text(json.dumps({'passed':True,'imageId':prepared['imageId'],'tests':totals,'changedLineCoverage':changed},indent=2)+'\n')
    print(json.dumps({'passed':True,'tests':totals,'mutation':'4/4','coverage':changed}))
if __name__=='__main__':main()

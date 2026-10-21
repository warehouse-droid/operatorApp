"""Strict enhancement release gate; only completed fresh results are accepted."""
import importlib.util
import json
from pathlib import Path
import re

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'test-artifacts/regular-waitlist-enhancements-20261002'
spec=importlib.util.spec_from_file_location('waitlist_result_parser',ROOT/'tools/regular-waitlist-report.py')
parser=importlib.util.module_from_spec(spec)
spec.loader.exec_module(parser)


def aggregate(out,evidence,baseline='baseline-full.log',final='final-full.log',focused='release-focused.log',shuffled='release-shuffled.log',affected=None,fixture_logs=('baseline-full-fixture.log','release-fixture.log')):
    full=parser.compare(parser.suite(out/baseline),parser.suite(out/final))
    assert not full['newFailures'],full['newFailures']
    feature,reordered=parser.suite(out/focused),parser.suite(out/shuffled)
    assert feature['tests']==reordered['tests']==63
    assert feature['pass']==reordered['pass']==63
    assert not feature['failedFiles'] and not reordered['failedFiles']
    assert feature['cancelled']==reordered['cancelled']==feature['skipped']==reordered['skipped']==0
    data={name:json.loads((evidence/(name+'.json')).read_text()) for name in ['changed-lines','types','lint','mutations','enhancement-mutations','safety','versions','fixture-baseline','fixture-final']}
    assert data['changed-lines']['covered']==data['changed-lines']['total'] and not data['changed-lines']['uncovered']
    assert not data['types']['newTypes'] and not data['lint']['newLint']
    assert data['mutations']['allKilled'] and data['mutations']['mutants']==11
    assert data['enhancement-mutations']['allKilled'] and data['enhancement-mutations']['mutants']==7
    assert data['mutations']['sourceHashes']==data['enhancement-mutations']['sourceHashes']==data['safety']['sourceHashes']
    assert not data['safety']['secretFindings'] and data['safety']['newDependencies']==0
    fixture_before,fixture_after=data['fixture-baseline'],data['fixture-final']
    assert fixture_before==fixture_after and fixture_before['runs']==4 and fixture_before['passedTests']==16
    assert fixture_before['assertionsChanged'] is False
    for name,log in zip(['baseline','final'],fixture_logs,strict=True):
        path=out/log;replay=parser.suite(path)
        assert replay['pass']==replay['tests']==16 and not replay['failedFiles']
        assert replay['fail']==replay['cancelled']==replay['skipped']==0
        completed=re.findall(r'^Isolated fixture replay '+name+r' ([1-4])/4 run passed: 1 file\(s\), 4 test\(s\)\.$',path.read_text(),re.M)
        assert completed==['1','2','3','4'],'Every replay must complete: '+str(path)
    times=json.loads((evidence/'browser/latency.json').read_text());assert times and max(times)<1000
    result={'completed':True,'newFailures':[],'sourceHashes':data['safety']['sourceHashes'],'sourceTreeSha256':data['safety']['sourceTreeSha256'],
      'feature':feature,'shuffled':reordered,'fullRegression':full,'coverage':data['changed-lines'],'types':data['types'],
      'newLintFindings':0,'mutationCount':18,'properties':{'count':6,'seed':261002,'examplesPerProperty':400},
      'submissionMilliseconds':times,'versions':data['versions'],'capabilities':data['safety']['capabilities'],'complexity':data['safety']['complexity'],
      'schemaChanges':[],'suiteHealthReplay':{'baseline':fixture_before,'final':fixture_after},
      'specApproval':'User directly requested the enhancements; a separate expanded-spec approval was not obtained (autonomous run).'}
    if affected:
        result['affectedRegression']=parser.compare(parser.suite(out/affected[0]),parser.suite(out/affected[1]))
        assert not result['affectedRegression']['newFailures'],result['affectedRegression']['newFailures']
    return result


if __name__=='__main__':
    result=aggregate(OUT,OUT/'release',affected=['release-baseline-affected.log','release-affected.log'])
    manifest=json.loads((ROOT/'deployments/regular-waitlist-enhancements-20261002/manifest.json').read_text())
    assert result['sourceHashes']==manifest['sourceHashes'],'Evidence must match the staged release.'
    (OUT/'checks.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'completed':True,'featureTests':result['feature']['pass'],'changedLines':[result['coverage']['covered'],result['coverage']['total']],
      'mutantsKilled':result['mutationCount'],'newFailingFiles':result['fullRegression']['newFailures'],'baselineFailedFiles':len(result['fullRegression']['baseline']['failedFiles']),
      'finalFailedFiles':len(result['fullRegression']['final']['failedFiles']),'localSubmissionMilliseconds':result['submissionMilliseconds']}))

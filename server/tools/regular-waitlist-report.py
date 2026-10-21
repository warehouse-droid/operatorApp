"""Strict result aggregation; incomplete runs and new failures are never accepted."""
import argparse
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def suite(path):
    text = path.read_text()
    failed = re.search(r'^Isolated .* run failed in (\d+)/(\d+) file\(s\): (.*)$', text, re.M)
    passed = re.search(r'^Isolated .* run passed: (\d+) file\(s\), (\d+) test\(s\)\.$', text, re.M)
    assert failed or passed, 'Incomplete test run: ' + str(path)
    failures = failed[3].split(', ') if failed else []
    count = int(failed[2] if failed else passed[1])
    assert not failed or int(failed[1]) == len(failures)
    summaries = {name: sum(map(int, re.findall(r'^ℹ ' + name + r' (\d+)$', text, re.M))) for name in ['tests','pass','fail','cancelled','skipped']}
    return {'files':count, 'failedFiles':failures, **summaries}


def compare(previous, current):
    return {'baseline':previous, 'final':current, 'newFailures':sorted(set(current['failedFiles'])-set(previous['failedFiles'])),
            'resolvedFailures':sorted(set(previous['failedFiles'])-set(current['failedFiles']))}


def aggregate(out, evidence, baseline, final, focused, shuffled, affected=None):
    regression = compare(suite(out/baseline),suite(out/final))
    assert not regression['newFailures'], regression['newFailures']
    feature, reordered = suite(out/focused),suite(out/shuffled)
    assert not feature['failedFiles'] and not reordered['failedFiles']
    assert feature['tests'] == reordered['tests'] == 52
    data = {name: json.loads((evidence/(name+'.json')).read_text()) for name in ['changed-lines','types','lint','mutations','safety','versions']}
    assert data['changed-lines']['total'] == data['changed-lines']['covered'] and not data['changed-lines']['uncovered']
    assert not data['types']['newTypes'] and not data['lint']['newLint']
    assert data['mutations']['allKilled'] and data['mutations']['mutants'] == 11
    assert data['mutations']['sourceHashes'] == data['safety']['sourceHashes']
    assert not data['safety']['secretFindings'] and data['safety']['newDependencies'] == 0
    latency = json.loads((evidence/'browser/latency.json').read_text())
    assert latency and max(latency)<1000
    result = {'completed':True,'newFailures':[],'sourceHashes':data['safety']['sourceHashes'],'sourceTreeSha256':data['safety']['sourceTreeSha256'],
              'fullRegression':regression,'feature':feature,'shuffled':reordered,'coverage':data['changed-lines'],
              'types':data['types'],'newLintFindings':len(data['lint']['newLint']),'mutationCount':data['mutations']['mutants'],
              'properties':{'seed':261002,'properties':4,'examplesPerProperty':400},'submissionMilliseconds':latency,'versions':data['versions'],
              'capabilities':data['safety']['capabilities'],'complexity':data['safety']['complexity']}
    if affected:
        result['affectedRegression'] = compare(suite(out/affected[0]),suite(out/affected[1]))
        assert not result['affectedRegression']['newFailures'], result['affectedRegression']['newFailures']
    return result


if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--out',type=Path,default=ROOT/'test-artifacts/regular-waitlist')
    parser.add_argument('--evidence',type=Path)
    parser.add_argument('--baseline',default='baseline-full-fresh.log')
    parser.add_argument('--final',default='final-full-fresh.log')
    parser.add_argument('--focused',default='release-focused-verified.log')
    parser.add_argument('--shuffled',default='release-shuffled-verified.log')
    parser.add_argument('--affected-baseline',default='release-baseline-affected.log')
    parser.add_argument('--affected-final',default='release-final-affected.log')
    args=parser.parse_args()
    result=aggregate(args.out,args.evidence or args.out/'release',args.baseline,args.final,args.focused,args.shuffled,
                     [args.affected_baseline,args.affected_final] if args.affected_baseline else None)
    manifest=ROOT/'deployments/regular-waitlist-20261002/manifest.json'
    if manifest.exists():
        assert result['sourceHashes'] == json.loads(manifest.read_text())['sourceHashes'], 'Evidence must match the deploy candidate'
    (args.out/'checks.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'completed':True,'featureTests':result['feature']['tests'],'changedLines':[result['coverage']['covered'],result['coverage']['total']],
                      'mutantsKilled':result['mutationCount'],'newFailingFiles':result['newFailures'],'baselineFailedFiles':len(result['fullRegression']['baseline']['failedFiles']),
                      'finalFailedFiles':len(result['fullRegression']['final']['failedFiles']),'localSubmissionMilliseconds':result['submissionMilliseconds']}))

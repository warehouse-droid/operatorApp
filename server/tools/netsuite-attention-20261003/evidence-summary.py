"""Recompute changed-line coverage and baseline-aware validation evidence."""
import collections,difflib,hashlib,json,pathlib,re
root=pathlib.Path(__file__).resolve().parents[2]
out=root/'test-artifacts/netsuite-attention-20261003'
private=pathlib.Path('/home/ubuntu/operatorapp-investigations/netsuite-attention-20261003')
files=json.loads((root/'tools/netsuite-attention-20261003/deployment-files.json').read_text())
manifest=json.loads((out/'deployment-manifest.json').read_text())
coverage=json.loads((out/'coverage/coverage-final.json').read_text())
changed={}
for file in files:
 assert hashlib.sha256((root/file).read_bytes()).hexdigest()==manifest['files'][file]
 if not file.startswith('src/'):continue
 baseline=private/'runtime-before'/file
 old=baseline.read_text().splitlines() if baseline.exists() else []
 current=(root/file).read_text().splitlines()
 changed_lines=set()
 for tag,_,__,start,end in difflib.SequenceMatcher(a=old,b=current).get_opcodes():
  if tag in ('insert','replace'):changed_lines.update(range(start+1,end+1))
 cov=coverage['/app/'+file];hits=collections.defaultdict(int)
 for key,span in cov['statementMap'].items():
  for line in range(span['start']['line'],span['end']['line']+1):hits[line]=max(hits[line],cov['s'][key])
 instrumented=changed_lines & hits.keys()
 missing=sorted(line for line in instrumented if hits[line]==0)
 changed[file]={'changed':len(instrumented),'covered':len(instrumented)-len(missing),'missing':missing}
(out/'changed-coverage.json').write_text(json.dumps(changed,indent=2)+'\n')
def type_diagnostics(name):
 return {re.sub(r'\(\d+,\d+\)','',line) for line in (out/f'types-{name}.log').read_text().splitlines() if 'error TS' in line}
def failed_files(path):
 lines=path.read_text().splitlines();last=next(line for line in reversed(lines) if line.startswith('Isolated MBT main run failed'))
 return set(re.findall(r'/app/test/\S+\.test\.js',last))
current_failures=failed_files(out/'full-final.log')
baseline_failures=failed_files(root/'test-artifacts/to-line-reference-20261003/final-full.log')
mutations=json.loads((out/'mutation.json').read_text())
summary={'image':manifest['candidateImage'],'sourceFiles':manifest['files'],
 'focusedTests':230,'focusedFailed':0,'shuffledTests':230,'browser':json.loads((out/'browser.json').read_text()),
 'mutation':{'killed':sum(x['killed'] for x in mutations),'total':len(mutations),'propertyKilled':sum(x['propertyKilled'] for x in mutations)},
 'changedLineCoverage':changed,'newTypeDiagnostics':sorted(type_diagnostics('final')-type_diagnostics('baseline')),
 'existingTypeErrorCount':sum('error TS' in line for line in (out/'types-final.log').read_text().splitlines()),
 'fullSuite':{'files':833,'failedFilesAtBroadRun':len(current_failures),'baselineFailedFiles':len(baseline_failures),
  'newFilesComparedWithEarlierBaseline':sorted(current_failures-baseline_failures),
  'fixedAndRechecked':'unit/child-location-parts-service.test.js (12 tests; included in final focused 230)',
  'remainingNewFailuresReproducedWithoutTaskChanges':['unit/special-stock-request-wiring.red.test.js','integration/special-case-fields-http.test.js'],
  'limitation':'Broad suite is not green; final focused suite includes the multipart fix. No second complete broad run.'},
 'reconciliation':{'main':json.loads((private/'reconcile-apply.json').read_text()),
                   'supplement':json.loads((private/'supplement-apply.json').read_text())}}
(out/'evidence.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps({'changedLines':sum(x['changed'] for x in changed.values()),'covered':sum(x['covered'] for x in changed.values()),
 'newTypes':len(summary['newTypeDiagnostics']),'broadFailedFiles':len(current_failures)},indent=2))

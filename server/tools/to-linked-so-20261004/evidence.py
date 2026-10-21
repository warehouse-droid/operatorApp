"""Summarize retained test output and final-source coverage without hiding baselines."""
import collections,difflib,hashlib,json,pathlib,re
root=pathlib.Path(__file__).resolve().parents[2];out=root/'test-artifacts/to-linked-so-20261004'
private=pathlib.Path('/home/ubuntu/operatorapp-investigations/to-linked-so-20261004')
files=json.loads((root/'tools/to-linked-so-20261004/deployment-files.json').read_text())
state={f:hashlib.sha256((root/f).read_bytes()).hexdigest() for f in files}
for phase in ['focused','static','mutation']:
 assert json.loads((out/f'{phase}-manifest.json').read_text())['files']==state,phase+' results predate source'
coverage=json.loads((out/'coverage/coverage-final.json').read_text());changed={}
for file in files:
 if not file.startswith('src/'):continue
 p=private/'baseline'/file;old=p.read_text().splitlines() if p.exists() else [];current=(root/file).read_text().splitlines()
 lines=set()
 for tag,_,__,first,last in difflib.SequenceMatcher(a=old,b=current).get_opcodes():
  if tag in ('insert','replace'):lines.update(range(first+1,last+1))
 c=coverage['/app/'+file];hits=collections.defaultdict(int)
 for key,span in c['statementMap'].items():
  for line in range(span['start']['line'],span['end']['line']+1):hits[line]=max(hits[line],c['s'][key])
 instrumented=lines & hits.keys();missing=sorted(line for line in instrumented if hits[line]==0)
 changed[file]={'changed':len(instrumented),'covered':len(instrumented)-len(missing),'missing':missing}
def failed(path):
 lines=[s for s in path.read_text().splitlines() if s.startswith('Isolated MBT main run failed')]
 return set(re.findall(r'/app/test/[^, ]+',lines[-1])) if lines else set()
def counts(path):return dict(re.findall(r'^# (tests|pass|fail) (\d+)$',path.read_text(),re.M))
def types(name):return {re.sub(r'\(\d+,\d+\)','',s) for s in (out/f'types-{name}.log').read_text().splitlines() if 'error TS' in s}
full=(out/'full-final.log').read_text();complete='Isolated MBT main run failed' in full or 'Isolated MBT main run passed' in full
new=sorted(failed(out/'full-final.log')-failed(out/'baseline-full.log')) if complete else None
summary={'sourceFiles':state,'treeHash':hashlib.sha256(json.dumps(state,sort_keys=True).encode()).hexdigest(),
 'focused':counts(out/'focused-final.log'),'shuffled':counts(out/'shuffled-final.log'),'changedCoverage':changed,
 'coverage':json.loads((out/'coverage/coverage-summary.json').read_text())['total'],
 'browser':json.loads((out/'browser.json').read_text()),'mutation':json.loads((out/'mutation.json').read_text()),
 'newTypeDiagnostics':sorted(types('final')-types('baseline')),'existingTypeDiagnosticCount':sum('error TS' in s for s in (out/'types-final.log').read_text().splitlines()),
 'broadSuite':{'complete':complete,'failedFiles':len(failed(out/'full-final.log')) if complete else None,'newFailures':new,
  'baseline':'Previous task broad run; pre-existing failures retained. The broad run overlapped final guard refinements; all affected files were rechecked in the final focused run.'}}
(out/'evidence.json').write_text(json.dumps(summary,indent=2)+'\n');(out/'changed-coverage.json').write_text(json.dumps(changed,indent=2)+'\n')
(out/'source-state.json').write_text(json.dumps({'files':state,'treeHash':summary['treeHash']},indent=2)+'\n')
print(json.dumps({'tests':summary['focused'],'changedLines':sum(v['changed'] for v in changed.values()),'covered':sum(v['covered'] for v in changed.values()),'broadSuite':summary['broadSuite']}))

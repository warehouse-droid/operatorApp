import difflib,json
from pathlib import Path
SERVER=Path(__file__).resolve().parents[2];OUT=SERVER/'test-artifacts/special-local-adjustments-20261013'
result={}
for file in ['public/sales-special-stock-requests.js','public/scm-special-stock-requests.js']:
    source=(SERVER/file).read_text();after=source.splitlines(True);before=(OUT/'before'/file).read_text().splitlines(True);changed=set()
    for tag,a,b,c,d in difflib.SequenceMatcher(None,before,after).get_opcodes():
        if tag in ['replace','insert']:changed.update(range(c+1,d+1))
    entries=[e for p in (OUT/'browser').glob('browser-coverage-*.json') for e in json.loads(p.read_text()) if e.get('url','').split('?')[0].endswith('/'+Path(file).name)]
    covered=[];missing=[];offsets=[];total=0
    for line in after:offsets.append(total);total+=len(line)
    for number in sorted(changed):
        if not after[number-1].strip():continue
        offset=offsets[number-1]+len(after[number-1])-len(after[number-1].lstrip());hits=[]
        for entry in entries:
            assert entry['source']==source,'Browser coverage is stale'
            ranges=[r for f in entry['functions'] for r in f['ranges'] if r['startOffset']<=offset<r['endOffset']]
            if ranges:hits.append(min(ranges,key=lambda r:r['endOffset']-r['startOffset'])['count'])
        (covered if any(hits) else missing).append(number)
    result[file]={'changedLines':len(covered)+len(missing),'coveredLines':len(covered),'missingLines':missing}
(OUT/'ui-changed-coverage.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result),flush=True)
assert not any(r['missingLines'] for r in result.values()),'Changed UI behavior needs a meaningful browser check'

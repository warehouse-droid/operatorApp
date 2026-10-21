"""Record the reproducible source, UI regression, deployment and cleanup evidence."""
from pathlib import Path
import json,hashlib
root=Path(__file__).resolve().parents[2]
out=root/'test-artifacts/scm-line-visibility-20261016'
def load(name):return json.loads((out/name).read_text())
summary=load('summary.json');cleanup=load('release-cleanup.json');coverage=load('changed-coverage.json')
release=json.loads((root/'deployments/scm-line-visibility-20261016/manifest.json').read_text());sources=load('source-manifest.json')
assert summary['tests']==summary['passed'] and summary['newFailures']==0
assert cleanup['productionHealthy'] and not any(cleanup[key] for key in ['ownContainers','networks','volumes'])
assert all(sources[file]==digest for file,digest in release['after'].items())
result={'summary':summary,'coverage':coverage,'sourceManifestSha256':hashlib.sha256((out/'source-manifest.json').read_bytes()).hexdigest(),
 'deployment':load('deployment-result.json'),'productionProbes':load('production-smoke.json'),'cleanup':cleanup,
 'behaviors':['SCM Special and Backorder hide Sales withdrawal and customer-declined rows before/after stock check','Show All and Hide Decline/Revoke toggle in place without discarding drafts','Active, restored and request-update rows remain visible','Hidden revised lines are disabled and excluded from batch stock-check submissions','All-declined mobile case can reveal lines; hidden-only submit remains disabled','Existing declined-line revision locks and conversation notifications/order retain their behavior'],
 'reproduce':'python3 tools/scm-line-visibility-20261016/run.py release',
 'notes':['No backend, schema or dependency changes. No live business writes used for testing.','Initial RED reproduced missing toggle in both SCM views. First GREEN had one test attempting to click the toggle while an existing order-operation lock disabled all controls; the test now checks underlying hidden actions with includeHidden, preserving the original lock assertions.','Browser execution uses complete pages with network fixtures; unit regressions retain decision/revoke and Backorder workflow behavior.']}
(out/'evidence.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'tests':summary,'changedLines':str(sum(v['covered'] for v in coverage.values()))+'/'+str(sum(v['total'] for v in coverage.values())),'cleanup':'verified'}))

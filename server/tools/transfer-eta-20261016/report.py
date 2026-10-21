"""Record source, test, migration, deployment and host-cleanup evidence."""
from pathlib import Path
import hashlib,json
root=Path(__file__).resolve().parents[2]
task=root/'tools/transfer-eta-20261016'
out=root/'test-artifacts/transfer-eta-20261016'
def load(name):return json.loads((out/name).read_text())
summary=load('summary.json');cleanup=load('release-cleanup.json');coverage=load('changed-coverage.json')
release=json.loads((root/'deployments/transfer-eta-20261016/manifest.json').read_text());sources=load('source-manifest.json')
assert summary['tests']==summary['passed'] and summary['newFailures']==0
assert cleanup['productionHealthy'] and not any(cleanup[key] for key in ['ownContainers','networks','volumes'])
assert all(sources[file]==digest for file,digest in release['after'].items())
assert all(not record['missed'] for record in coverage.values())
mutants=load('mutations.json');assert all(record['killed'] for record in mutants)
assert len([record for record in mutants if not record['propertyOnly']])==summary['mutantsKilled']
result={'spec':json.loads((task/'spec.json').read_text()),'summary':summary,'changedLineCoverage':coverage,
 'sourceManifestSha256':hashlib.sha256((out/'source-manifest.json').read_bytes()).hexdigest(),
 'tools':{file.name:hashlib.sha256(file.read_bytes()).hexdigest() for file in task.iterdir() if file.is_file()},
 'layers':{'regressions':'107 scoped unit, property, repository, service and real-browser tests; see suite.log',
  'types':'New shared ETA/calendar module checked with TypeScript; syntax checks on every changed JavaScript module.',
  'lint':'New module, Backorder UI, new/changed transfer tests and check runner; known browser globals configured explicitly.',
  'mutation':mutants,'property':'250 date samples from 2025–2040 plus explicit Thanksgiving, Christmas, leap-year and weekend examples; calendar mutants also killed by the property test alone.',
  'migration':load('schema-check.json'),'suiteHealth':'Transfer and SO service tests rerun with isolated process state.',
  'realExecution':'Sales and SCM browser flows use the actual app and isolated PostgreSQL; only NetSuite directory lookup is replaced with a fixture.',
  'dependencies':'No dependency changes; diff secret scan passed.',
  'review':'Reviewed actual before-placement and after-placement screenshots for both request types.'},
 'behaviorTests':{
  'normalization, calendar and legacy label':'test/mbt/unit/special-stock-transfer.test.js',
  'acceptance, anchoring, retries, legacy ETAs, transaction rollback and non-relative date validation':'test/mbt/integration/special-stock-transfer.test.js',
  'browser submission, acceptance, pre-SO readiness and final ETA':'test/mbt/integration/special-transfer-eta-browser.test.js',
  'decline visibility and revision forms':'test/mbt/integration/scm-line-visibility-browser.test.js and special-stock-check-editing-browser.test.js',
  'order creation/recovery and Backorder planning gates':'special-stock-request-service.red.test.js, special-stock-request-netsuite.red.test.js and backorder-requests.test.js'},
 'deployment':load('deployment-result.json'),'productionProbes':load('production-smoke.json'),'cleanup':cleanup,
 'reproduce':'python3 tools/transfer-eta-20261016/run.py release',
 'limitations':['No live NetSuite order or live request was used for testing. Existing SO create/recovery service contracts were retained and tested.',
  'The repository-wide suite and type checks for large legacy UI/repository modules were not run; verification covers the affected workflows.',
  'Manually linked orders use their mirrored transaction date. If unavailable, link day is saved as the placement day.',
  'Existing fixed transfer ETAs remain dated. A new stock response adopts this policy. After placement SCM can still revise readiness ETA for a delay.'],
 'developmentNotes':['RED reproduced the missing-date blocker in all five initial repository scenarios and four unit cases.',
  'Test setup corrections preserved existing Backorder PO planning gate, matched the actual customer-decisions URL, and compared persisted audit rows rather than Sales versus SCM event projections.',
  'Coverage is explicitly collected before browser reloads so earlier interactions are retained.',
  'One schema-only migration adds the saved placement day and relative availability mode. Production rollback retains this additive-compatible schema.']}
(out/'evidence.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'tests':summary,'changedLines':str(sum(v['covered'] for v in coverage.values()))+'/'+str(sum(v['total'] for v in coverage.values())),'cleanup':'verified'}))

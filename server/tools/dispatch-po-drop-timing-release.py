#!/usr/bin/env python3
"""Release: a linked PO drop no longer clears its load's planned finish on every Dispatch autosave.

Confirming the 2026-11-06 plan failed with "Load 2 requires a planned start and finish time before
confirmation". Load 2 carried PO SN1404256, linked by SCM to GOA-11312-11314. The Dispatch page keeps a
PO drop's vendor pickup in `location` (destination in dropLocation/dropAddress) and keeps its own stops
between autosaves. On every save the dependency projection rewrote that stop's `location` to the
destination yard and added dependencyTargetRefs. Both counted as a physical route change, so the
server deleted the load's plannedFinishMinute/timing every time and confirm rejected the load.
  * src/scm-dependency-plan-reconciler.js keeps an existing stop's `location`.
  * src/dispatch-plan-order-projection.js no longer counts dependencyTargetRefs as route evidence.

Backend only, no migration. The candidate is the live copy plus
deployments/dispatch-po-drop-timing-20261105/change.patch (only this change, strict context, no fuzz).

Steps: patch -> prepare -> validate -> build -> deploy (verifies; rolls the app back on failure) -> verify.
Validation reuses the e2e test image (no build) as earlier releases do: each tree on a fresh database,
every test file on its own clone; live must fail the new test, the candidate must pass the target file
and add no failure to the dependency, projection and pickup suites.
"""
import json,os,runpy,subprocess,sys
from pathlib import Path

previous=runpy.run_path(str(Path(__file__).with_name('special-scm-line-details-release.py')))
scm=previous['prepare'].__globals__
prev,split,sor,base=scm['prev'],scm['split'],scm['sor'],scm['base']
SERVER,APP=base['SERVER'],base['APP']
OUT=SERVER/'deployments/dispatch-po-drop-timing-20261105'
PATCH=OUT/'change.patch'
FILES=['src/scm-dependency-plan-reconciler.js','src/dispatch-plan-order-projection.js']
IMAGE='mbbs-operator-app:dispatch-po-drop-timing-20261105'
ROLLBACK='mbbs-operator-app:dispatch-po-drop-timing-rollback-20261105'
TARGET_FILES=['test/dispatch/unit/dispatch-po-route-residual.red.test.js']
EXPECTED_TARGET=16
REGRESSION=[f'test/{name}.test.js' for name in '''
mbt/unit/scm-dependency-plan-reconciler.red mbt/unit/dispatch-plan-authoritative-projection.red
mbt/unit/dispatch-plan-authoritative-projection-wiring.contract mbt/unit/link-to-group mbt/integration/link-to-group
dispatch/unit/dependency-pickup-reconciliation dispatch/unit/linked-po-pickup-20261028 dispatch/unit/dispatch-group-member-po
dispatch/unit/sov-dispatch dispatch/property/dispatch-plan-authoritative-projection.property
dispatch/property/dispatch-save-projection-identity dispatch/adversarial/dispatch-plan-authoritative-projection.adversarial
dispatch/integration/dispatch-recorded-po-load dispatch/integration/order-dependency-multi-to-extension.red
dispatch/integration/dispatch-required-pickups-save dispatch/integration/sor-return-source-refresh
dispatch/frontend/dispatch-required-pickups dispatch/frontend/dispatch-pickup-address-grouping
'''.split()]
LINT=[*TARGET_FILES,*FILES]
# The released patch must carry these, and nothing from other workspace work.
MARKERS={'src/scm-dependency-plan-reconciler.js':'location: text(stop.location) || destinationYard || address',
  'src/dispatch-plan-order-projection.js':'dependencyTargetRefs is a projection annotation'}
scm.update(OUT=OUT,PATCH=PATCH,FILES=FILES,NEW_FILES=set(),IMAGE=IMAGE,ROLLBACK=ROLLBACK,TARGET_FILES=TARGET_FILES,
  EXPECTED_TARGET=EXPECTED_TARGET,REGRESSION=REGRESSION,LINT=LINT,MARKERS=MARKERS)
for scope in (split,sor):scope.update(OUT=OUT)
split.update(PATCH=PATCH,FILES=FILES,IMAGE=IMAGE,ROLLBACK=ROLLBACK)
base.update(OUT=OUT,FILES=FILES,IMAGE=IMAGE,ROLLBACK=ROLLBACK)
# The proven validation harness reads these globals.
prev.update(OUT=OUT,FILES=FILES,TARGET_FILES=TARGET_FILES,REGRESSION=REGRESSION)
base['apply_migration']=lambda:{'required':False}

def validate():
    # The shared validate re-runs its own __file__ under the retention runner; re-run this release instead.
    if not os.environ.get('MBBS_TEST_ARTIFACT_DIR'):
        raise SystemExit(subprocess.run([sys.executable,str(SERVER.parent/'docker/retention/retention.py'),'run','--',
          sys.executable,__file__,'validate']).returncode)
    scm['validate']()

def deploy():
    captured=json.loads((OUT/'capture.json').read_text())['app']['imageId']
    assert json.loads((OUT/'validation.json').read_text()).get('baseImageId')==captured==base['metadata'](APP)['imageId'],\
        'Validation was not run on the current live image; patch, prepare and validate again'
    active=base['db']("SET default_transaction_read_only=on; SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing');")
    assert active=='0','A NetSuite posting is running; retry deployment after it finishes'
    base['deploy']()
    state=json.loads((OUT/'capture.json').read_text())
    (OUT/'rollback-command.txt').write_text(' '.join(base['compose'](state,OUT/'compose.rollback.json'))+'\n'
      +'# Backend only; no schema change.\n')

LIVE_CHECK=r'''
const projection = await import("/app/src/dispatch-plan-order-projection.js");
const reconciler = await import("/app/src/scm-dependency-plan-reconciler.js");
console.log(JSON.stringify({ reconcile: typeof projection.reconcileAuthoritativeDispatchOrderProjection,
  pickups: typeof reconciler.reconcileDependencyManagedPickups }));
process.exit(0);
'''

def verify():
    prepared=base['ensure_sources']()
    for name,expected in prepared['sourceHashes'].items():
        assert base['docker']('exec',APP,'sha256sum','/app/'+name).split()[0]==expected,name
    assert base['health'](),'Application is not healthy'
    loaded=json.loads(base['docker']('exec','-i','-w','/app',APP,'node','--input-type=module',data=LIVE_CHECK.encode()).splitlines()[-1])
    assert loaded=={'reconcile':'function','pickups':'function'},loaded
    base['save'](OUT/'live-verification.json',{'healthy':True,'sourceHashesVerified':True,'modules':loaded})
    print(json.dumps({'liveVerification':'passed','files':len(FILES),'modules':loaded}))
base['verify']=verify

def make_patch():
    """Capture the live copy, then diff exactly the release files against the workspace."""
    scm['make_patch']()

if __name__=='__main__':
    {'patch':make_patch,'prepare':scm['prepare'],'validate':validate,'build':split['build'],
     'deploy':deploy,'verify':verify}[sys.argv[1]]()

#!/usr/bin/env python3
"""Release the Operator stepper number pad.

Stepper quantities on the Operator screen (Pack / Packed in Delivery Prep and Customer Pickup, Receive
in Receiving, allocations in Consolidation Pick) were read-only and changed only with + / -. Tapping
the quantity (or Enter on it) now opens an on-screen number pad (public/operator-stepper-keypad.js):
the first digit replaces the shown quantity, the maximum is shown and cannot be exceeded, a decimal
key appears only for sales units, and Cancel / Escape / backdrop keep the old value. + / - are
unchanged. The device keyboard is not used, matching the tablets' application-keypad default.

Front-end only, no migration. The candidate is the live copy plus
deployments/operator-stepper-keypad-20261104/change.patch (only this change, strict context, no fuzz);
operator.html, service-worker.js and the cache name are bumped so installed PWAs pick it up.

Steps: patch -> prepare -> validate -> build -> deploy (verifies; rolls the app back on failure) -> verify.
Validation reuses the e2e test image (no build) exactly as the SCM line-details release does: each tree
on a fresh database, every test file on its own clone; live must fail the new tests, the candidate must
pass them and add no failure to the Operator suites.
"""
import json,os,re,runpy,subprocess,sys,urllib.request
from pathlib import Path

previous=runpy.run_path(str(Path(__file__).with_name('special-scm-line-details-release.py')))
scm=previous['prepare'].__globals__
prev,split,sor,base=scm['prev'],scm['split'],scm['sor'],scm['base']
SERVER,APP=base['SERVER'],base['APP']
OUT=SERVER/'deployments/operator-stepper-keypad-20261104'
PATCH=OUT/'change.patch'
FILES=['public/operator-stepper-keypad.js','public/operator.js','public/operator.css','public/i18n.js',
  'public/operator.html','public/service-worker.js']
NEW_FILES={'public/operator-stepper-keypad.js'}
IMAGE='mbbs-operator-app:operator-stepper-keypad-20261104'
ROLLBACK='mbbs-operator-app:operator-stepper-keypad-rollback-20261104'
TARGET_FILES=['test/mbt/unit/operator-stepper-keypad.test.js','test/mbt/integration/operator-stepper-keypad-browser.test.js']
EXPECTED_TARGET=9
REGRESSION=[f'test/{name}.test.{ext}' for ext,names in [('js','''
mbt/integration/operator-shared-pack-balance-browser mbt/integration/staff-login-browser
mbt/infrastructure/legacy-public-syntax mbt/unit/customer-pickup-inline-wait mbt/unit/customer-pickup-yard-ui
mbt/unit/group-underpack-ui mbt/unit/load-completion-rounding mbt/unit/local-vrma-final-qty-ui
mbt/unit/noninventory-fulfillment mbt/unit/operations-navigation-enhancements mbt/unit/operator-background-confirm
mbt/unit/operator-camera-rollback mbt/unit/operator-customer-pickup-photo-gate-ui.contract mbt/unit/operator-delivery-refresh
mbt/unit/operator-direct-orderline-client mbt/unit/operator-linked-fulfillment-ui.red mbt/unit/operator-load-journal-hold
mbt/unit/operator-native-camera mbt/unit/operator-netsuite-failures mbt/unit/operator-netsuite-posting-ui.red
mbt/unit/operator-page-confirm-ui.contract mbt/unit/operator-performance-regressions mbt/unit/operator-posting-photo-client
mbt/unit/operator-posting-responsiveness mbt/unit/operator-receiving-quantity-ui mbt/unit/operator-receiving-return
mbt/unit/operator-shared-pack-balance mbt/unit/operator-ui-enhancements mbt/unit/operator-yard-assets
mbt/unit/operator-display-settings mbt/unit/pickup-remaining-packs mbt/unit/receiving-multi-yard-ui
mbt/unit/receiving-posting-status mbt/unit/receiving-split-balance-ui mbt/unit/return-enhancements-ui
mbt/unit/return-pallet-optional-plate-ui mbt/unit/sales-order-reload-photo-entry mbt/unit/stock-exchange
operator-inventory-browser damage-retry-assets inventory-count-review-browser count-sheet-refresh
'''),('mjs','''
mbt/integration/customer-pickup-lookup-access.browser dispatch/frontend/consolidation-load.browser
dispatch/frontend/operator-auto-camera.browser
dispatch/frontend/operator-camera-rollback.browser dispatch/frontend/operator-display-settings.browser
dispatch/frontend/operator-phone.browser dispatch/frontend/operator-yard-access.browser operator-damage-camera.browser
''')] for name in names.split()]
LINT=TARGET_FILES
# Not in REGRESSION: test/dispatch/frontend/local-vrma-final-qty.browser.test.mjs is flaky on live itself (2026-11-05:
# 15 runs each, live failed 6, candidate 5, always 'null !== false' at line 25: it reads window.loadResult right after
# clicking Go back without waiting for the dialog's async close event). It loads none of this release's code paths.
# The released patch must carry these, and nothing from other workspace work.
MARKERS={'public/operator-stepper-keypad.js':'OperatorStepperKeypad','public/operator.js':'stepperKeypadTarget',
  'public/operator.css':'stepper-keypad-dialog','public/i18n.js':'operator.quantityAboveMax',
  'public/operator.html':'stepperKeypad=20261104','public/service-worker.js':'stepper-keypad-v1'}
TAG='stepperKeypad=20261104'
scm.update(OUT=OUT,PATCH=PATCH,FILES=FILES,NEW_FILES=NEW_FILES,IMAGE=IMAGE,ROLLBACK=ROLLBACK,TARGET_FILES=TARGET_FILES,
  EXPECTED_TARGET=EXPECTED_TARGET,REGRESSION=REGRESSION,LINT=LINT,MARKERS=MARKERS)
for scope in (split,sor):scope.update(OUT=OUT)
split.update(PATCH=PATCH,FILES=FILES,IMAGE=IMAGE,ROLLBACK=ROLLBACK)
base.update(OUT=OUT,FILES=FILES,IMAGE=IMAGE,ROLLBACK=ROLLBACK)
# The proven validation harness reads these globals.
prev.update(OUT=OUT,FILES=FILES,TARGET_FILES=TARGET_FILES,REGRESSION=REGRESSION)
prev['TEST_ENV']['OPERATOR_STEPPER_KEYPAD_SCREENSHOTS']='/app/test-artifacts'
base['apply_migration']=lambda:{'required':False}

# Other sessions edit operator.js / i18n.js in the shared workspace (e.g. the Returns "not fulfilled"
# message, 2026-11-04). Only hunks that change these lines belong to this release.
MINE=re.compile(r'stepper|Stepper|aria-haspopup|consolidationAllocationUnit|setConsolidationAllocation|packQtyLimit|setPackQty'
  r'|operator\.(?:enterQuantity|maxQuantity|quantityAboveMax)')
scm['UNRELATED']=(*scm['UNRELATED'],'NotFulfilled','NOT_FULFILLED','NotFullyFulfilled','NOT_FULLY_FULFILLED')

def make_patch():
    """Capture the live copy, then keep only this release's hunks of the workspace diff."""
    sor['capture']()
    live,parts,kept,dropped=OUT/'live-before',[],[],[]
    for name in FILES:
        old=live/name
        result=subprocess.run(['diff','-u','--label',f'a/server/{name}' if old.exists() else '/dev/null','--label',f'b/server/{name}',
          str(old) if old.exists() else '/dev/null',str(SERVER/name)],capture_output=True,text=True)
        assert result.returncode==1,(name,'unchanged' if result.returncode==0 else result.stderr)
        header,*hunks=re.split(r'(?m)^(?=@@ )',result.stdout)
        changed=lambda hunk:''.join(line for line in hunk.splitlines(True)[1:] if line[:1] in '+-')
        mine=[hunk for hunk in hunks if MINE.search(changed(hunk))]
        assert mine,(name,'no release hunks')
        kept+=[f'{name} {hunk.splitlines()[0]}' for hunk in mine]
        dropped+=[f'{name} {hunk.splitlines()[0]}' for hunk in hunks if hunk not in mine]
        parts.append(f'diff --git a/server/{name} b/server/{name}\n'+header+''.join(mine))
    PATCH.write_text(''.join(parts))
    print(json.dumps({'patch':str(PATCH),'files':len(FILES),'keptHunks':kept,'droppedUnrelatedHunks':dropped},indent=1))

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
      +'# Front-end only; no schema change.\n')

def get(path):
    request=urllib.request.Request('http://127.0.0.1:3000'+path,headers={'User-Agent':'Mozilla/5.0','Cache-Control':'no-cache'})
    with urllib.request.urlopen(request,timeout=20) as response:return response.status,response.read()

def verify():
    prepared=base['ensure_sources']()
    for name,expected in prepared['sourceHashes'].items():
        assert base['docker']('exec',APP,'sha256sum','/app/'+name).split()[0]==expected,name
    assert base['health'](),'Application is not healthy'
    candidate=OUT/'candidate/public';html=(candidate/'operator.html').read_text(encoding='utf-8');checks=[]
    status,body=get('/operator');assert status==200 and TAG.encode() in body and b'/operator-stepper-keypad.js?v=' in body,'/operator'
    checks.append({'path':'/operator','status':status})
    urls=[m[1] for m in re.finditer(r'(?:src|href)="(/(?:operator-stepper-keypad\.js|operator\.js|operator\.css|i18n\.js)\?[^"\s]+)"',html)]
    assert len(urls)==4,urls
    for url in [*urls,'/service-worker.js']:
        status,body=get(url)
        assert status==200 and body==(candidate/url.split('?')[0].lstrip('/')).read_bytes(),url
        checks.append({'path':url,'status':status})
    base['save'](OUT/'live-verification.json',{'healthy':True,'sourceHashesVerified':True,'http':checks})
    print(json.dumps({'liveVerification':'passed','files':len(FILES),'httpChecks':len(checks)}))
base['verify']=verify

if __name__=='__main__':
    {'patch':make_patch,'prepare':scm['prepare'],'validate':validate,'build':split['build'],
     'deploy':deploy,'verify':verify}[sys.argv[1]]()

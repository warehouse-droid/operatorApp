"""Summarize immutable final checks and production recovery evidence."""
import importlib.util
import json
from pathlib import Path
import re
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('checks',HERE/'run.py')
checks=importlib.util.module_from_spec(spec);spec.loader.exec_module(checks)
root=checks.OUT/'final'
def load(path):return json.loads(path.read_text())
def test_result(name):
 text=(root/(name+'.log')).read_text()
 result={key:int(re.findall(r'^# '+key+r' (\d+)$',text,re.M)[-1]) for key in ['tests','pass','fail','skipped']}
 result['failures']=re.findall(r'^not ok \d+ - (.+)$',text,re.M)
 return result
verified=load(root/'verified.json');manifest=load(checks.RELEASE/'manifest.json');coverage=load(root/'changed-coverage.json')
assert verified['sourceHashes']==manifest['sourceHashes']
report={'task':'Special request delivery recovery and remaining-order closure','specApproval':'not obtained (autonomous run)',
 'spec':'test/special-delivery-recovery-20261016.spec.json',
 'sourceHashes':manifest['sourceHashes'],'runtimeFiles':len(manifest['candidateTree']),
 'commands':{'tests':'python3 server/tools/special-delivery-recovery-20261016/run.py final',
  'stage':'python3 server/tools/special-delivery-recovery-20261016/run.py stage',
  'release':'python3 server/tools/special-delivery-recovery-20261016/release.py prepare / apply',
  'liveRecovery':'docker exec -i mbbs-operator-app-app-1 node --input-type=module - --apply < server/tools/special-delivery-recovery-20261016/recover.mjs'},
 'tests':{name:test_result(name) for name in ['suite','browser','http','suite-order']},
 'baselineFailures':{'all-line removal remains local and completed requests stay locked':'Existing confirmed-vs-dispatch_arrangement expectation, reproduced before this task in the removal-fix baseline.',
  'approved PO exposes shared reference form and preserves failed edits':'The previous shared reference form is absent; reproduced on captured production source in closure-red/baseline-browser.log.'},
 'gauntlet':{'checks':verified['checks'],'changedLineCoverage':{'covered':len(coverage['covered']),'uncovered':coverage['uncovered']},
  'changedBranchCoverage':{'covered':sum(sum(n>0 for n in b['hits']) for b in coverage['branches']),'total':sum(len(b['hits']) for b in coverage['branches']),'details':'test-artifacts/special-delivery-recovery-20261016/final/changed-coverage.json'},
  'mutations':load(root/'mutations.json'),'testHashes':verified['testHashes'],'shuffleSeed':verified['shuffleSeed'],
  'versions':json.loads(next(line for line in (root/'versions.log').read_text().splitlines() if line.startswith('{'))),
  'typescript':'Checked REST, fulfillment adapter, closure adapter and fulfillment editor with checkJs, NodeNext and explicit Node types. Larger legacy repository/service scripts have syntax, lint, database and integration checks.',
  'supplyChain':'No dependencies, permissions, environment settings or schema changes. Existing pinned test toolchain reused. Dependency audit skipped because dependency manifests are unchanged.',
  'suiteScope':'Full affected adapter, repository, closure and browser suites; focused authenticated HTTP regressions. Entire unrelated application suite not run.',
  'realExecution':'Production preflight and recovery logs use the deployed modules and normal service journals; only authorized NetSuite closed flags may be written.',
  'red':'Delivery unit, database, browser and HTTP regressions, plus closure adapter and readiness/closure integration, failed on captured production source before their fixes. Additional adversarial/property checks were added during the gauntlet.',
  'issuesResolved':['Type-check command needed the installed Node definitions enabled explicitly.','Coverage needed public helper modules included alongside browser execution.','Added an adversarial regression for inconsistent order identities/status before any close write.'],
  'limits':['Specification was not independently reviewed. Tests cannot eliminate every undiscovered NetSuite workflow or concurrency behavior.','8 of 124 changed branch paths were not exercised; all 97 changed executable lines were exercised.']},
 'behaviorTests':{
  'nativeHeaderDiscount':'delivery header accepts the separate native order discount row without changing commercial data; property: only one matching header discount may be outside the material sublist',
  'preparationUnlock':'delivery preparation failure releases editing and Sales can replace the failed target; property: failed delivery attempts release editing exactly when no remote plan exists',
  'safeDiscard':'discarding an unapplied delivery attempt releases a stale lock without remote calls and preserves history; delivery recovery HTTP keeps Sales authorization, scope, revisions and operation ownership while releasing an unapplied lock',
  'savedPlanRecovery':'saved remote delivery plans cannot be discarded but can be explicitly replaced under the operation lock; replacement pickup after an uncertain remote change must reverify NetSuite and cannot discard failed re-preparation',
  'editableHeader':'failed delivery recovery keeps header editable and saves the edited target explicitly; delivery recovery distinguishes retry from discard and hides discard after a saved remote plan',
  'remainingClosure':'explicit remaining-order closure preserves fulfilled and billed quantities and retries without duplicate writes; remaining-order closure recovers a workflow-locked closed record with unchanged posted quantities',
  'closureConcurrency':'remaining-order closure freezes fulfillment and billing evidence before any writes; property: remaining-order closure refuses any new execution or billing before writing',
  'readiness':'readiness reminder stays informational while SCM closes remaining fulfilled SO and untouched PO lines',
  'legacyInvariants':'Existing financial-adjustment, closure-lock, linked-closure, local-closure, local-removal and lost-acknowledgement suites retained.'},
 'cleanup':load(root/'cleanup.json')}
for name in ['suite','suite-order','browser']:
 assert set(report['tests'][name]['failures']).issubset(report['baselineFailures'])
assert report['tests']['http']['fail']==0
for name in ['deployment-result.json','image-check.json']:
 path=checks.RELEASE/name
 if path.exists():report[name]=load(path)
for name in ['recovery-preflight.log','recovery.log']:
 path=checks.RELEASE/name
 if path.exists():
  records=[]
  for line in path.read_text().splitlines():
   try:records.append(json.loads(line))
   except json.JSONDecodeError:pass
  report[name]=[r for r in records if r.get('event') in ['delivery-preflight','delivery-recovered','posted-history-verification','result']]
checks.save(checks.SERVER/'test/special-delivery-recovery-20261016.evidence.json',report)
print(json.dumps({'tests':report['tests'],'changedLines':report['gauntlet']['changedLineCoverage'],'mutantsKilled':len(report['gauntlet']['mutations']),'cleanup':report['cleanup']}))

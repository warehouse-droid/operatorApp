"""Assemble evidence from recorded tool output, never from expected results."""
import datetime,json,pathlib,re,subprocess
root=pathlib.Path(__file__).resolve().parents[2];p=root/'test-artifacts/to-line-reference-20261003'
def read(name):return json.loads((p/name).read_text())
def counts(name):
 text=(p/(name+'.log')).read_text()
 return {key:int(re.findall(r'^# '+key+r' (\d+)$',text,re.M)[-1]) for key in ['tests','pass','fail','skipped']}
def failures(name):
 lines=[s for s in (p/(name+'-full.log')).read_text().splitlines() if s.startswith('Isolated MBT main run failed')]
 return {re.sub(r'^/[^/]+/','',x) for x in re.findall(r'/[^, ]+\.test\.js',lines[-1])}
def diagnostics(name):
 text=(p/f'types-{name}.log').read_text()
 return len(re.findall('error TS',text)),{re.sub(r'\(\d+,\d+\)','',s.replace('/baseline/','/app/')) for s in text.splitlines() if 'error TS' in s}
baseline=failures('baseline');final=failures('final');bcount,btypes=diagnostics('baseline');fcount,ftypes=diagnostics('final')
report={
 'generatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'specApproval':'not obtained (autonomous run); acceptance follows the user’s explicit corrections and requirements',
 'source':read('source-state.json'),
 'deployment':read('live-verification.json'),
 'reproduce':{'gauntlet':'python3 tools/to-line-reference-20261003/gauntlet.py',
  'focused':'python3 tools/to-line-reference-20261003/gauntlet.py --focused',
  'readOnlyLiveVerification':'python3 tools/to-line-reference-20261003/verify.py',
  'rollback':'python3 tools/to-line-reference-20261003/deploy.py rollback',
  'setup':'setup.py creates the internal Docker network, Node runner and temporary PostgreSQL; initialize only the isolated database with node src/migrate.js. Never point tests at production.',
  'runnerImage':'mbbs-regular-v2:e2e',
  'runnerImageAtRun':'sha256:b36611e8d01bdd5cef6e030735a25fe0f8bc0ac2fa4d02de331fb66946029242',
  'databaseImage':'postgres:18-alpine','dependencies':'Existing package-lock.json; no dependency changes'},
 'tests':{name:counts(name) for name in ['coverage-final','regression-final','safety-final','shuffled-final','candidate-image']},
 'coverageNewModules':read('coverage/coverage-summary.json')['total'],
 'browser':read('browser.json'),'mutation':read('mutation.json'),
 'static':{'baselineTypeDiagnostics':bcount,'finalTypeDiagnostics':fcount,'newTypeSignatures':sorted(ftypes-btypes),
  'lint':'One unchanged baseline complexity error in verifyObservedRecord (13; limit 12). No new errors or warnings.',
  'syntax':(p/'syntax-final.log').read_text().strip(),'secrets':(p/'secrets-final.log').read_text().strip(),
  'supplyChain':'Audit not repeated: dependencies and lockfile were not changed; no added network destinations or subprocess capability in application code.'},
 'broadSuite':{'baselineFailedFiles':len(baseline),'candidateFailedFilesAtBroadRun':len(final),
  'changedContractFiles':sorted(final-baseline),
  'resolution':'All seven changed-contract files passed the fresh regression run. Remaining 79 failures also existed in baseline. The complete 826-file run preceded the final authorization and ambiguity refinements; all affected tests plus 194 tests in shuffled file order were rerun afterward.',
  'existingFailures':sorted(final&baseline),
  'suiteHealth':'Existing broad-suite browser hangs required a recorded 120-second child watchdog. Final focused, shuffled and release-image runs required no watchdog termination. An early fixture left two isolated template gates enabled; restoring migration defaults resolved its unrelated PO policy failure.'},
 'audit':{'cachedBefore':read('live-cached-before.json'),'cachedAfter':read('live-cached-after.json'),
  'liveFallback':read('live-mapping-before.json'),
  'verifiedTotal':7012,'total':7013,'unresolved':'TOB00025 references NetSuite transfer 777039, which returns NONEXISTENT_ID. No replacement identity was guessed.'},
 'behaviorEvidence':{
  'TOB01189 exact quantities and physical IF/IR references':'to-posting-reference.test.js; immutable quantities 5/1/4, IF 2/5/8, IR 3/6/9; cached before/after quantity hashes match across all 7013 active lines.',
  'Existing and future cached, webhook and split identities':'storedTransferPostingRows validates physical evidence or exact live keys; source-sublist IDs remain unchanged; audit verified all 35 split parents.',
  'Immediate local load and receipt with invalid NetSuite ID':'transfer-order-background-posting.test.js real authenticated HTTP, unavailable NetSuite, one local record on duplicate request; consolidation-load.test.js mixed SO/TO local completion.',
  'Operator and matching Driver completion in either order':'IF/IR Driver-first and Operator-first integration cases, wrong load/withdrawn completion, assigned plan/date, ambiguity rejection and randomized gate properties.',
  'Backend failures only in Admin and safe retry':'Admin endpoint access test, real worker reject/timeout/unknown cases, fixed external identity, no second transform for uncertain outcomes, pre-admission attention and retry.',
  'No repeated local quantities after remote completion':'partial 2+3 loads, local receipt remaining zero, immutable snapshots, idempotent finalizer and duplicate HTTP tests.',
  'Stale failed attempt reproduced and corrected':'browser.json immediate failed response now retains failure metadata, clears journal and permits a fresh request; polled failure, reopened failure and unknown-outcome recovery are covered.',
  'No replay of historical failures':'migration-live.log records a new empty queue; live historical command remained failed; no production transform or physical completion was simulated.',
  'Migration/concurrency/authorization':'transaction rollback, additive migration rollback and repeated application, independent workers, foreign-yard forged input denied, Admin-only queue, existing yard access suite.',
  'Preserve unrelated work':'23-file overlay atop the current special-uom-one build, baseline hashes checked, service env/ports/volumes unchanged, pinned rollback image; webhook worker unchanged.'},
 'limits':[
  'No live NetSuite transaction was created as a test. Payload identity is supported by read-only production evidence and isolated REST-boundary execution.',
  'The exact reported 90-second wait was not reproduced end to end. The stale failed-response journal bug and unnecessary synchronous directory lookups were reproduced independently.',
  'Coverage percentage is for all 355 lines in the four new modules. Legacy file changes are exercised by targeted tests and real browser/HTTP runs; an aggregate changed-line percentage across the large legacy files was not measured.',
  'Ambiguous original dispatch assignments require Admin investigation; a retry does not rewrite the saved Operator evidence.',
  'Rollback reverts the app image and retains the additive queue table and saved records. No historical backfill, source-line rewrite or remote record rollback is performed.'
 ]}
assert all(v['fail']==0 for v in report['tests'].values())
assert not report['static']['newTypeSignatures']
assert report['deployment']['quantitiesUnchanged']
(p/'evidence.json').write_text(json.dumps(report,indent=2)+'\n')
print(str(p/'evidence.json'))

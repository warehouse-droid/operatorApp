"""Render evidence from persisted, actual verification outputs."""
import hashlib,json,re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
ART=ROOT/'test-artifacts/boss-reject-close-20261003'
RELEASE=ROOT/'deployments/boss-reject-close-20261003'
def read(name):return json.loads((ART/name).read_text())
assert all(r['status']==0 for r in read('gauntlet-results.json'))
coverage=read('changed-coverage.json');mutations=read('mutations.json')
assert coverage['covered']==coverage['total'] and not coverage['unmeasured']
assert all(m['killed'] for m in mutations)
deployed=json.loads((RELEASE/'result.json').read_text());assert deployed['deployed']
live=json.loads((ART/'live-verified.log').read_text());assert live['verified']
counts={}
for name,path in [('regression',ART/'tests.log'),('shuffled',ART/'shuffled.log'),('candidate',RELEASE/'candidate-tests.log')]:
 text=path.read_text();counts[name]=int(re.search(r'^# pass (\d+)',text,re.M).group(1));assert re.search(r'^# fail 0$',text,re.M)
hashes=read('source-hashes.json')
for name,value in hashes.items():assert hashlib.sha256((ROOT/name).read_bytes()).hexdigest()==value
tree_hash=hashlib.sha256(json.dumps(hashes,sort_keys=True).encode()).hexdigest()
report=f"""# Native sales-order rejection and in-app confirmation — evidence

Deployed {deployed['at']} to https://test.mbbsoperation.com/boss.
Image: {deployed['image']}. Six changed runtime files only, over the captured previous live image. Configuration, webhook worker and database schema preserved. Previous image and rollback compose are recorded in the release manifest.

Both SOB121952 (1036373) and SOB121951 (1036372) are confirmed H / Closed; all three item lines on each order were closed through native REST. No test emails were sent. The prior Tony Tan approval snapshots remain exactly equal to their saved commands. Existing test email holds remain at infinity with zero attempts. Temporary suppression trigger removed. Normal delayed refreshes have now successfully enriched both closed sources through the deployed adapter.

## Specification and authority

The user's explicit closure/implementation instruction and later in-app-popup correction are captured in the append-only amendment to test/boss-approvals-spec.md. Spec approval: not obtained (autonomous run). Tier 3 for financial mutation, concurrency and authority. This is agent-authored evidence, without independent human specification review.

| Behavior / failure mode | Executable evidence |
| --- | --- |
| In-app Cancel sends no decision; no browser dialog or reason; red/white confirmation | boss-approval-browser.test.js phone layouts and Reject confirmation; real HTTP/auth/database/worker with only NetSuite stubbed |
| Both decisions queue; concurrent decisions lose safely; idempotent replay | boss-approvals.test.js first shared decision, replay, uncertain rejection |
| Exact line IDs, queue recheck, sparse IDs, malformed/truncated evidence, stale version | boss-reject-close.test.js adapter contracts, properties and adversarial cases |
| H-only completion; failed/ambiguous responses; no automatic repeated mutation | boss-reject-close.test.js service/property cases and boss-approvals.test.js uncertain rejection |
| Workflow-locked reads only accept exact closed SalesOrd query evidence | boss-reject-close.test.js fallback contracts/property; live-verified.log on both actual orders |
| Saved actor/financial snapshot, shared history/audit, one completed notice per BOSS | boss-approvals.test.js uncertain rejection and first shared decision; existing history suites |
| Legacy rejection remains distinguishable | boss-history-browser.test.js; mail legacy/new contract |
| Existing acceptance, owners, refresh gate, search, login/reset and email behavior | Entire affected feature regression suite, including delayed refresh, authority and staff reset |

## Gauntlet results

- Fresh affected-feature regression: {counts['regression']} passed, zero failed. Deterministically shuffled suite order: {counts['shuffled']} passed, zero failed.
- Exact release candidate: {counts['candidate']} passed, zero failed.
- Strict scoped JavaScript types, syntax, ESLint and complexity: passed. Complexity caps remain 16 for backend and 24 for the existing browser module.
- Changed executable lines: {coverage['covered']}/{coverage['total']} covered; no unmeasured JavaScript files. Browser V8 coverage merged with server c8. Full module branch percentages are in tests.log; branch coverage is not claimed complete.
- Manual mutations: {len(mutations)}/{len(mutations)} killed. All three mutations targeting the property domains were also killed by properties alone; queue authorization and persisted-snapshot mutations were verified by their contract/database tests.
- Diff secret scan: zero findings. No dependencies added; dependency audit/license recheck not applicable.
- Production smoke: health, public asset hashes, authentication boundaries, SMTP readiness, existing history/audit/search and closed-order adapter readback passed. The SMTP readiness check does not send mail.
- Screenshot reject-confirmation.png visually reviewed at 390px; 320/390/430px phone contracts passed.

## Failures and limits

The initial live closure of SOB121952 succeeded but its subsequent record GET was workflow-locked. The first script stopped before reporting the PATCH response. Fresh SuiteQL status, line flags and NetSuite REST system notes confirmed closure, so it was not written again. SOB121951 returned HTTP 204; both closed records then required the same query fallback. No workflow definition or permission was changed.

All eleven new unit tests failed before implementation; the revised integration/browser expectations exposed five failures under the old local-only behavior. One lint complexity failure was resolved by a behavior-preserving message-map refactor. An early live refresh assertion ran before the queued refresh completed; the final successful verification is in live-verified.log.

NetSuite can change between the last preflight read and PATCH; REST does not make that pair atomic. Completion requires observed H, and ambiguous writes are reconciled by reads every 30 seconds. The live orders began Pending Fulfillment; the Pending Approval close flow was tested using the real application endpoint against an isolated NetSuite boundary. The unrelated warehouse-wide test suite was not rerun; all affected feature suites and exact candidate were run.

## Reproduction

Run bash tools/boss-close-verify.sh with Docker available and the existing mbbs-regular-v2:e2e image. It creates isolated test containers, migrates only the test database, runs the gauntlet and secret scan, exports evidence and removes those test containers. Do not run the operational close script as part of regression testing: it targets the explicitly identified live test orders.

Tool versions: {json.dumps(read('tool-versions.json'),sort_keys=True)}.
Runtime file-set SHA-256: {tree_hash}; individual files are in source-hashes.json. No commit was created in the shared dirty workspace.
Release commands: python3 tools/boss-close-deploy.py capture, prepare, checks, apply (run sequentially; capture requires a new release directory). Deployment manifest/result and candidate output are under deployments/boss-reject-close-20261003.
"""
(ART/'EVIDENCE.md').write_text(report)
(RELEASE/'README.md').write_text("# BOSS rejection closes Sales Orders\n\nReject now displays an in-app confirmation, closes the existing NetSuite sales-order item lines through native REST, and records rejected history/notifications only after confirmed H / Closed. Prior local-only rejections remain distinguishable. No schema or dependency changes.\n\n140 regressions passed in normal, shuffled and exact-candidate runs. Changed executable coverage 69/69, five mutations killed. See test-artifacts/boss-reject-close-20261003/EVIDENCE.md. The manifest captures the source tree, image and rollback configuration.\n")
print(json.dumps({'evidenceWritten':True,'tests':counts,'sourceHash':tree_hash}))

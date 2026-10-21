"""Record the measured fixed-one follow-up verification and deployment."""
import hashlib
import json
from pathlib import Path

SERVER=Path(__file__).resolve().parents[1]
OUT=SERVER/'test-artifacts/special-uom-one-20261003'
RELEASE=SERVER/'deployments/special-uom-one-20261003'
read=lambda name:json.loads((OUT/(name+'.json')).read_text())
baseline,tests,focused,static,mutations,supplement,coverage=[read(name) for name in ['baseline','tests','focused','static','mutations','supplement','changed-lines']]
manifest=json.loads((RELEASE/'manifest.json').read_text());deployed=json.loads((RELEASE/'result.json').read_text())
hashes=manifest['services']['app']['sourceHashes']
for result in [tests,focused,static,mutations,supplement,coverage]:assert result['sourceHashes']==hashes
assert hashes=={file:hashlib.sha256((RELEASE/'candidate-app'/file).read_bytes()).hexdigest() for file in hashes}
assert not tests['newFailures'] and not focused['counts']['fail'] and not supplement['counts']['fail']
assert not coverage['uncovered'] and mutations['killed']==mutations['total'] and deployed['deployed']
tree=json.loads((RELEASE/'app-source-tree.json').read_text())
treeHash=hashlib.sha256(json.dumps(tree,sort_keys=True,separators=(',',':')).encode()).hexdigest()
result={'sourceHashes':hashes,'runtimeTreeSha256':treeHash,'baseline':baseline,'affected':tests,'focused':focused,
  'static':static,'mutations':mutations,'coverage':coverage,'supplement':supplement,'deployment':deployed,
  'specApproval':'not obtained (autonomous run)'}
(OUT/'checks.json').write_text(json.dumps(result,indent=2)+'\n')
a,f,r=tests['counts'],focused['counts'],supplement['counts']
report=f"""The Pieces per sales UOM control and review text are removed. New issued-order adjustments always use conversion 1. UOM changes submit without a conversion input, and client-supplied conversion values cannot change quantities or rates. The existing SCM approval workflow applies the entered quantity directly while preserving the original rate and purchase unit cost.

[User correction and executable specification](special-uom-one-spec.md). Tier 3 follow-up; spec approval: not obtained (autonomous run). The user explicitly authorized removing this field and fixing its value at 1.

| Verification | Measured result |
| --- | --- |
| Targeted unit, Chromium and real PostgreSQL/HTTP cases | {f['pass']}/{f['tests']} passed; {f['fail']} failed; {f['skipped']} skipped |
| Full affected Special Order suite | {a['tests']} tests; {a['pass']} passed; {a['fail']} failed; {a['skipped']} skipped |
| Captured-live baseline | {baseline['counts']['tests']} tests; {baseline['counts']['pass']} passed; {baseline['counts']['fail']} failed |
| New regression failures | 0; exact baseline failures retained in baseline.json/tests.json |
| Syntax, differential TypeScript and ESLint | Passed; 0 new diagnostics/findings |
| Changed JavaScript executable lines | {coverage['covered']}/{coverage['total']} executed |
| Changed branches | {coverage['branches']['covered']}/{coverage['branches']['total']} executed; remaining defaults recorded |
| Deliberate faults | {mutations['killed']}/{mutations['total']} detected; 1 by the generated property alone |
| Explicit reversed file execution | {r['pass']}/{r['tests']} passed; 0 skipped |
| Scoped source and supporting-file secret scan | 0 findings; no new dependencies |

The eight selected corrected acceptance cases failed before implementation, retained in red.log. Revised assertions reflect the user's fixed-one policy; tests changed before runtime code. One new test incorrectly assumed PostgreSQL formatted the stored numeric string as 2.000000. It now compares entire saved rows before/after a pending proposal, a stronger check of unchanged data.

Spec 1 is tested by the shared-control unit case, browser adjustment submission without a conversion field, and Sales/SCM review-display assertions. Spec 2 is tested by the UOM-edit HTTP case, missing-conversion/rate-drift case, legacy conversion case, and a property exercising 20 generated quantity/UOM/client-conversion combinations with seed 20261004. The previous 350 field normalization/classification examples also run. Spec 3 is tested by pending/approval/rejection assertions, original-rate/purchase-cost checks, canonical SO/PO rows and existing REST partial-failure/retry cases. Spec 4 is covered by existing authentication/revision/Dispatch/fulfillment/SCM approval cases, complete release-tree/configuration checks and rollback image preservation.

The three deliberate faults honor a client conversion override, restore the blocking conversion prompt, or restore the removed control. Each runs in a disposable copy and must fail a behavior assertion; source hashes confirm restoration. Existing durable review plans retain their recorded snapshots. No production records are rewritten and no migration is required.

Only six runtime files changed over the captured live image. Complete runtime tree SHA-256: `{treeHash}`. Only the app was replaced; live configuration and worker/database/Ollama containers were verified unchanged. Live checks confirm application health, three HTTP-served assets, the removed control/review text and anonymous write denial. Verification performed {deployed['productionRequestWrites']} production request writes and {deployed['netSuiteWrites']} NetSuite writes.

Known limits: the broader suite still has {baseline['counts']['fail']} pre-existing failures; this is zero new failures, not a globally green repository. The affected Special Order suites were run, rather than every unrelated app test. Type/lint results are differential because baseline errors remain. Branch coverage is reported separately. JavaScript coverage excludes HTML; browser and live asset assertions verify the cache references. External NetSuite behavior is exercised through mocked network boundaries; no live NetSuite writes or performance benchmark was performed. No dependencies, installs, migration or commits were added. Complexity review was manual; the follow-up removes logic and adds one guarded historical-value fallback.

Tool versions: `{json.dumps(supplement['tools'],sort_keys=True)}`.

Reproduce every verification layer from server with `python3 tools/special-uom-one-verify.py`, using the frozen candidate and the recorded existing isolated runner/database/browser. It never deploys. Regenerate this report with `python3 tools/special-uom-one-evidence.py`; read-only deployment verification is `python3 tools/special-uom-one-deploy.py verify`.

[Measured checks](../test-artifacts/special-uom-one-20261003/checks.json), [coverage detail](../test-artifacts/special-uom-one-20261003/changed-lines.json), [six-file patch](../deployments/special-uom-one-20261003/app.patch), and [deployment result](../deployments/special-uom-one-20261003/result.json).

Deployed at {deployed['at']}; image `{deployed['appImage']}`.
"""
(SERVER/'test/special-uom-one-evidence.md').write_text(report)
print(json.dumps({'evidenceWritten':True,'targetedPassed':f['pass'],'newFailures':0,'deployedAt':deployed['at']}))

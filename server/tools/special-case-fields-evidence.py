"""Create a report from the final measured checks and verified release."""
import hashlib
import json
from pathlib import Path

SERVER=Path(__file__).resolve().parents[1]
OUT=SERVER/'test-artifacts/special-case-fields-20261003'
RELEASE=SERVER/'deployments/special-case-fields-20261003'
read=lambda name:json.loads((OUT/name).read_text())
baseline,tests,focused,static,mutations,supplement,coverage=[read(name+'.json') for name in
    ['baseline','tests','focused','static','mutations','supplement','changed-lines']]
manifest=json.loads((RELEASE/'manifest.json').read_text())
release=json.loads((RELEASE/'result.json').read_text())
hashes=manifest['services']['app']['sourceHashes']
for result in [tests,focused,static,mutations,supplement,coverage]:assert result['sourceHashes']==hashes
assert hashes=={file:hashlib.sha256((RELEASE/'candidate-app'/file).read_bytes()).hexdigest() for file in hashes}
assert not tests['newFailures'] and focused['counts']['fail']==0 and supplement['counts']['fail']==0
assert not coverage['uncovered'] and mutations['killed']==mutations['total'] and release['deployed']
tree=json.loads((RELEASE/'app-source-tree.json').read_text())
tree_hash=hashlib.sha256(json.dumps(tree,sort_keys=True,separators=(',',':')).encode()).hexdigest()
summary={'sourceHashes':hashes,'runtimeTreeSha256':tree_hash,'baseline':baseline['counts'],'affected':tests['counts'],
  'focused':focused['counts'],'reversed':supplement['counts'],'newFailures':tests['newFailures'],
  'changedLines':coverage,'mutations':mutations,'tools':supplement['tools'],'deployment':release,
  'specApproval':'not obtained (autonomous run)'}
(OUT/'checks.json').write_text(json.dumps(summary,indent=2)+'\n')
a,f,r=tests['counts'],focused['counts'],supplement['counts']
report=f"""Special Order field editing is deployed. Sales case editing includes all New Request line fields. SCM stock checks include product name, colour, size, Detail Spec, quantity, UOM and PLT/LYR/SEC/PCS. Sales can propose the same corrections after SO creation, including discount, required date and line note; SCM approval still precedes order updates. The original selling rate stays fixed after issuance, and a UOM change requires an explicit pieces-per-sales-unit conversion.

[Specification and failure model](special-case-fields-spec.md). Tier 3; spec approval: not obtained (autonomous run). This records tested behavior, with no independent approval of the written specification.

Measured checks on the exact release source:

| Check | Result |
| --- | --- |
| Targeted unit, HTTP/PostgreSQL and Chromium checks | {f['pass']}/{f['tests']} passed; {f['fail']} failed; {f['skipped']} skipped |
| Existing and targeted affected suites | {a['tests']} tests; {a['pass']} passed; {a['fail']} failed; {a['skipped']} skipped |
| Captured live baseline | {baseline['counts']['tests']} tests; {baseline['counts']['pass']} passed; {baseline['counts']['fail']} failed |
| New failures versus baseline | 0; exact existing failures are retained in baseline.json and tests.json |
| Syntax, differential TypeScript and ESLint | Passed; 0 new type errors or lint findings |
| Changed JavaScript executable lines | {coverage['covered']}/{coverage['total']} executed |
| Changed branches | {coverage['branches']['covered']}/{coverage['branches']['total']} executed; remaining branch/default locations recorded |
| Deliberate faults | {mutations['killed']}/{mutations['total']} detected; 3 detected by properties alone |
| Explicit reversed test-file order | {r['pass']}/{r['tests']} passed; 0 skipped |
| Generated properties | 350 examples; seeds 20261003 and 202610031 |
| Scoped source/added-file secret scan | 0 findings; no dependencies changed |

Acceptance criteria and evidence:

| Spec | Executable evidence |
| --- | --- |
| 1: field parity, retained values, phone layout, cancel/conflict/no-op | special-case-fields-browser.test.js and existing special-case-edits-browser.test.js |
| 2: material reset, untouched rows, audit and draft invalidation | Sales all-fields HTTP case; field classification properties; existing case-edits reset/private-audit checks |
| 3: discount/note preserve reviews and purchase costs | Discount/note HTTP case; existing legacy embedded-discount and converted-rate cases |
| 4–5: omitted fields, legacy values, bounded/hostile values and rollback | Field normalization unit cases, 350 property examples and invalid SCM batch rollback |
| 6: authentication, scope, revision, concurrency, order locks and migration | Existing case-edits HTTP authorization, races and SQL failure cases; new migration scope/repeat/rollback case |
| 7: real forms, persistence and quote basis | Chromium phone/desktop cases, real isolated HTTP/PostgreSQL and quote snapshot checks |
| 8–9: SCM corrections, protected sales fields and atomic response | SCM browser batch; SCM database corrections/injection/rollback cases |
| 10: pending/rejected/approved metadata | Issued-review HTTP cases and Sales/SCM pending-review browser checks, including escaped text |
| 11: SO/PO descriptions, packing, conversion and Dispatch rows | Real quantity-service/REST adapter fixtures and canonical SO/PO database assertions |
| 12: drift, partial failure, retries and compatibility | REST correction/retry/drift cases and existing adjustment/recovery suites |

The initial red runs are preserved in red.log, red-orders.log and red-browser.log. Later assertions caught missing saved-order packing and loss of multiline details/notes; those failures are retained. Original browser regression assertions also caught a changed composer layout, missing note history and an incompatible adjustment payload. These were corrected without weakening assertions or increasing timeouts. Added pending-review assertions are verified against a deliberate fault that removes reviewed fields. One coverage-tool format error and one secret-scanner false positive in the runner's environment argument construction were corrected before the final checks.

The six faults drop corrections, skip material review, ignore discounts, omit remote packing, omit service corrections, or hide proposed fields from the review. Each runs in a disposable source copy; hashes confirm restoration. Complexity was reviewed manually: shared field normalization/rendering/persistence helpers avoid repeating field lists and validation in the three workflows. No new runtime network, subprocess, filesystem or credential capability was introduced.

Only the 12 listed runtime/migration files differ from the captured live image. Complete runtime tree SHA-256: `{tree_hash}`. The release records every file hash, preserves the live configuration and worker/database/Ollama containers, and retains the previous image plus trigger definition for rollback. Migration 264 changes the scoped price-protection function and rewrites no request rows. Live verification confirms application health, deployed files, field rendering and anonymous write denial. Verification made {release['productionRequestWrites']} production request writes and {release['netSuiteWrites']} NetSuite writes.

Known limits: the affected Special Order suites were run, rather than every unrelated application test. The {baseline['counts']['fail']} pre-existing failures remain; this is not a globally green repository. Type/lint checks are differential because existing diagnostics remain. Branch coverage is reported, not complete. JavaScript line coverage excludes HTML and PL/pgSQL; browser and migration behavior assertions cover those changes. Browser fixtures mock network responses, while repository/HTTP checks use real isolated PostgreSQL and REST tests mock only the external NetSuite boundary. No live NetSuite modification or production-scale performance benchmark was performed. Dependency/license audit was not repeated because package files are unchanged. No checkpoint commits were made.

Tool versions: `{json.dumps(supplement['tools'],sort_keys=True)}`.

Reproduce all verification from server with `python3 tools/special-case-fields-verify.py`. It uses the frozen candidate, captured baseline, recorded installed tools and existing isolated runner/database; it never publishes. Regenerate this report with `python3 tools/special-case-fields-evidence.py`. Read-only release re-verification is `python3 tools/special-case-fields-deploy.py verify`.

[Machine-readable checks](../test-artifacts/special-case-fields-20261003/checks.json), [coverage detail](../test-artifacts/special-case-fields-20261003/changed-lines.json), [scoped release patch](../deployments/special-case-fields-20261003/app.patch), and [deployment result](../deployments/special-case-fields-20261003/result.json).

Deployed at {release['at']}; image `{release['appImage']}`.
"""
(SERVER/'test/special-case-fields-evidence.md').write_text(report)
print(json.dumps({'evidenceWritten':True,'targetedPassed':f['pass'],'newFailures':0,'deployedAt':release['at']}))

"""Write measured reference-alert evidence after deployment."""
import hashlib
import json
from pathlib import Path

SERVER=Path(__file__).resolve().parents[1]
OUT=SERVER/'test-artifacts/special-po-reference-20261001'
RELEASE=SERVER/'deployments/special-po-reference-20261001'
checks=json.loads((OUT/'checks.json').read_text())
result=json.loads((RELEASE/'result.json').read_text())
manifest=json.loads((RELEASE/'manifest.json').read_text())
live=json.loads((OUT/'live-requests.json').read_text())
assert checks['completed'] and result['deployed'] and live['readOnly'] and live['originalPoReferenceAndNoteUnchanged']
assert checks['sourceHashes']==manifest['sourceHashes']
assert checks['sourceHashes']=={file:hashlib.sha256((RELEASE/'candidate'/file).read_bytes()).hexdigest() for file in checks['sourceHashes']}
assert not checks['newFailures'] and not checks['changedLines']['uncovered']
f,a,c=checks['focused'],checks['affected'],checks['changedLines']
text=f'''Special Request PO references and recipient alerts were deployed at {result['at']}.

Sales displays the native PO number and SCM packing-slip/dispatch reference with a spaced slash, for example POB03976 / SN1401857. Vendor-yard pickup produces an in-app center popup for the submitting Sales user within authorized yards. Delivery or pickup at our yard produces a Dispatch popup. Notices remain pending until acknowledged per user; offline users receive them when they return. An unchanged reference save stays dismissed, while a changed reference or fulfillment method generates a new notice. Alerts derive from canonical committed PO data, covering the special-request mini bar, schedule and general PO ref editor. Closed, completed, cancelled, closure-pending and skipped/synthetic cases are excluded. Reference alerts do not change stock readiness, request stages, commercial values or NetSuite fields.

[Specification and failure model](special-po-reference-spec.md). Tier 3; formal spec approval: {checks['specApproval']}. Deployment is authorized by the existing conversation.

Measured final results:

- Captured-live RED reproduced missing formatting, routing, persistence and browser behavior. The two negative access browser cases also passed on the baseline. Initial RED logs and the final replay are retained in artifacts; a separate RED case reproduced the missed Sales refresh when a PO ref changes.
- Focused tests: {f['pass']}/{f['tests']} passed, {f['fail']} failed, {f['skipped']} skipped. Real HTTP/database checks cover recipient/owner/yard/role/workflow restrictions, combined references, schedule and PO updates, stable acknowledgements, changed-reference/method notices, stale acknowledgement rejection, concurrent duplicate acknowledgement and transaction rollback. Chromium tests cover center popups on desktop/phone, vendor/delivery/our-yard instructions, safe text, an existing dialog, retryable network errors, logout/session races and actual Sales request markup. Three seeded properties generate {checks['propertyRuns']} examples (seeds 2026100151–2026100153).
- Affected suite: {a['pass']}/{a['tests']} passed, {a['fail']} failed, {a['skipped']} skipped. Baseline failures: {len(checks['baselineFailures'])}; new failures: {len(checks['newFailures'])}. [Full checks and tool versions](../test-artifacts/special-po-reference-20261001/checks.json).
- Syntax passed; {checks['newTypeDiagnostics']} new type diagnostics and {checks['newLintFindings']} new lint findings. Existing repository diagnostics are compared by code/message and mapped source position; the baseline is not globally type-clean.
- Changed executable lines: {c['covered']}/{c['total']} covered using merged Node/Chromium coverage and source-hash-verified histogram diffs. Changed branches: {c['branches']['covered']}/{c['branches']['total']}. Every changed executable line is covered.
- {checks['mutantsKilled']} syntactically valid manual mutants were killed, including {checks['propertyMutantsKilled']} by properties alone. Mutations remove the slash, retain whitespace, misroute vendor pickup, hide changed references and allow stale acknowledgements. Focused suites also pass in the recorded shuffled order.
- Live read-only checks verify the exact POB03976 / SN1401857 display, current recipient mapping, protected endpoints and unchanged native PO Note `for SOB121819`. Verification performed {live['requestWrites']} request writes, {live['receiptWrites']} live acknowledgements and {live['netsuiteWrites']} NetSuite writes. The example request's method changed during development; its alert follows its current method rather than a captured assumption.

The initial focused run found an invalid test fixture: a skipped PO was combined with a real PO ID without the required skipped-SO evidence. The fixture was corrected to obey existing constraints without weakening notice exclusion. Static checks found missing type/global annotations; these were corrected. Mutation syntax is checked before execution so parser errors cannot count as killed mutants.

Only {len(checks['sourceHashes'])} runtime files changed over the latest captured deployment. Only this task's workspace delta was applied, preserving the newer damage-photo release and unrelated workspace changes. App configuration and worker/database/Ollama containers remain unchanged. Migration 250 adds only per-user acknowledgement receipts and is safe to retain if the app is rolled back to its parent. No dependencies, commits or new external services were introduced. No performance budget was requested; dependency/license auditing was not repeated because dependencies are unchanged. Browser tests mock network boundaries; HTTP/database tests run against the isolated database and reject outbound requests.

Image: `{result['image']}`. Image ID: `{result['imageId']}`. Full source-tree record SHA-256: `{hashlib.sha256((RELEASE/'source-tree.json').read_bytes()).hexdigest()}`. [Scoped patch](../deployments/special-po-reference-20261001/changes.patch), [deployment result](../deployments/special-po-reference-20261001/result.json), [live checks](../test-artifacts/special-po-reference-20261001/live-requests.json), and [migration](../deployments/special-po-reference-20261001/migration-result.json).

Reproduce without deployment with `python3 tools/special-po-reference-verify.py`. Regenerate this report with `python3 tools/special-po-reference-evidence.py`. Manual mutation definitions are retained in `tools/special-po-reference-check.mjs`.
'''
(SERVER/'test/special-po-reference-evidence.md').write_text(text)
print(json.dumps({'evidenceWritten':True,'focusedPassed':f['pass'],'newFailures':len(checks['newFailures']),'deployedAt':result['at']}))

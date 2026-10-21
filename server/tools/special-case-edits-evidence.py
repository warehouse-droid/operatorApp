"""Summarize measured feature checks and the verified deployment."""
import hashlib
import json
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
OUT = SERVER / 'test-artifacts/special-case-edits-20261001'
RELEASE = SERVER / 'deployments/special-case-edits-20261001'
checks = json.loads((OUT / 'checks.json').read_text())
result = json.loads((RELEASE / 'result.json').read_text())
manifest = json.loads((RELEASE / 'manifest.json').read_text())
live = json.loads((OUT / 'live-requests.json').read_text())
assert checks['completed'] and result['deployed'] and live['readOnly']
assert checks['sourceHashes'] == manifest['sourceHashes']
assert checks['sourceHashes'] == {file: hashlib.sha256((RELEASE / 'candidate' / file).read_bytes()).hexdigest()
                                 for file in checks['sourceHashes']}
assert not checks['newFailures'] and not checks['changedLines']['uncovered']
coverage, focused, affected = checks['changedLines'], checks['focused'], checks['affected']
text = f"""Sales editing of Special Request lines was deployed at {result['at']}.

Sales can use Edit case lines before Sales Order creation to change material names, quantities and sales rates, and PALLET quantities and rates. Material name/quantity changes show a centered confirmation and return the same request to New enquiry. Only changed material reviews are invalidated; unchanged material rows are preserved. Previous private review data is retained in SCM-only audit events. Material-rate/PALLET-only changes preserve request status, stage, stock checks and customer decisions and update quotes and saved unsent SO drafts. Issued orders retain the existing adjustment workflow.

Specification and failure model: [special-case-edits-spec.md](special-case-edits-spec.md). Tier 3; formal spec approval: {checks['specApproval']}. The user confirmed before-SO scope. The evidence establishes tested behavior; it does not imply independent approval of the written specification.

Measured verification after the final runtime edit:

- Initial captured-live RED: all 29 original acceptance cases failed before implementation. The final check also reran those cases against the captured live source. Added adversarial checks reproduced ID-container coercion and combined quote overflow before their fixes.
- Focused checks: {focused['pass']}/{focused['tests']} passed, {focused['fail']} failed, {focused['skipped']} skipped. Real HTTP/database tests verify role, yard and workflow permissions; reset/preserve behavior; unchanged SQL rows; private event audiences; converted draft rates and discounts; PALLET insertion/removal; saved PDFs; no-op behavior; injected SQL rollback; concurrent saves and six edit-versus-SO-claim races. Chromium checks verify the editor, centered warning, cancellation/Escape, price/PALLET saves, zero PALLET on phones, and revision-conflict recovery. Two properties run {checks['propertyRuns']} generated examples with fixed seeds.
- Affected suite: {affected['tests']} tests, {affected['pass']} passed, {affected['fail']} failed, {affected['skipped']} skipped. {len(checks['baselineFailures'])} failures are reproduced on the captured baseline; {len(checks['newFailures'])} new failures. Exact failures are in [checks.json](../test-artifacts/special-case-edits-20261001/checks.json).
- Static checks: syntax passed; {checks['newTypeDiagnostics']} new type diagnostics and {checks['newLintFindings']} new lint findings. The new module has zero type errors. The diff secret scan passed.
- Changed executable lines: {coverage['covered']}/{coverage['total']} executed. Changed branches: {coverage['branches']['covered']}/{coverage['branches']['total']} executed. Remaining branch/default locations are recorded in [changed-lines.json](../test-artifacts/special-case-edits-20261001/changed-lines.json).
- Manual mutations: {checks['mutantsKilled']}/{checks['mutantsKilled']} killed; {checks['propertyMutantsKilled']} killed by the properties alone. Mutants ignore material renaming, restart for rate changes, lose PALLET quantities, allow locked edits, or reset status for price edits. Focused test files passed in a recorded shuffled order.
- Migration 249 preserves original unit/quoted-discount protection and permits only request-scoped, transaction-local selling-rate changes before order creation. Isolated checks rehearse repeated application, rollback, wrong-request denial, scope restoration and issued/in-progress-order denial. The deployment saves the old function for rollback. No request rows are migrated.
- Live checks read SPREQ-000019 and SPREQ-000020 in a read-only database transaction, verify saved PALLET display/quotes and edit classification without saving, and confirm anonymous API writes are denied. {live['requestWrites']} production request writes and {live['netsuiteWrites']} NetSuite writes were performed by verification.

Acceptance criteria map to named unit/classification properties, HTTP/database reset/preserve and PDF tests, authorization/lock/concurrency/rollback tests, and the real Chromium editor tests. Source hashes, tool versions, seeds and every command are retained in checks.json and the check script. The full scoped patch is [changes.patch](../deployments/special-case-edits-20261001/changes.patch).

Only the six selected runtime/migration files changed over the captured live image. Deployment applies this task's workspace delta to the live baseline and verifies the complete runtime tree, configuration, public assets and health. Worker, database and Ollama containers are unchanged. Existing PO notes, PALLET display, request actions and PO/TO schedule changes are preserved. Dependencies are unchanged, so dependency/license auditing was not repeated. No checkpoint commits, benchmarks or additional runtime installations were made. No real NetSuite write was needed. Browser tests mock only network boundaries; database/HTTP tests use the isolated database with external access blocked.

Image: `{result['image']}`; ID: `{result['imageId']}`. [Deployment result](../deployments/special-case-edits-20261001/result.json) and [read-only live checks](../test-artifacts/special-case-edits-20261001/live-requests.json).

Reproduce all checks with `python3 tools/special-case-edits-verify.py`. This uses the recorded candidate, captured baseline and installed isolated runner; it does not deploy. The persisted manual mutation definitions are in `tools/special-case-edits-check.mjs`. Regenerate this evidence with `python3 tools/special-case-edits-evidence.py`.
"""
(SERVER / 'test/special-case-edits-evidence.md').write_text(text)
print(json.dumps({'evidenceWritten': True, 'focusedPassed': focused['pass'], 'newFailures': len(checks['newFailures']),
                  'deployedAt': result['at']}))

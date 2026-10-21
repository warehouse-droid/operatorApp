"""Write measured header-save evidence after verification and deployment."""
import hashlib
import json
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
OUT = SERVER / 'test-artifacts/special-header-note-20261001'
RELEASE = SERVER / 'deployments/special-header-note-20261001'
checks = json.loads((OUT / 'checks.json').read_text())
result = json.loads((RELEASE / 'result.json').read_text())
manifest = json.loads((RELEASE / 'manifest.json').read_text())
live = json.loads((OUT / 'live-requests.json').read_text())
assert checks['completed'] and result['deployed'] and live['readOnly'] and live['originalNoteUnchanged']
assert checks['sourceHashes'] == manifest['sourceHashes']
assert checks['sourceHashes'] == {file: hashlib.sha256((RELEASE / 'candidate' / file).read_bytes()).hexdigest() for file in checks['sourceHashes']}
assert not checks['newFailures'] and not checks['changedLines']['uncovered']
focused, affected, coverage = checks['focused'], checks['affected'], checks['changedLines']
text = f"""Sales Special Request header saving was deployed at {result['at']}.

Before Sales Order creation, the existing delivery header form now includes a directly editable Note and one Save header button. It saves Note and delivery fields together. There is no Edit note button. Note-only changes preserve request status, stage, every material/PALLET commercial value, SCM check, customer decision and unsent order line. Notes retain Chinese text, multiplication symbols and line breaks, appear in quotes and copied request drafts, and display safely in Sales and SCM. Issued-order delivery changes retain their existing sync flow; their request Note stays read-only under the confirmed before-SO scope.

[Specification and failure model](special-header-note-spec.md). Tier 3; spec approval: {checks['specApproval']}. The user confirmed before-SO editing and the shared header save. The written specification did not receive independent approval.

Measured results after the final runtime edit:

- Captured-live RED: 21/21 original acceptance cases failed. A later Chromium parser check reproduced a lost leading blank line before its fix; the final check reproduces all 22 against the captured deployed source.
- Focused tests: {focused['pass']}/{focused['tests']} passed, {focused['fail']} failed and {focused['skipped']} skipped. Real authenticated HTTP/database checks cover combined Note/delivery saves, raw new/reviewed/production status preservation, full row/draft invariants, no-ops and clearing, quote/copy propagation, hostile inputs, role/yard/workflow guards, issued/pending/closed locks, concurrent saves, four SO-claim races and audit-failure rollback. Chromium checks cover the shared form on desktop/phone, Chinese text, clearing/no-op saves, retained error/conflict drafts and explicit reload, editor coordination, and safely escaped readonly Notes. Two properties generated {checks['propertyRuns']} examples with seeds 2026100107 and 2026100108.
- Affected suite: {affected['tests']} tests; {affected['pass']} passed, {affected['fail']} failed and {affected['skipped']} skipped. The {len(checks['baselineFailures'])} failures are reproduced on the captured baseline; {len(checks['newFailures'])} new failures. Exact names and measured tool versions are in [checks.json](../test-artifacts/special-header-note-20261001/checks.json). Unrelated failures were not changed.
- Syntax passed; {checks['newTypeDiagnostics']} new type diagnostics and {checks['newLintFindings']} new lint findings. Differential type checks match diagnostic code/message and mapped source location, retaining existing errors on the SCM template line rather than counting its column movement as new errors. Owned test/check files have zero lint findings. The diff secret scan passed.
- Changed executable lines: {coverage['covered']}/{coverage['total']} executed. Changed branches: {coverage['branches']['covered']}/{coverage['branches']['total']} executed. Remaining branch/default locations are listed in [changed-lines.json](../test-artifacts/special-header-note-20261001/changed-lines.json).
- Manual mutations: {checks['mutantsKilled']}/5 killed. Three text mutants were killed by the properties alone: lost Chinese text, removed line breaks and trimmed whitespace. HTTP/database tests kill issued-order guard bypass and request-status restart. Focused files passed in a recorded shuffled order with seed 2026100143.
- Live checks read SPREQ-000022 and its quote inside read-only transactions, confirm the direct Note field and shared Save header, compare the original Note hash before/after deployment, verify updated public asset versions, and confirm an anonymous header PUT receives 401. Verification performed {live['requestWrites']} production request writes and {live['netsuiteWrites']} NetSuite writes. The case was not edited by the deployment or its checks.

Acceptance map:

| Criteria | Evidence |
|---|---|
| Text preservation, validation and escaping | Named Note unit tests; both properties; desktop/phone and readonly Chromium tests |
| One atomic header save, delivery validation and no-op behavior | Combined header HTTP test; invalid-input/no-op/clear tests; audit-failure rollback |
| Status, price, review and draft preservation | Note-only test across new/reviewed/production cases; exact SQL row comparison |
| Quotes, Copy and visible line breaks | Real quote builder and Copy assertions; escaped readonly browser display; shared CSS and scoped SCM markup |
| Authentication, yard, workflow, order/revision locks | HTTP access/lock tests; concurrent saves and SO claims; read-only live anonymous check |
| Error/draft retention and one shared Save | Five real UI workflow tests and screenshots, plus a Chromium textarea parsing test |

A status-reset mutation initially failed JavaScript parsing because its generated SQL quote was unescaped. The harness now checks every mutant’s syntax before running tests, and the corrected status mutant fails named status-preservation assertions. A later real HTML parser test exposed the consumed initial textarea newline; rendering was fixed and the final suite rerun. A final mixed-editor test also reproduced case-line draft cleanup discarding an unsaved header Note. A client guard now retains both drafts and directs the user to cancel case edits, save the header and reopen the line editor. The final suite includes that regression. The first focused run also exposed two invalid test fixtures: issued IDs lacked their required references, and a skipped PO lacked the required skipped SO. Fixtures were corrected without weakening assertions. Static checks found missing annotations and two test-global lint declarations; these were fixed before the final run. Source hashes, coverage diffs, RED logs, commands, tool versions and mutation definitions are retained in the recorded artifacts.

Only eight selected runtime files changed over the captured deployed image; the task delta preserves unrelated workspace changes and the deployed stylesheet order. Deployment verifies the entire runtime tree, service configuration, public assets, health and unchanged worker/database/Ollama containers. No migrations, dependencies, new network/subprocess capabilities, checkpoints, benchmarks or runtime installations were introduced. Dependency/license auditing was not repeated because dependencies are unchanged. No production business mutation or native NetSuite write was required. Browser tests mock network boundaries; HTTP/database tests run in the existing isolated database with outbound calls blocked.

Image: `{result['image']}`. Image ID: `{result['imageId']}`. Complete source-tree record SHA-256: `{hashlib.sha256((RELEASE / 'source-tree.json').read_bytes()).hexdigest()}`. [Scoped patch](../deployments/special-header-note-20261001/changes.patch), [deployment result](../deployments/special-header-note-20261001/result.json), and [live checks](../test-artifacts/special-header-note-20261001/live-requests.json).

Reproduce the checks with `python3 tools/special-header-note-verify.py`, using the recorded candidate, live baseline and installed isolated runner. This does not deploy. Manual mutation definitions are persisted in `tools/special-header-note-check.mjs`. Regenerate this report with `python3 tools/special-header-note-evidence.py`.
"""
(SERVER / 'test/special-header-note-evidence.md').write_text(text)
print(json.dumps({'evidenceWritten': True, 'focusedPassed': focused['pass'], 'newFailures': len(checks['newFailures']), 'deployedAt': result['at']}))

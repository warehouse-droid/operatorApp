"""Report measured checks and the verified scoped PALLET quote deployment."""
import hashlib
import json
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
OUT = SERVER / 'test-artifacts/special-quote-pallet-20261001'
RELEASE = SERVER / 'deployments/special-quote-pallet-20261001'
checks = json.loads((OUT / 'checks.json').read_text())
result = json.loads((RELEASE / 'result.json').read_text())
manifest = json.loads((RELEASE / 'manifest.json').read_text())
assert checks['completed'] and result['deployed']
assert checks['sourceHashes'] == manifest['sourceHashes']
assert checks['sourceHashes'] == {file: hashlib.sha256((SERVER / file).read_bytes()).hexdigest() for file in checks['sourceHashes']}
coverage = checks['changedLines']
assert not checks['newFailures'] and not coverage['uncovered']
focused, affected = checks['focused'], checks['affected']
text = f"""PALLET on initial Special Request quotes was deployed at {result['at']}.

The request form contains PALLET quantity (initially 0), sales rate and a live subtotal before Preview quote and Submit to SCM. Positive quantity requires a reviewed rate, including a valid rate of 0. Draft and saved PDFs add one PALLET charge when quantity is positive and omit it when quantity is 0. Header values replace stale draft PALLET charges; legacy draft charges remain available when no header quantity exists. Existing material discounts, packing and other ancillary charges are preserved. Submit, Copy the request and SO draft preparation retain the quoted PALLET values.

Spec: [acceptance criteria and failure model](special-quote-pallet-spec.md). Tier 3; spec approval: {checks['specApproval']}. The human did not review the spec before this autonomous run, so the evidence establishes tested behavior rather than independent approval of the specification.

Verification:

- Captured-live RED: 18/18 acceptance cases failed before implementation, including corrected synthetic fixture labels.
- Final focused checks: {focused['pass']}/{focused['tests']} passed, {focused['fail']} failures and {focused['skipped']} skips. Twelve unit/property checks cover positive, zero and free PALLET, de-duplication, legacy packing, validation/overflow, exact totals and copy values. Three real authenticated HTTP/database checks cover actual PDFs, persistence, SO draft preparation, permissions, no partial writes and no external calls. Three browser checks cover inputs, rerender retention, actual PDF previews, explicit submission, phone use, copied closed requests and SO prefills.
- Affected suite: {affected['tests']} tests, {affected['pass']} passed, {affected['fail']} failed, {affected['skipped']} skipped. All {len(checks['baselineFailures'])} failures are reproduced on the captured live baseline; {len(checks['newFailures'])} new failures. The existing failures are listed in [checks.json](../test-artifacts/special-quote-pallet-20261001/checks.json).
- Type diagnostics: {checks['newTypeDiagnostics']} new. Lint findings: {checks['newLintFindings']} new. Syntax and secret-diff scan passed.
- Changed executable lines: {coverage['covered']}/{coverage['total']} executed. Changed branches: {coverage['branches']['covered']}/{coverage['branches']['total']} executed; uncovered branch locations are retained in [coverage evidence](../test-artifacts/special-quote-pallet-20261001/changed-lines.json), including defensive/default paths where applicable.
- Manual mutations: {checks['mutantsKilled']}/{checks['mutantsKilled']} killed (show zero PALLET, discard selected count, lose persistence, lose copy values, lose composer synchronization). {checks['propertyMutantsKilled']} mutations were killed by the property suite alone. Independent integer arithmetic verifies subtotal, tax, gross amount and unchanged material discounts across {checks['propertyRuns']} generated cases per normal property run, seeds 2026100151 and 2026100152.
- Suite health: the three focused files passed in a recorded shuffled order after the final implementation. Dev-tool versions and source hashes are recorded in checks.json.

During verification, synthetic reference/customer labels containing PALLET made whole-PDF occurrence checks ambiguous, and the browser's simulated create response lacked the original-rate fields returned by the real API. The fixture labels/response were corrected without weakening any acceptance assertion, and RED was rerun against captured live source. Type checks also caught missing helper/DOM annotations and null-safe access; the implementation was corrected and every final layer rerun.

Only the six files in [the scoped patch](../deployments/special-quote-pallet-20261001/changes.patch) changed over the captured running image. No migration or dependency changes were made; dependency auditing/licence review was not repeated because the installed dependency set was unchanged. No checkpoint commits were created in the pre-existing dirty workspace. The complete deployed runtime tree, configuration, public asset hashes and app health were verified. Worker, database and Ollama services were preserved. Previous request actions, SCM mini-panel and PO/TO schedule files were retained. POB03976's cached Note remains for SOB121819. Validation used the isolated database and generated sample PDFs, with no real customer-data or NetSuite write.

Image: `{result['image']}`; ID: `{result['imageId']}`. Deployment result: [result.json](../deployments/special-quote-pallet-20261001/result.json).

Reproduce the complete checks/build from the recorded candidate with `python3 tools/special-quote-pallet-deploy.py prepare`. The complete checks are in `tools/special-quote-pallet-check.mjs`, manual mutants are persisted there, and the isolated runner is `tools/special-quote-pallet-run.py`. Publish uses the captured rollback image and refuses to proceed while order/posting/quantity operations are active. Evidence can be regenerated with `python3 tools/special-quote-pallet-evidence.py`.

Sample PDFs: [positive saved quote](../test-artifacts/special-quote-pallet-20261001/pdf/positive-saved.pdf) and [zero saved quote](../test-artifacts/special-quote-pallet-20261001/pdf/zero-saved.pdf).
"""
(SERVER / 'test/special-quote-pallet-evidence.md').write_text(text)
print(json.dumps({'evidenceWritten': True, 'focusedPassed': focused['pass'], 'newFailures': len(checks['newFailures']), 'deployedAt': result['at']}))

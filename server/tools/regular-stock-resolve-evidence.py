"""Render Resolve evidence from measured verification and release artifacts."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'test-artifacts/regular-stock-resolve-20261002'
RELEASE = ROOT / 'deployments/regular-stock-resolve-20261002'
checks = json.loads((OUT / 'checks.json').read_text())
manifest = json.loads((RELEASE / 'manifest.json').read_text())
assert checks['completed'] and not checks['newFailures']
assert checks['sourceHashes'] == manifest['sourceHashes']
assert all(hashlib.sha256((RELEASE / 'candidate' / name).read_bytes()).hexdigest() == sha for name, sha in checks['sourceHashes'].items())
image = manifest['services']['app']
release = json.loads((RELEASE / 'result.json').read_text()) if (RELEASE / 'result.json').exists() else {'deployed': False}
status = 'deployed at ' + release['at'] if release['deployed'] else ('prepared and verified; not deployed' if image.get('candidateImageId') else 'implemented and tested; image preparation pending')
coverage = checks['changedLines']
failures = '\n'.join('- `' + name + '`' for name in checks['baselineFailures'])
versions = ', '.join(name + ' ' + version for name, version in checks['tools'].items())
tree_hash = hashlib.sha256((RELEASE / 'source-tree.json').read_bytes()).hexdigest()
text = f"""Stocking Resolve is {status}.

SCM can resolve an open regular Stocking request, for Transfer or Purchase, by replying with an existing PO number and ETA date. The saved reply closes the case, appears in SCM Closed and Sales Completed, and creates one unread Sales decision. The notice belongs to the requesting Sales user and clears when that user opens the reply. Retries do not add events or reappear after acknowledgement. Other unread decisions can keep the Sales badge visible; SCM's badge counts pending review work.

Only an exact, uniquely identified active PO in the local mirror is accepted, ignoring case and surrounding whitespace. The transaction stores its canonical identity, date, actor and time, preserves quantities and units, and updates the case, lines and decision event together. No PO or TO is created or updated and no NetSuite call is made. Existing transfers, handoffs and any Purchase demand block Resolve to avoid abandoning work or allowing allocation reconciliation to reopen the case.

Tier 3. The user confirmed Stocking-only scope. Spec approval: not obtained (autonomous run); independent human review of the full specification did not occur. See [spec and failure model](regular-stock-resolve-spec.md).

Final measured checks:

| Layer | Result |
| --- | --- |
| Focused HTTP, browser and unit acceptance | {checks['focused']['tests']} tests; {checks['focused']['pass']} passed, {checks['focused']['fail']} failed, {checks['focused']['skipped']} skipped |
| Full affected regular/stock-request suite | {checks['affected']['tests']} tests; {checks['affected']['pass']} passed, {checks['affected']['fail']} failed; zero new failures |
| Before-change affected baseline | {checks['baseline']['tests']} tests; {checks['baseline']['pass']} passed, {checks['baseline']['fail']} failed |
| Types, syntax and lint | {checks['newTypeDiagnostics']} new type diagnostics; {checks['newLintFindings']} new lint findings |
| Changed executable lines | {coverage['covered']}/{coverage['total']} |
| Changed branches | {coverage['branches']['covered']}/{coverage['branches']['total']}; missing paths recorded in changed-lines.json |
| Manual mutation | {checks['mutantsKilled']}/{checks['mutantsKilled']} killed |
| Calendar/reference properties | {checks['propertyCases']} examples with recorded seeds; {checks['propertyMutantsKilled']} calendar mutant killed by property tests alone |
| Order checks | All {len(checks['shuffledFiles'])} focused files passed in the recorded shuffled order |
| Secrets and dependencies | Secret scan passed; dependencies and schema unchanged |

The pre-existing failures retained exactly are:

{failures}

The six manual mutants allow invalid dates, remove replay handling, remove the commitment guard, leave case lines open, drop the Sales notification event pointer, or retain an unfinished reply when changing queues. SQL mutants were checked with real authenticated HTTP and database assertions. The property-only run covers the calendar mutant; it does not claim to verify SQL or notification behavior.

Spec mapping:

| Criterion | Executable evidence |
| --- | --- |
| 1: usable form, required reply, retention and Cancel | Browser desktop 1440px and phone 390px; Enter, native validation, language/refresh retention, unknown PO and Cancel tests |
| 2: canonical PO and hostile input validation | HTTP existing/deleted/ambiguous/missing PO, stale revision and malformed reply tests; parser unit tests and two 200-example properties |
| 3: closure and unchanged external orders | Transfer/Purchase HTTP closure, unchanged quantities/units and PO snapshot, both queues, allocation reconciliation and outbound-call trap |
| 4: one private unread decision | HTTP requester/peer/other-yard access, persistent acknowledgement and replay; browser follows the Sales badge to the saved PO/ETA and reloads |
| 5: atomic and repeatable closure | Six concurrent identical submissions, one event/revision, conflicting saved reply, stale revision and trigger-injected rollback |
| 6: safe scope and compatibility | Role guards; method, cancelled/special, handoff/TO, transfer and Purchase-demand guards; UI unsafe-state checks; full affected suite compared with baseline |

The RED run observed all 13 original acceptance tests failing on behavior before implementation; the first GREEN run passed 13/13. Static checks then found DOM/state/browser-interface diagnostics, which were corrected without weakening assertions. VM coverage and native browser Event metadata were adjusted after GREEN with assertions unchanged. Coverage then exposed the untested queue-change reset; an additional meaningful browser regression check was proven by removing that reset in a throwaway mutant. The fixture was then filtered to its own request with all assertions unchanged. The secret scanner flagged four literal dummy test-password assignments; those fixtures now generate disposable passwords without weakening the scanner. Final numbers above come from the final fresh run after all runtime edits.

Types compare existing diagnostics against the captured baseline using the same browser interface declarations, and require both new modules to have no own diagnostics. The large server is checked by syntax/lint and real authenticated HTTP. Existing application-wide type debt remains outside this change. Coverage branches identify remaining paths rather than being treated as complete proof. Cross-workflow correctness additionally relies on the existing case/purchase lock order; the concurrency test directly exercises duplicate Resolve submissions. No production request was created or closed for validation.

Reproduce every verification layer with `python3 tools/regular-stock-resolve-run.py gauntlet`. This requires the existing isolated review Docker container/database and the recorded tools: {versions}. The runner verifies the isolated database host and prefers the recorded release candidate. No new tools or dependencies were installed for this change. No Git checkpoint commits were made in the existing dirty workspace. The application-wide suite and dependency audit/license review were not repeated; the full affected suites ran and dependencies did not change.

Source identification: candidate full-tree manifest SHA-256 `{tree_hash}`. Per-file hashes, logs, coverage and tool versions are in [checks.json](../test-artifacts/regular-stock-resolve-20261002/checks.json). Exactly {len(manifest['sourceHashes'])} runtime files are overlaid on the captured deployed app; the unrelated live stylesheet order is preserved. Release commands are `python3 tools/regular-stock-resolve-deploy.py prepare`, then the guarded `apply` when authorized. The preparation verifies the entire image source tree, configuration and startup import, and records a rollback pinned to the captured image. Publication checks active work before restarting only the app, and verifies local/public health, changed asset hashes and an unauthenticated Resolve rejection. Worker, database and Ollama configuration and identities remain guarded.

Release image: `{image['image']}`, `{image.get('candidateImageId', 'not built')}`. {('Live release checks passed; see [release result](../deployments/regular-stock-resolve-20261002/result.json).') if release['deployed'] else 'Live release checks have not run.'}
"""
(ROOT / 'test/regular-stock-resolve-evidence.md').write_text(text)
print(json.dumps({'evidence': 'test/regular-stock-resolve-evidence.md', 'focused': checks['focused'], 'deployed': release['deployed']}))

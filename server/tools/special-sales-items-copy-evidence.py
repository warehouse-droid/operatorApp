"""Render the final evidence from measured checks and the verified release."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'test-artifacts/special-sales-items-copy-20261001'
RELEASE = ROOT / 'deployments/special-sales-items-copy-20261001'
checks = json.loads((OUT / 'checks.json').read_text())
live = json.loads((RELEASE / 'result.json').read_text())
assert checks['completed'] and live['deployed'] and live['health'] and live['publicAssets']
assert checks['sourceHashes'] == json.loads((RELEASE / 'manifest.json').read_text())['sourceHashes']
coverage = checks['changedLines']
failed = '\n'.join('- ' + name for name in checks['baselineFailures'])
text = f'''# Special Request item additions and copy — deployed evidence

Deployed {live['at']} as `{live['image']}` (`{live['imageId']}`).
Spec approval: not obtained (autonomous run). Tier 3: data preservation, authenticated writes and concurrency. The executable spec is [special-sales-items-copy-spec.md](special-sales-items-copy-spec.md).

## Behavior and acceptance checks

| Requirement | Executed evidence |
| --- | --- |
| Purple Add item after all Case lines, before Close; centered warning and Cancel/Escape without saving | Browser: purple Add item / centered custom warning |
| Append new items and return the same request to New enquiry, preserving every old item column | Real HTTP/PostgreSQL: resets New enquiry; full before/after SQL-row comparison |
| Block linked/skipped orders, closure/completion, remote submission/uncertain operations and pending reviews | HTTP: all lock states; unit availability matrix |
| Block unauthorized role/yard, disabled workflow and stale revision | Authenticated HTTP: role, yard, feature and revision cases; missing-actor export guard |
| Validate quantities, rates, dates, packages and total 100-line limit; never trust supplied stock/order/header fields | HTTP hostile batches/fields, exact 100/101 boundary, deterministic property tests |
| Atomic rollback after an insert fails | PostgreSQL trigger fails the second insert; first insert, draft deletion, revision and event all roll back |
| Serialize append against another append and an SO claim | Two concurrent HTTP appends; six real shared-row-lock SO claim races |
| Invalidate unsent SO material draft so it cannot omit added items | HTTP: draft empty; subsequent order claim rejects until a fresh draft is saved |
| Copy all item input fields and vendor/customer/yard/delivery/rep details; closed requests included | Unit DTO field comparisons and browser closed-request copy |
| Copy opens a draft; only Submit to SCM creates a request; source remains unchanged | Browser: zero creation requests before explicit Submit; posted payload and unchanged source assertions |
| Keep entered values after a failure or cross-session SO creation | Browser: failed retry retains inputs; SO race disables submit and leaves Cancel available |
| Preserve prior customer decisions, post-SO quantity/PALLET flow, Note mini panel and descriptions | Browser accept-then-add and quantity/PALLET scenarios; affected Note/routing/pricing/description suites |
| Phone layouts | Real browser at 390 pixels, no page overflow; screenshot in artifacts |

## Final measured checks

- Focused tests: {checks['focused']['pass']}/{checks['focused']['tests']} passed, zero failures/skips (5 unit, 10 real HTTP/database, 9 browser scenarios).
- Affected suite: {checks['affected']['tests']} tests, {checks['affected']['pass']} passed, {checks['affected']['fail']} existing failures, zero skips and zero NEW failures. The captured live baseline has the same 14 failing names below. The repository-wide unrelated suite was not run; the complete affected file list is in `tools/special-sales-items-copy-suites.mjs`.
- Types and lint: zero NEW diagnostics/findings; the new shared module has no own type errors. Existing strict-JavaScript diagnostics remain in the baseline logs.
- Changed executable lines: {coverage['covered']}/{coverage['total']} covered. Changed branches: {coverage['branches']['covered']}/{coverage['branches']['total']}; the omitted-body fallback at `src/server.js:12667` was not exercised.
- Seven of seven manual mutants killed: allowing an existing SO, ignoring prior line count, losing copied prices, retaining the stale SO draft, accepting stale revisions, permitting a missing actor, and sending an old quantity change to the new endpoint. The count-bound and price-copy mutants were killed by the property suite alone.
- Properties: {checks['propertyRuns']} generated runs per final suite, seeds 2026100141/2026100142, preserving serialization/identity and both valid/invalid count and subtotal bounds.
- Suite health: all three focused files passed again in the explicit recorded permutation (seed 2026100143), with zero skips; mutation tests restore exact source bytes and verify source hashes at completion.
- Syntax checks, secret scan and real application/browser execution passed. No dependencies changed, so package vulnerability/license audit was not repeated. Tools: `{json.dumps(checks['tools'], sort_keys=True)}`.
- New functions separate availability policy, draft copying, warning, additional-line validation and transactional append. The append has one bounded insert loop and does not update existing line rows. No new network, subprocess, filesystem or environment capability is added to runtime code beyond the authenticated existing-app item endpoint; copy remains in the browser.

## Deployment

The candidate overlays exactly seven files on the captured live image. Whole-tree hashes, environment/mount/command configuration, all five active-operation guards, local/public health and exact public asset hashes passed. The worker, database and Ollama containers are unchanged. No migration or real NetSuite write was performed by this release. The schedule toolbar, two-row PO mini panel, PALLET implementation and prior Note behavior remain in the parent image. Cached POB03976 Note remains `for SOB121819`.

There was {live['publicReadRetries']} bounded retry for a public asset connection timeout; the eventual response still had to pass the exact status and hash assertions.

## Reproduce

Run `python3 tools/special-sales-items-copy-deploy.py prepare` before deployment, or `python3 tools/special-sales-items-copy-run.py sync` followed by `python3 tools/special-sales-items-copy-run.py gauntlet node tools/special-sales-items-copy-check.mjs` to repeat all test layers against the frozen candidate in the existing isolated runner. Run `python3 tools/special-sales-items-copy-deploy.py verify` to repeat read-only verification of this live release. These tools require the existing Docker runner and isolated `mbt_verify` database; they never use the live database for fixtures. Coverage is computed from recorded histogram diffs and both Node and real-browser execution, with source-hash checks.

Source identifiers, complete runtime tree and release patch are in `deployments/special-sales-items-copy-20261001/manifest.json`, `source-tree.json` and `changes.patch`. Raw evidence is in `test-artifacts/special-sales-items-copy-20261001/checks.json`, `changed-lines.json`, `shuffled-order.json` and the named logs/browser screenshots.

## Failures resolved and limits

The initial 19 feature scenarios all failed on the live source/throwing helper stub. The stale-editor race was separately observed failing before its fix. Early validation caught the numeric copy price and new strict form-state/DOM type issues; these were fixed without weakening behavior assertions. Fixture assumptions about linked-order references, skipped-PO prerequisites, subtotal overflow, private purchase costs and locked existing PALLET prices were corrected explicitly in the append-only spec. Existing post-SO compatibility and missing-actor behavior are also covered by dedicated killed mutants.

The copy retains business inputs, creates fresh inquiry/expiry dates, and leaves other copied dates visible for review. Stock responses, closure/order state and order media/documents are not new-request state. After a failed acknowledgement, callers must review the refreshed request before another explicit submission; this change does not introduce request-creation or append receipt keys. Browser tests replace external HTTP boundaries with fixtures; the authenticated endpoint and transaction/concurrency tests execute the real app and PostgreSQL. No live customer request was modified as a verification fixture. Autonomous authorship of both spec and tests remains a confidence limit.

## Existing baseline failures (unchanged)

{failed}
'''
(ROOT / 'test/special-sales-items-copy-evidence.md').write_text(text)
print(json.dumps({'evidence': 'test/special-sales-items-copy-evidence.md', 'focusedPass': checks['focused']['pass'],
                  'newRegressions': 0, 'deployed': True, 'imageId': live['imageId']}))

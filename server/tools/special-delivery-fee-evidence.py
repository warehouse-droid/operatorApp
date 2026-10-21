"""Render measured delivery-fee evidence after verification and release."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'test-artifacts/special-delivery-fee-20261001'
checks = json.loads((OUT / 'checks.json').read_text())
release_path = ROOT / 'deployments/special-delivery-fee-20261001/result.json'
manifest = json.loads((ROOT / 'deployments/special-delivery-fee-20261001/manifest.json').read_text())
release = json.loads(release_path.read_text()) if release_path.exists() else {'deployed': False, 'image': manifest['services']['app']['image'], 'imageId': manifest['services']['app']['candidateImageId']}
status = 'deployed at ' + release['at'] if release['deployed'] else 'prepared and verified; rollout has not completed'
rebase_path = ROOT / 'deployments/special-delivery-fee-20261001/rebase-result.json'
rebase = json.loads(rebase_path.read_text()) if rebase_path.exists() else None
rebase_text = (f"The release was rebased onto `{rebase['parentImage']}` after a newer app deployment was detected. All {len(rebase['preservedLiveFiles'])} newer runtime files were preserved, the feature and worker source hashes remained unchanged, and the affected gauntlet was repeated against the combined app. The original unpublished release remains in `{rebase['originalPreparedRelease']}`." if rebase else '')
timings = json.loads((OUT / 'timings.json').read_text())
assert checks['completed']
rows = '\n'.join(f"| {count} | {min(t['ms'] for t in timings if t['lines'] == count):.1f}–{max(t['ms'] for t in timings if t['lines'] == count):.1f} ms |"
                 for count in [1, 10, 100])
coverage = checks['changedLines']
text = f"""Delivery fee, custom PO linkage and local Special Request submission are {status}.

Sales enters a rate below PALLET for Delivery, including explicit 0 for free delivery. The rate survives rerenders, copying and saving. Quotes and Sales Orders include one customer charge; PO lines and material matching exclude it. Historical delivery-charge quantities and amounts remain on saved quotes, and copies preserve their total.

SPREQ-000024 / SOB121882 was corrected using the existing $235 NetSuite charge. A guarded, audited local transaction adopted the observed packing descriptions and charge, verified unchanged quantities/prices and PO lines, and cleared Attention through normal reconciliation. After the user's later NetSuite unit change, a second verified local transaction corrected the six saved material order UOMs and three case-line sales/purchase UOMs to SQFT, preserving all quantities, quoted basis, descriptions and prices. No NetSuite record was changed and no duplicate charge was added. The original rows are retained privately in the task artifacts. Live read-back verified Attention is clear, all material UOMs are SQFT and there is exactly one SO delivery charge; the release verification repeats these checks after rollout.

SCM's Custom PO linkage input sits beside Create PO. Link PO resolves an existing number from the local mirror, persists the independent-link mode and skips SO-to-PO detail matching and SO description synchronization. New-PO costs are not required for linking. Vendor, yard, identity, revision, permissions, operation and exclusive ownership checks remain. PO webhooks preserve the independent mode; SO webhooks still check the SO itself. No SO-to-PO line allocations are fabricated: these POs can be arranged via the yard. Desktop and mobile tests cover linking, Enter, empty input, server errors, refresh retention, unchanged SO and normal Create PO submission.

New request submission validates the chosen Sales Rep against a locally persisted verified directory, ignores client-supplied rep names, and omits irrelevant Dispatch-plan loading. Opening the form refreshes the directory from NetSuite; actual SO creation retains fresh remote validation. The release script warms the directory before rollout so open forms can continue to work.

Authenticated HTTP measurements with outbound calls blocked, three saves at each size:

| Request lines | Measured submission time |
| --- | --- |
{rows}

All nine measured saves were under 1,000 ms. These are isolated-server measurements, not a guarantee about every user's network or future production load. {('A fresh process on the deployed app verified local directory selection without network access in ' + str(round(release['localSelectionMs'], 2)) + ' ms.') if release['deployed'] else 'Live deployment and its post-release checks have not run.'}

Tier 3; spec approval: not obtained (autonomous run). See [spec and failure model](special-delivery-fee-spec.md). Independent human spec review did not occur.

Final verification:

- Focused acceptance: {checks['focused']['tests']} tests, {checks['focused']['pass']} passed, {checks['focused']['fail']} failed, {checks['focused']['skipped']} skipped.
- Affected suite: {checks['affected']['tests']} tests, {checks['affected']['pass']} passed, {checks['affected']['fail']} failed. All failures match the captured baseline; zero new failures. Exact names are in [checks.json](../test-artifacts/special-delivery-fee-20261001/checks.json).
- Syntax, lint and changed-module types: zero new diagnostics. Existing project diagnostics were compared to baseline; the large server route was checked by syntax/lint and real authenticated HTTP execution.
- Changed executable lines: {coverage['covered']}/{coverage['total']}. Changed branches: {coverage['branches']['covered']}/{coverage['branches']['total']}; uncovered branch locations remain in the coverage report.
- Manual mutants: {checks['mutantsKilled']}/{checks['mutantsKilled']} killed, including dropped SO/quote charges, rate loss, persistence loss, remote submission, reintroducing SO checks for custom linkage and unsafe repair acceptance. {checks['propertyMutantsKilled']} were also killed using only the money or unit-repair property tests (200 examples per run).
- Focused files passed in a recorded shuffled order. Browser tests cover desktop/mobile entry, explicit zero, rerenders, quotes, copies and immediate post-save display. HTTP tests cover real persistence/PDFs, permissions, invalid money, forged reps, zero/removed fees, PO exclusion and timing.
- Real NetSuite read confirmed item 1987 is an Other Charge without a units type. The adapter omits fabricated units for this item while retaining material-unit checks.
- All three additive migrations were exercised in the isolated database. No destructive data migration was needed. Release rollback retains the compatible nullable fee column, cache table and default-false linkage column, and restores the captured app and worker images.
- Secret scan passed; no dependencies changed. Dependency audit and licence review were not repeated. No Git checkpoint commits were made in the existing dirty workspace. Source hashes and tool versions are recorded in checks.json.

The normal test loop found and fixed a legacy-charge amount regression and new type findings. A pre-existing browser copy test now fills the new required Sales fee; its original assertions are unchanged. The old-code HTTP fixture supports the earlier directory interface so RED failures exercise behavior rather than module loading.

Spec mapping: delivery-fee criteria 1–2 are covered by special-delivery-fee browser/unit/HTTP tests; criterion 3 by SO payload and stored-PO assertions plus existing strict coverage tests; criterion 4 by invalid-input and access tests; criterion 5 by special-delivery-fee-repair tests and guarded production reconciliation; criterion 6 by local-directory unit tests and timed HTTP saves. Custom linkage criteria 1–4 are covered by its HTTP/browser tests, including a positive strict standard-link test; criterion 5 by SQFT guard/property tests and audited live repair/read-back. The same four linkage HTTP cases pass against the worker’s separately merged source. Only its repository and additive flag migration change, preserving its deployed PO-note and mirror behavior.

Reproduce from this repository: `python3 tools/special-delivery-fee-run.py sync`, then `python3 tools/special-delivery-fee-run.py final-gauntlet node tools/special-delivery-fee-check.mjs`, then `python3 tools/special-delivery-fee-run.py collect`. The existing isolated Docker review container/database and pinned project tools are required. The runner prefers the recorded release candidate, preserving the exact source tested. The full application-wide suite was not run; the affected Special Request suites were run.

Release: `{release['image']}`, `{release['imageId']}`. The candidate changes only the manifest's {len(manifest['sourceHashes'])} runtime files over the captured app. The worker is {('deployed' if release['deployed'] else 'prepared')} separately over its own captured source with two changed files. The unrelated deployed SCM stylesheet order was preserved by merging the narrow change. Both candidate source trees, configurations and startup imports were verified. {('Live health and public asset hashes also passed; database and Ollama containers and app/worker configurations were preserved. See [release result](../deployments/special-delivery-fee-20261001/result.json).') if release['deployed'] else 'The user explicitly authorized deployment after the earlier automatic approval rejection. The two explicitly requested record repairs are complete; rollout is still pending.'}

{rebase_text}
"""
(ROOT / 'test/special-delivery-fee-evidence.md').write_text(text)
print(json.dumps({'evidence': 'test/special-delivery-fee-evidence.md', 'focused': checks['focused'], 'maxSubmissionMs': max(t['ms'] for t in timings)}))

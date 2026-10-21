"""Render evidence solely from the final recorded checks and deployment."""
import hashlib
import json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
TASK=Path(__file__).resolve().parent
OUT=ROOT/'test-artifacts/backorder-review-flow-20261007'
s=json.loads((OUT/'summary.json').read_text())
for file,value in {**s['manifest'],**s['testManifest']}.items():
    assert hashlib.sha256((ROOT/file).read_bytes()).hexdigest()==value
for file,value in s['toolManifest'].items():
    assert hashlib.sha256((TASK/file).read_bytes()).hexdigest()==value
assert not s['newFailures'] and not s['focused']['fail'] and not s['reversed']['fail']
assert all(row['killed'] for row in s['mutations'])
assert s['changedLines']['total']==s['changedLines']['covered']
release=json.loads((OUT/'deployed.json').read_text())
migration=json.loads((OUT/'live-migration.json').read_text())
assert release['deployed'] and release['health']=='healthy' and migration['dataPreserved'] and migration['SpecialStagesPreserved']
before,after=s['regression']['baseline'],s['regression']['candidate']
report=f'''# Backorder workflow and SCM queue filter evidence

Spec approval: not obtained (autonomous run). Tier 3 for shared workflow/API, concurrency and view migration. The final append-only [SPEC](../../tools/backorder-review-flow-20261007/SPEC.md) records the user's corrections. No new dependencies, lockfile changes, or commits. Runtime source SHA-256 hashes, test hashes, tool hashes and versions are recorded in [summary.json](summary.json).

Final behavior: SCM stock review → every Sales line replied (accepted/rejected) → Confirmed if any accepted, Closed if all rejected → SCM manual PO link → Dispatch Arrangement → actual PO planning → Sales manual SO link → Completed. Unit purchase cost is absent from SCM review; Request information precedes Materials. SCM queue selection is a persistent multi-select dropdown with a deduplicated union and common filters. Sales can attach a NetSuite quotation number at every stage, including Closed and Completed. PO-link notifications include the NetSuite PO number and do not repeat after acknowledgement when Sales changes the quotation. Due SCM ETA reminders remain active at Confirmed and Dispatch Arrangement and stop after SO completion.

| Check | Final result |
|---|---|
| Focused HTTP, browser, unit and property suite | {s['focused']['pass']}/{s['focused']['tests']} passed, {s['focused']['fail']} failed, {s['focused']['skipped']} skipped |
| Explicit reverse file execution | {s['reversed']['pass']}/{s['reversed']['tests']} passed |
| Full affected baseline | {before['pass']}/{before['tests']} passed, {before['fail']} pre-existing failures |
| Full affected candidate | {after['pass']}/{after['tests']} passed, {after['fail']} failures; 0 new |
| Static types | {s['typeComparison']['baseline']} → {s['typeComparison']['candidate']} diagnostics; {s['typeComparison']['newErrors']} new |
| ESLint, Node syntax, added-line whitespace and diff secret scan | Passed with 0 new diagnostics |
| Changed executable JS line coverage | {s['changedLines']['covered']}/{s['changedLines']['total']} |
| Genuine mutation checks | {len(s['mutations'])}/{len(s['mutations'])} killed; {sum(row['propertyKilled'] for row in s['mutations'])} independently killed by applicable properties |
| View migration upgrade, interrupted DDL, rollback and re-upgrade | Passed; raw request/case/material data and Special stages unchanged |
| Production deployment | Image {release['image']}; healthy; config and other services preserved |
| Live migration | {sum(row['rows'] for row in migration['before'].values())} stored rows preserved by exact hashes; Special stages unchanged |

Acceptance mapping: quotation and notification API tests `Backorder NetSuite quotation number is editable throughout every stage without changing workflow or native orders`, `Backorder quotation attachments enforce Sales access, input bounds and atomic revision conflicts`, and `Backorder PO linkage notifies Sales with the PO number once and quotation changes do not repeat it` verify role/scope, invalid input, concurrency, terminal-only capability, raw material preservation and acknowledgement. `Backorder Confirmed and PO-linked cases keep due SCM ETA reminders until SO completion` preserves SCM follow-up. Actual Chromium verifies quotation persistence/error retention and the PO notification's Open request action. Other API tests `Backorder PO linking requires reviewed stock and Sales acceptance for every open material`, `Backorder SO linking requires an assigned non-cancelled PO plan and ignores client planning flags`, `Backorder material changes revoke review and Sales acceptance before SCM can link a PO`, `Backorder Sales replies become Confirmed only after every line replies and PO linkage becomes Dispatch Arrangement`, `Backorder all rejected replies close it and freeze later local edits without changing neighboring requests`, `Backorder SO linkage completes Pickup and Delivery with SQL/detail/queue stage agreement`, and `Combined SCM queues return the union without duplicates and retain common vendor filters`. Actual Chromium checks cover the whole sequence, no cost input, section order, selected-request save race, native preview, multi-select persistence, and existing Stocking Resolve behavior. Concurrent reference requests preserve one-success/one-conflict semantics. Routing, private fields, no generated orders/ancillaries and Special ownership remain covered by the focused and baseline/candidate suites.

Properties: 700 SO gating cases, 700 PO acceptance cases, 150 terminal UI cases, 700 stage-order cases, 500 queue parser cases, plus the existing completion/capability/ancillary and routing properties. Branch observations and exact browser sources are preserved in coverage artifacts. Mutants and first failing tests are in mutations.json; the property-only reruns are separate logs.

Reproduce from repository root: `python3 server/tools/backorder-review-flow-20261007/run.py all`. This uses the standard isolated Compose configuration and recorded existing test image/tool versions. Every test workload is bounded in mbbs-tests.slice. Teardown is registered before startup and removes test containers, volumes and networks, verifies docker ps and ps -a, and checks production health. Logs and evidence remain; no test databases are retained.

Recorded iterations: the original SO-before-PO interpretation was replaced by the user's corrected sequence before deployment. RED runs showed 6 original API/browser failures, then 4 corrected API failures, 1 completion property failure, 2 gating property failures, 2 status failures and both missing queue API/browser behaviors, plus 3 missing quotation/notification API cases and 1 missing quotation browser case, and 1 lost-reminder regression. Older fixtures required the corrected order sequence, unique dispatch-plan dates and notification isolation. The complete shared comparison found one obsolete Stocking customer selector. Its navigation was updated to the new queue checkbox, with every behavioral assertion retained. The full affected file was replayed and its recorded result replaces only that obsolete-selector failure in regressions.json; original logs and explicit replay attribution remain. Runtime hashes were verified unchanged. An initial replay could not overwrite older screenshot artifacts; its output was moved into this task's own folder and the failed log/cleanup evidence was retained. This file is also included in the final focused, coverage and reverse-order runs. Dropdown tests now wait for the completed filter reload; a subsequent unchanged draft assertion exposed an unreachable queue Clear selection button, which was wired into the delegated click handler and included in mutation checks. Sales/SCM quotation snapshots use the same audience and compare raw material rows. An initial full comparison was stopped with teardown after identifying that the new statuses would lose SCM ETA reminders; the real HTTP regression failed before the reminder condition was corrected. These were fixture changes or explicitly stated preservation fixes; behavior assertions were retained or amended explicitly for the user's new rules. Final results above come from the last fresh run after runtime changes.

Limits: baseline failures are retained in regressions.json and their full logs; unrelated failures were not fixed. No new dependency audit was needed because package-lock.json is unchanged. No numeric or parser changes outside the queue selector, and no production performance budget was requested. The report demonstrates the stated criteria; autonomous spec review offers less independent assurance than human-approved acceptance criteria.
'''
(OUT/'EVIDENCE.md').write_text(report)
print(json.dumps({'evidence':str(OUT/'EVIDENCE.md'),'focused':s['focused'],'newRegressionFailures':len(s['newFailures'])}))

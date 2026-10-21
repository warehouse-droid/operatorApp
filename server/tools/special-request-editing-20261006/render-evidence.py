"""Render the evidence report from final check, deployment and disposal records."""
import hashlib
import json
from pathlib import Path

root=Path(__file__).resolve().parents[2]
out=root/'test-artifacts/special-request-editing-20261006'
def read(name): return json.loads((out/name).read_text())
summary=read('summary.json')
view=read('view-summary.json')
deployed=read('deployed.json')
live=read('live-completion.json')
cleanup=read('cleanup-completion.json')
assert not summary['newFailures'] and summary['focused']['fail']==0
assert not view['newFailures']
assert not any(cleanup[key] for key in ['testContainers','taskContainers','taskNetworks','taskVolumes'])
manifest=summary['manifest']
assert all(hashlib.sha256((root/file).read_bytes()).hexdigest()==expected for file,expected in manifest.items())
state=hashlib.sha256(json.dumps(manifest,sort_keys=True,separators=(',',':')).encode()).hexdigest()
(out/'source-state.json').write_text(json.dumps({'scope':'runtime and focused test manifest','sha256':state,'files':manifest},indent=2))
(out/'known-failures.json').write_text(json.dumps(summary['regressionFailures'],indent=2))
def counts(value): return f"{value['tests']} tests; {value['pass']} passed; {value['fail']} failed; {value['skipped']} skipped"
mutations=sum(row['killed'] for row in summary['mutations'])
coverage=summary['changedLines']
report=f"""# Confirmed Notes, zero delivery fees, and long request scrolling

Spec approval: not obtained (autonomous run). The user's requests and desktop
clarification authorized the work; the correlation-breaking human spec review
did not happen. Applied the old-coder workflow at Tier 3 because this touches
money, authenticated writes and revision concurrency. This is evidence for the
scoped criteria, not proof of every possible browser or workflow condition.

The deployed application allows Sales to save the public Note on active
confirmed requests, including linked and planned orders. Only Note and revision
are accepted after the delivery header locks. A zero delivery fee remains saved
and editable, while its summary row, quote charge and new SO charge are omitted.
Unissued legacy zero-fee draft rows are removed before a fresh claim; submitted
drafts retain their original rows for recovery. Long request details use document
scrolling on Sales and SCM; the desktop queue is bounded and sticky. Refresh
restores the document and queue position.

## Acceptance and failure-model mapping

See `test/special-request-editing-20261006-spec.md` for the append-only criteria.

| Criterion / failure mode | Executable evidence |
| --- | --- |
| Confirmed and planned public Note saves; multiline Unicode, clear and no-op; terminal Note stays read-only | `special-confirmed-note.test.js`, `special-header-note-http.test.js`, `special-header-note-browser.test.js` |
| Preserve status, material rows, prices, decisions, drafts and operation state; do not unlock delivery fields | HTTP raw-row snapshots and forged-field rejection; browser checks submit only `remarks` and `expectedRevision` |
| Auth, Sales role, yard, workflow flag, stale revision, one concurrent winner, and audit rollback | Note HTTP negative/concurrency/trigger-failure scenarios; browser failed-save and explicit-reload scenarios |
| Hide zero charge but retain editor value; paid fee remains unitless and undiscounted; keep materials, totals, PO costs and other free ancillary items | `special-delivery-fee.test.js`, fee HTTP/browser tests, header fee and case-editor scenarios |
| Old unissued zero-fee SO can proceed consistently; submitted zero-fee SO recovery does not create or change an order | Legacy claim HTTP scenario and `special-zero-fee-recovery.test.js`; network mutations throw in the recovery fixture |
| Reach last detail controls and return on long desktop pages; preserve position after Refresh; narrow-screen regression coverage | `stock-request-long-scroll-browser.test.js` (12 desktop cases, 3 round trips each), `stock-request-audit-scroll-browser.test.js` (12 cases) |
| Preserve queue nodes, cached selection, unsaved inputs and late-response handling | Existing `stock-request-view-browser.test.js` and `stock-request-view.test.js` |
| Preserve issued NetSuite lines and historical PDFs; preserve prior SPREQ-000030 and SPREQ-000041 recoveries | No remote writes in task tests or live verification; read-only deployed-case verification, with no historical-document rewrite path changed |

## Final verification

Reproduce the scoped gauntlet and stable-view checks from the repository:

```sh
cd /home/ubuntu/apps/operatorApp/server
python3 tools/special-request-editing-20261006/gauntlet.py
```

The final fresh broad comparison completed in `run.py all`. After removing an
unnecessary duplicate focused pass from the runner, `gauntlet.py resume` ran the
remaining coverage, static, mutation and suite-health checks and the existing
stable-view tests. All results below follow the final runtime and test edits;
`audit` reuses only that completed fresh broad comparison. The default entry
point reproduces all stages from scratch.

| Layer | Actual result |
| --- | --- |
| Broad Special unit/property/integration suite plus scrolling and view unit checks against captured deployed baseline | {counts(summary['baseline'])} |
| Same suite against candidate | {counts(summary['regressions'])}; **{len(summary['newFailures'])} new failures** |
| Focused acceptance suite | {counts(summary['focused'])} |
| Repeated focused suite with reversed CLI file arguments | {counts(summary['suiteHealth'])} |
| Existing stable-view browser baseline | {counts(view['baseline'])} |
| Existing stable-view browser candidate | {counts(view['candidate'])}; {len(view['newFailures'])} new failures |
| Types | Passed for `public/special-stock-fulfillment.js` and `public/special-stock-delivery-fee.js` |
| Syntax, lint and formatting rules | All changed JS parses; zero new runtime ESLint messages compared with baseline; focused tests and check script pass with zero warnings |
| Changed executable JS lines | {coverage['covered']}/{coverage['total']} covered using Node c8 and source-matched Chromium coverage |
| Manual mutation | {mutations}/{len(summary['mutations'])} killed; both zero-charge mutants also killed by the property test alone |
| Fee property checks | Fixed seed 2026100181, 200 trials, each checking zero plus a generated positive fee; charge count, quote totals and PO line/matching exclusion |
| Secrets / supply chain | Diff-secret scan passed; no dependencies, schema, credentials, new network capability or commits added |

The broad suite is not wholly green. Its remaining failures also fail on the
captured deployed baseline. Verbatim names are in `known-failures.json`, and
errors are retained in the baseline and candidate logs. Unrelated fixtures and
legacy failures were not weakened or repaired. Whole-repository static typing
and global coverage thresholds were not claimed; types are scoped as above,
while server behavior is checked with syntax/lint and real PostgreSQL integration.
Node can canonicalize file discovery, so reversed CLI arguments are not claimed
as randomized execution. Repeatability and repeated wheel round trips are
covered; arbitrary file-order independence remains a limit.
Complexity review: one small scroll-preservation helper and short guarded paths
inside existing workflow functions; no new endpoint or schema.

## Honest history and limits

The original long nested-detail-pane diagnostic passed all 12 cases, so it did
not reproduce the user's exact freeze. Desktop outer-page wheel tests then
failed all 12 cases with a locked document. The final checks validate document
scrolling, including wheel input over the margin, bottom-control visibility and
Refresh position. Chromium is covered; the user's exact browser/session was
not reproduced.

Note and zero-fee regressions were observed failing before their fixes. Initial
Note HTTP fixtures needed paired order references and unique remote IDs; those
setup errors were corrected before recording behavioral failures. The legacy
claim and service-recovery tests each failed on their respective zero-line
assertions before the final fix. Original assertions are retained under
`baseline-tests`; changes to confirmed-note, zero-fee and scroll expectations
follow the explicit user criteria and visible spec clarifications.

The first gauntlet killed the zero-quote mutant with example tests, but its
property-only run survived because the fixed random seed generated no zero
fees. The property was strengthened to check zero and a positive fee in every
trial. No runtime changes or weakened assertions were needed; the complete
gauntlet was then rerun from a fresh test database. After the broad comparison
finished, the disposable run was stopped and fully removed to eliminate a
duplicate focused pass. Remaining layers resumed on another fresh disposable
database, using the unchanged final runtime/test source. The failed property-mutation
log is preserved under `before-property-strengthening`.

A preliminary broad run was interrupted to cover legacy zero-fee recovery. Its
first teardown detected a short-lived Compose one-off exit race; the runner now
removes exact task-labelled disposable residual IDs before rechecking teardown.
Immediate cleanup verified no residual containers, volumes or networks. The
final execution and final completion cleanup independently verified disposal.
Only test logs and evidence were retained.

## Deployment and live verification

`deploy.py prepare` overlays only the 14 manifest runtime files on the current
production image, checks tested hashes and preserved configuration, and builds
without network. `deploy.py apply` checks active foreground work before replacing
only the app and restores the rollback image on failure. `verify-live.py` reads
current cases and verifies application health and disposal. Production database,
worker and Ollama services are preserved.

Deployed image: `{deployed['image']}`. Health: {deployed['health']}.
Configuration preserved: {deployed['configurationPreserved']}.
Live `{live['confirmedRequestRef']}`: Note editable, `{live['purchaseOrderRef']}`
operation `{live['operationStatus']}`, attention `{live['attention']}`.
Prior `SOB122131` link preserved: `{live['priorSoLinkPreserved']}`.
Live zero-fee requests checked: {', '.join(live['zeroFeeRequestsChecked']) or 'none currently present'}.
Live verification performed {live['applicationWrites']} application writes and
{live['netSuiteWrites']} NetSuite writes.

Source identity: task runtime/test manifest SHA-256 `{state}`; source file hashes
and tool versions are in `summary.json` and `source-state.json`. The workspace
has unrelated uncommitted work; no checkpoint commit was made. Before overlay,
237 recursively identified source/browser dependencies matched the running
release (`source-dependencies.json`). Tool versions: `{json.dumps(summary['toolVersions'],sort_keys=True)}`.

Disposable containers in both running and stopped listings: none. Task database
volumes and networks: none. All four production services running and healthy
where a healthcheck is configured. See `cleanup-completion.json`.
"""
(root/'tools/special-request-editing-20261006/EVIDENCE.md').write_text(report)
print(json.dumps({'evidence':'tools/special-request-editing-20261006/EVIDENCE.md','sourceManifestSha256':state}))

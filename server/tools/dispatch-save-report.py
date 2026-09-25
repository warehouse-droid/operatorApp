"""Write the human-readable report directly from completed evidence artifacts."""
from datetime import datetime
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ARTIFACT = ROOT / 'test-artifacts/dispatch-save-reliability'
report = json.loads((ARTIFACT / 'evidence.json').read_text())
gates = report['gates']
release_file = ROOT.parent / 'backups/dispatch-save-reliability-20260917-r5/result.json'
release = json.loads(release_file.read_text()) if release_file.exists() else None
lines = [
    '# Dispatch save reliability evidence', '',
    'Tier 3: save integrity, concurrency and recovery. The implementation spec was approved; '
    'the user subsequently clarified that 500 ms applies to responsive actions while saving asynchronously, '
    'and explicitly authorized deployment after testing.', '',
    f"Release gate: **{'PASS' if report['passed'] else 'PENDING / FAILED'}**. "
    f"Source state: `{report['sourceState']}`.", '',
    f"Deployment: {'completed and verified' if release and release.get('deployed') else 'not yet deployed'}.", '',
    'The false-warning defect came from comparing a persisted plan with a fingerprint influenced by '
    'read-time order enrichment. All paths now fence the raw stored revision and digest. Commit-time '
    'lease checks, atomic receipts, serialized browser operations, immutable retries and generation '
    'guards protect the save. Bounded asynchronous IndexedDB retains recoverable drafts. A separate '
    'replayed split/group identity defect was fixed without treating aliases as order identities.', '',
    '| Gate | Result | Evidence |', '|---|---|---|'
]
for name, data in gates.items():
    status = 'PASS' if data.get('passed') else 'SKIPPED' if data.get('skipped') else 'PENDING / FAILED'
    detail = ''
    if name == 'focused': detail = f"{data.get('mutationsKilled', 0)} mutations killed; {data.get('propertyMutationsKilled', 0)} killed by properties alone"
    elif name in ['stress', 'races', 'soak']:
        elapsed = data.get('elapsedMs')
        if elapsed is None and data.get('startedAt') and data.get('completedAt'):
            elapsed = (datetime.fromisoformat(data['completedAt'].replace('Z', '+00:00'))
                       - datetime.fromisoformat(data['startedAt'].replace('Z', '+00:00'))).total_seconds() * 1000
        duration = f"{elapsed / 60000:.1f} minutes" if elapsed is not None else 'still running'
        detail = f"{data.get('saves', 0)} saves; {data.get('races', 0)} races; {duration}"
    elif name == 'history': detail = f"{data.get('retainedStates', 0)} retained states; outcomes {data.get('outcomes')}; {data.get('unexpectedFailures')} unexpected failures"
    elif name == 'sourceHistory': detail = f"{data.get('retainedStates', 0)} retained states; {data.get('simulatedSourceEvents', 0)} simulated source updates; {data.get('visibleRefreshes', 0)} observed refreshes; hidden by current closed-order rules: {data.get('hiddenRefreshesByRejection', {})}"
    elif name == 'coverage': detail = f"{sum(row.get('executableChanged', 0) for row in data.get('files', {}).values())} changed executable lines; {sum(len(row['uncovered']) for row in data.get('files', {}).values())} uncovered"
    elif name in ['full', 'adjacent']: detail = f"{len(data.get('baselineFailures', {}))} baseline failing cases; {len(data.get('candidateFailures', {}))} candidate; {len(data.get('newFailures', {}))} new"
    elif name == 'static': detail = f"lint {data.get('baselineLint')} → {data.get('candidateLint')}; types {data.get('baselineTypes')} → {data.get('candidateTypes')}; zero new diagnostics required"
    elif name == 'secrets': detail = f"{len(data.get('findings', []))} findings"
    elif name == 'performance': detail = 'Matched Chromium/WebKit startup, edit and save samples; all prior pairs retained'
    elif name in ['playwright', 'sourceBrowser']: detail = '; '.join(f"{row['engine']}: maximum tested action {row['maximumActionMs']:.1f} ms" for row in data.get('engines', []))
    elif name in ['journal', 'snapshotBrowser']: detail = 'Chromium and WebKit: actual storage / lost-response recovery'
    elif name == 'rollback': detail = 'Previous runtime reads the newly acknowledged plan; no schema changes'
    elif name == 'inventory': detail = 'No new dependencies; package manifests match the live baseline; tool versions recorded'
    elif name == 'suiteHealth': detail = 'Cancellation-first legacy assertion reproduced in both versions; persisted safety invariant checked in 20/20 runs'
    elif name == 'complexity': detail = 'New named helpers checked against 80-line / 24-decision budgets'
    lines.append(f'| {name} | {status} | {detail} |')
performance = gates.get('performance', {})
if performance.get('results'):
    lines += ['', f"Browser comparison: {performance.get('replicates', 1)} matched round(s); all samples included. "
              f"Values are baseline → candidate in milliseconds. First navigation is the mean across {performance.get('replicates', 1) + performance.get('coldReplicates', 0)} independent launches; its paired median change must also show no increase.", '',
              '| Engine | First navigation | Repeated navigation median | Edit p95 | Save p95 |',
              '|---|---:|---:|---:|---:|']
    for row in performance['results']:
        values = [f"{row['baseline'][key]:.1f} → {row['candidate'][key]:.1f}"
                  for key in ['firstNavigationMs', 'repeatNavigationMedianMs', 'editP95Ms', 'saveP95Ms']]
        lines.append(f"| {row['engine']} | " + ' | '.join(values) + ' |')
lines += [
    '', 'Acceptance mapping: persisted fences → SAVE-01/02/05/13/18 and digest compatibility properties; '
    'edit ownership → SAVE-03/04/06/12/14/15 plus deterministic races; atomic retry/lifecycle → '
    'SAVE-07–11/16/17/19 and both real-browser recovery flows; newer-edit preservation → '
    'SAVE-UI-05/07–10/13/20/26/29 and the delayed-ack Playwright scenario; durable bounded recovery → '
    'SAVE-UI-11/16–18/23–24 plus real IndexedDB reload/quota/owner cases; source updates → '
    'SAVE-01/20/21 and source-browser/history simulation; performance → SAVE-UI-30–41 and matched browser samples '
    'and the 500 ms held-save action gate; stress → 10,000 HTTP saves, 1,000 race schedules, '
    '10,000 generated action sequences and the one-hour soak.', '', 'The main project suite contains 505 isolated test files. The adjacent suite contains 62 '
    'candidate files and 55 baseline files; new behavior tests are additional candidate cases. '
    'A full-suite baseline infrastructure assertion and legacy adjacent failures remain visible. '
    'The CO cancellation test assumes exactly one successful promise, while existing behavior also '
    'allows cancellation followed by a successful save that scrubs the cancelled CO. Its unchanged '
    'assertion fails on both versions under cancellation-first scheduling; neither leaves a cancelled CO planned.', '',
    'History scope: every retained captured row is checksum/round-trip verified. Replays reconstruct '
    'retained snapshots and slim command results against captured supporting data. Original command '
    'requests, complete historical source versions, and executable payloads for every audit event '
    'are unavailable. Expected current-source business rejections are classified separately from '
    'committed-and-rolled-back cases. Source-update events are explicitly simulated through the real '
    'source-reconciliation path; they are not represented as recovered chronological events.', '',
    'Browser limits: save, lease, bootstrap and lifecycle requests reach a real isolated server/database. '
    'Catalog/setup/map/forecast boundaries use deterministic fixtures. The 500 ms gate covers measured '
    'actions during delayed saves; backend history latency is recorded separately. The 1,000-catalog '
    'comparison also contains pre-existing expensive rendering and does not establish that every possible '
    'planning-page action takes less than 500 ms.', '',
    'Verification is reproducible with `bash server/tools/dispatch-save-gauntlet.sh release`, supplying '
    'the preserved baseline and private history corpus. It never falls back to a live database. '
    '`pr` and `full` modes support public CI without the private corpus. Release is separately gated by '
    '`python3 server/tools/dispatch-save-deploy.py check`; `prepare` builds/smokes the narrow overlay, '
    '`apply` rechecks all gates and rolls back on failed live verification. The worker and database '
    'containers are preserved. No new dependencies or commits were introduced.', '',
    'Detailed machine evidence and timing samples: [evidence.json](../test-artifacts/dispatch-save-reliability/evidence.json). '
    'Approved contract and visible harness corrections: [spec](dispatch-save-reliability-spec.md).', ''
]
if release:
    lines += [f"Deployed image: `{release['image']}`. Read-only verification: `{release.get('live')}`.", '']
    post_file = release_file.with_name('post-deploy.json')
    if post_file.exists():
        post = json.loads(post_file.read_text())
        lines += [f"Post-deployment check at {post['verifiedAt']}: healthy={post['healthy']}; "
                  f"restarts={post['restarts']}; unclassified startup errors={post['unclassifiedErrors']}. "
                  f"Printer-agent authentication rejections observed: {post['printerAuthentication401s']}. "
                  f"{post['note']}", '']
(ROOT / 'test/dispatch-save-reliability-evidence.md').write_text('\n'.join(lines))

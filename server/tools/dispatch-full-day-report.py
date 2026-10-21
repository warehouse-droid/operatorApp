"""Render the measured Playwright actions; never turn slow actions into passes."""
import csv
import html
import json
import re
from pathlib import Path

root = Path(__file__).resolve().parents[1]
base = root / 'test-artifacts/dispatch-freshness-20261019/results/full-day-replay'
report = json.loads((base / 'latest.json').read_text())
artifact = base / Path(report['artifact']).name
actions = report['actions']
slow = [row for row in actions if row['slow']]
failed = [row for row in actions if row['status'] != 'passed']
consistency = report.get('consistencyChecks', [])
if consistency:
    columns = ['number', 'phase', 'name', 'status', 'backendAcknowledgedMs', 'backendVerifiedMs',
               'editorActionReadyMs', 'editorConsistentByMs', 'observerConsistentByMs', 'slow']
    with (artifact / 'consistency-timings.csv').open('w') as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(consistency)
patterns = {
    'Page load/reload': r'^(Load dispatch|Reload saved|Reopen confirmed)',
    'Search': r'^Search ', 'PO link': r'^Link PO to ', 'PO unlink': r'^Unlink PO ',
    'TO link': r'^Link TO$', 'TO unlink': r'^Unlink TO$', 'TO mode update': r'^Update TO mode$',
    'Split/further split': r'^Confirm split ', 'Group': r'^Confirm group$', 'Ungroup': r'^Ungroup orders$',
    'Unsplit': r'^Unsplit order$', 'CO creation': r'^Create CO$', 'CO cancellation': r'^Cancel CO$',
    'Drag/drop': r'^Drag ', 'Save': r'^Save plan$', 'Confirm plan': r'^Confirm dispatch plan$'
}
summary = []
for category, pattern in patterns.items():
    selected = [row for row in actions if re.search(pattern, row['name'])]
    if selected:
        summary.append({'category': category, 'actions': len(selected),
            'minWaitMs': min(row['waitMs'] for row in selected), 'maxWaitMs': max(row['waitMs'] for row in selected),
            'slowActions': sum(row['slow'] for row in selected),
            'failedActions': sum(row['status'] != 'passed' for row in selected)})
(artifact / 'timing-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
escape = lambda value: html.escape(str(value))
rows = []
for row in actions:
    status = 'FAILED' if row['status'] != 'passed' else 'SLOW' if row['slow'] else 'Within limit'
    rows.append('<tr class="%s">%s</tr>' % (
        'failed' if row['status'] != 'passed' else 'slow' if row['slow'] else 'ok',
        ''.join('<td>%s</td>' % escape(value) for value in [row['number'], row['phase'], row['name'],
            f"{row['waitMs']/1000:.3f}", f"{row['interactionMs']/1000:.3f}", f"{row['elapsedMs']/1000:.3f}", status])))
steps = ''.join(f'<li>{escape(row["name"])} — {escape(row["status"])} '
    f'(<a href="{index:02}.png">screenshot</a>)</li>' for index, row in enumerate(report['steps'], 1))
content = '''<!doctype html><html lang="en"><meta charset="utf-8">
<title>Dispatch full-day Playwright replay</title><style>
body{font:15px system-ui;margin:28px;color:#14212b;max-width:1500px}h1{font-size:26px}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{padding:9px;border:1px solid #c9d2dc;text-align:left}
th{position:sticky;top:0;background:#e9eff5}.slow{background:#fff2cc}.failed{background:#ffdada}
td:nth-child(n+4){white-space:nowrap}p{max-width:1000px;line-height:1.55}button{padding:8px;margin:8px 8px 14px 0}
body.only-slow tr.ok{display:none}a{color:#174ea6}</style>
<h1>Dispatch full-day Playwright replay</h1>'''
content += f'<p>Functional result: <b>{escape(report["status"])}</b>. '
content += f'<b>{len(actions)}</b> recorded actions, <b>{len(slow)}</b> waits over 1.5 seconds, <b>{len(failed)}</b> failed actions.</p>'
content += '<p>A compressed dispatch day, using real mouse and keyboard interactions, two Chromium sessions, the application server and PostgreSQL. Orders are synthetic and the disposable environment is limited to two CPU cores. These measurements do not establish production latency or live NetSuite/Samsara behavior.</p>'
content += f'<p>{escape(report["timingDefinition"])} Typing uses {report["typingDelayMs"]} ms per character. Observer entries measure the additional wait when checked after the editing action; they are not end-to-end propagation times. One sample is recorded per action.</p>'
content += '<p>Reading and decision time are excluded; confirmation dialogs are accepted automatically. Traces retain intermediate failures. A PO unlink with planned pickup stops was rejected by route validation; the completed workflow removes the stops first. A CO source pickup must start after the CO transit load finishes. Requests for retired identities can return 404; disabled Special Stock alerts also return 404 in this isolated fixture.</p>'
content += '<p><a href="action-timings.csv">All action timings (CSV)</a> · <a href="report.json">Full evidence (JSON)</a> · <a href="editor-trace.zip">Editor Playwright trace</a> · <a href="observer-trace.zip">Observer Playwright trace</a></p>'
content += '<table><tr><th>Operation</th><th>Samples</th><th>Wait range (s)</th><th>Slow</th><th>Failed</th></tr>'
for row in summary:
    content += '<tr>%s</tr>' % ''.join('<td>%s</td>' % escape(value) for value in [row['category'], row['actions'],
        f"{row['minWaitMs']/1000:.3f}–{row['maxWaitMs']/1000:.3f}", row['slowActions'], row['failedActions']])
content += '</table><br>'
if consistency:
    passed = sum(row['status'] == 'passed' for row in consistency)
    content += f'<h2>Backend and browser consistency without manual refresh</h2><p><b>{passed}/{len(consistency)}</b> checks passed. '
    content += escape(report['consistencyTimingDefinition']) + '</p>'
    content += '<p>Order comparisons include quantities, PO and TO links, pickup locations, CO references and nested group children. Plan comparisons include revision, digest, status and actual load stops. '
    content += 'The two planned reloads happen later, solely to check persistence; consistency checks finish before either reload. '
    content += f'Manual refresh button clicks: <b>{len(report["refreshAudit"]["manualRefreshClicks"])}</b>. '
    content += '<a href="consistency-timings.csv">Consistency timings (CSV)</a> · <a href="consistency-checks.json">Expected content and check results (JSON)</a>.</p>'
    content += '<table><thead><tr><th>#</th><th>Change</th><th>Backend acknowledgment (s)</th><th>Backend read verified (s)</th><th>Editor matched by (s)</th><th>Observer matched by (s)</th><th>Result</th></tr></thead><tbody>'
    for row in consistency:
        state = 'failed' if row['status'] != 'passed' else 'slow' if row['slow'] else 'ok'
        values = [row['number'], row['name']]
        values += [f'{row[key]/1000:.3f}' if key in row else '—' for key in
                   ['backendAcknowledgedMs', 'backendVerifiedMs', 'editorConsistentByMs', 'observerConsistentByMs']]
        values += ['FAILED' if state == 'failed' else 'SLOW convergence' if state == 'slow' else 'Within limit']
        content += '<tr class="%s">%s</tr>' % (state, ''.join('<td>%s</td>' % escape(value) for value in values))
    content += '</tbody></table><br>'
content += '<details><summary>Workflow stages and screenshots</summary><ol>' + steps + '</ol></details>'
content += '<button onclick="document.body.classList.toggle(\'only-slow\')">Toggle slow/failed actions only</button>'
content += '<table><thead><tr><th>#</th><th>Stage</th><th>Action</th><th>Wait (s)</th><th>Input/click (s)</th><th>Total (s)</th><th>Result</th></tr></thead><tbody>'
content += ''.join(rows) + '</tbody></table></html>'
(artifact / 'action-timings.html').write_text(content)
with (artifact / 'action-timings.csv').open() as handle:
    assert len(list(csv.DictReader(handle))) == len(actions)
print(json.dumps({'functionalStatus': report['status'], 'actions': len(actions), 'slowActions': len(slow),
    'slow': [{'action': row['name'], 'waitMs': row['waitMs']} for row in slow],
    'consistencyChecks': len(consistency), 'consistencyFailures': sum(row['status'] != 'passed' for row in consistency),
    'report': str(artifact / 'action-timings.html')}))

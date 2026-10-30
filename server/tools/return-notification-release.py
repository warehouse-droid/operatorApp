#!/usr/bin/env python3
"""Apply only customer return notification changes over the current app image."""
import json
import re
import difflib
import shutil
import time
import runpy
import sys
from pathlib import Path

release = runpy.run_path(str(Path(__file__).with_name('bin-final-collection-release.py')))
base, scope = release['base'], release['scope']
scope.update(OUT=scope['SERVER'] / 'deployments/return-notifications-20261026',
    FILES=json.loads((scope['SERVER'] / 'tools/return-notification-files.json').read_text()),
    IMAGE='mbbs-operator-app:return-notifications-20261026', ROLLBACK='mbbs-operator-app:return-notifications-rollback-20261026')

def replace_once(text, old, new=''):
    assert text.count(old) == 1, 'Notification patch anchor changed: ' + old[:100]
    return text.replace(old, new, 1)

def workspace_baseline(file, text):
    if file == 'src/server.js':
        text = replace_once(text, "import { mountReturnNotificationRoutes } from './return-notification-router.js';\n")
        text = replace_once(text, '|api[_ -]?key|credential', '|credential')
        text = replace_once(text, 'mountReturnNotificationRoutes(app, { requireOperator, requireOperatorAccess, requireAdmin });\n\n')
    elif file == 'public/operator.js':
        for line in [
          'window.MBBSReturnNotifications?.configure({ request: api, render, escapeHtml });\n',
          '      ${globalThis.MBBSReturnNotifications?.html(records) || ""}\n',
          '    ${globalThis.MBBSReturnNotifications?.html([record]) || ""}\n',
          '    if (button.dataset.action === "return-notification-send") { return window.MBBSReturnNotifications?.send(button.dataset.notificationKey, button.dataset.record); }\n',
          '  if (event.target?.dataset?.returnNotificationRecipient) {\n    window.MBBSReturnNotifications?.input(event.target.dataset.returnNotificationRecipient, event.target.value);\n    return;\n  }\n']:
            text = replace_once(text, line)
    elif file == 'public/operator.css':
        start = text.index('/* Customer confirmation after NetSuite return posting. */')
        end = text.index('.return-customer-notification [role="status"]:empty { display: none; }', start)
        end += len('.return-customer-notification [role="status"]:empty { display: none; }\n')
        text = text[:start] + text[end:]
    elif file == 'public/operator.html':
        text = replace_once(text, '    <script src="/return-notifications.js?v=20261026-v1"></script>\n')
        assert text.count('&returnNotifications=1') == 2
        text = text.replace('&returnNotifications=1', '')
    elif file == 'public/admin.html':
        text = replace_once(text, '&returnNotifications=1')
    elif file == 'public/control.js':
        text = replace_once(text, 'let returnNotificationSettings = {};\n')
        start = text.index('function renderReturnNotificationSettings()')
        end = text.index('function renderReturnAutomationSection()', start)
        text = text[:start] + text[end:]
        text = replace_once(text, '${renderReturnNotificationSettings()}<section', '<section')
        text = replace_once(text, '      loadReturnNotificationSettings(),\n')
        start = text.index('    if (["save-return-notifications", "remove-return-notification-key"].includes(button.dataset.action))')
        end = text.index('    if (button.dataset.action === "refresh-return-automation")', start)
        text = text[:start] + text[end:]
        text = replace_once(text, 'await Promise.all([loadAdminReturnSettings(), loadReturnNotificationSettings()]);', 'await loadAdminReturnSettings();')
    else:
        return None
    return text

def prepare():
    out = scope['OUT']
    capture = out / 'capture.json'
    if capture.exists() and json.loads(capture.read_text()) != {key: base['metadata'](name) for key, name in base['SERVICES'].items()}:
        assert not (out / 'deployment.json').exists(), 'Do not overwrite a completed release record'
        previous = {'capture': json.loads(capture.read_text())}
        for name in ['prepared.json', 'built.json']:
            if (out / name).exists(): previous[name] = json.loads((out / name).read_text())
        base['save'](out / ('superseded-' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '.json'), previous)
        for name in ['live-before', 'candidate', 'workspace-before', 'merge-inputs', 'image-context']:
            shutil.rmtree(out / name, ignore_errors=True)
        for name in ['capture.json', 'prepared.json', 'built.json', 'validation.json']:
            (out / name).unlink(missing_ok=True)
    for file in scope['FILES']:
        before = workspace_baseline(file, (scope['SERVER'] / file).read_text())
        if before is not None:
            target = scope['OUT'] / 'workspace-before' / file
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(before)
    release['prepare']()
    # Test containers run without root; copied image source directories may be 0700.
    for copy in [out / 'live-before', out / 'candidate']:
        for path in [copy, *copy.rglob('*')]:
            if path.is_dir(): path.chmod(0o755)
            elif path.is_file(): path.chmod(0o644)
    # Keep the running app's asset versions and add only the notification include.
    out = scope['OUT']
    file = 'public/operator.html'
    html = (out / 'live-before' / file).read_text()
    html, count = re.subn(r'(    <script src="/operator\.js\?[^"\n]+)("></script>)',
      r'    <script src="/return-notifications.js?v=20261026-v1"></script>\n\1&returnNotifications=1\2', html)
    assert count == 1
    html, count = re.subn(r'(/operator\.css\?[^"\n]+)(")', r'\1&returnNotifications=1\2', html)
    assert count == 1
    (out / 'candidate' / file).write_text(html)
    prepared = json.loads((out / 'prepared.json').read_text())
    prepared['conflicts'] = [name for name in prepared['conflicts'] if name != file]
    prepared['sourceHashes'][file] = base['sha'](out / 'candidate' / file)
    base['save'](out / 'prepared.json', prepared)
    patch = []
    for name in scope['FILES']:
        live = out / 'live-before' / name
        previous = live.read_text() if live.exists() else ''
        patch.extend(difflib.unified_diff(previous.splitlines(True), (out / 'candidate' / name).read_text().splitlines(True),
          fromfile='live/' + name, tofile='candidate/' + name))
    (out / 'release.patch').write_text(''.join(patch))
    print(json.dumps({'prepared': True, 'conflicts': prepared['conflicts'], 'files': len(scope['FILES'])}))

def apply_migration():
    name = '311_return_customer_notifications.sql'
    if base['db']("SELECT filename FROM schema_migrations WHERE filename='" + name + "';"):
        return {'filename': name, 'alreadyApplied': True}
    migration = scope['OUT'] / 'candidate/migrations' / name
    base['db']("BEGIN; SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s';\n" + migration.read_text()
      + "\nINSERT INTO schema_migrations(filename) VALUES ('" + name + "'); COMMIT;")
    return {'filename': name, 'applied': True, 'sha256': base['sha'](migration)}

def verify():
    import subprocess
    prepared = base['ensure_sources']()
    for file, expected in prepared['sourceHashes'].items():
        assert base['docker']('exec', base['APP'], 'sha256sum', '/app/' + file).split()[0] == expected, file
    results = []
    for route, expected in [('/health', 200), ('/operator', 200), ('/admin/return-automation', 200),
      ('/return-notifications.js?v=20261026-v1', 200), ('/api/admin/return-notifications', 401)]:
        status = subprocess.check_output(['curl', '-sS', '--max-time', '15', '-o', '/dev/null', '-w', '%{http_code}',
          'http://127.0.0.1:3000' + route], text=True)
        assert int(status) == expected, route + ': ' + status
        results.append({'path': route, 'status': int(status)})
    assert base['db']("SELECT to_regclass('public.return_customer_notifications');") == 'return_customer_notifications'
    base['save'](scope['OUT'] / 'live-verification.json', {'sourceHashesVerified': True, 'http': results})
    print(json.dumps({'liveVerification': 'passed', 'files': len(prepared['sourceHashes'])}))

def deploy():
    active = base['db']("""SELECT (SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing'))
      + (SELECT count(*) FROM regular_stock_delivery_operations WHERE status IN ('queued','running'))
      + (SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing');""")
    assert active == '0', 'Wait for in-flight app operations before restarting: ' + active
    base['deploy']()

scope['apply_migration'], scope['verify'] = apply_migration, verify
if __name__ == '__main__':
    {'prepare': prepare, 'build': base['build'], 'deploy': deploy, 'verify': verify}[sys.argv[1]]()

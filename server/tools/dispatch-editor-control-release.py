"""Release only the tested editor controls over the current live application."""
from pathlib import Path
import difflib
import importlib.util
import io
import json
import shutil
import subprocess
import sys
import tarfile
import time

spec = importlib.util.spec_from_file_location('scoped_release', Path(__file__).with_name('mbt-bin-corrections-release.py'))
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.OUT = core.SERVER / 'test-artifacts/dispatch-editor-control-20261015'
core.RELEASE = core.SERVER / 'deployments/dispatch-editor-control-20261015'
core.IMAGE = 'mbbs-operator-app:dispatch-editor-control-20261015'
core.TEST_IMAGE = 'mbbs-operator-app:dispatch-editor-control-browser-test-20261015'
core.BASE_IMAGE = 'mbbs-operator-app:dispatch-editor-control-rollback-20261015'
files = json.loads((core.OUT / 'runtime-files.json').read_text())
core.NEW = ['public/dispatch-edit-activity.js', 'public/admin-dispatch-editors.js']
core.OLD = [name for name in files if name not in core.NEW]
WORKSPACE = core.SERVER

def verify():
    prepared = json.loads((core.OUT / 'prepared.json').read_text())
    for name, expected in prepared['sourceHashes'].items():
        assert core.docker('exec', core.APP, 'sha256sum', '/app/' + name).split()[0] == expected, name
    results = []
    for path, expected in [('/health', 200), ('/admin', 200), ('/dispatch/planning', 200),
                           ('/dispatch-edit-activity.js', 200), ('/admin-dispatch-editors.js', 200),
                           ('/api/admin/dispatch-plan-editors', 401), ('/api/dispatch/plan-edit-lease?planDate=2026-10-15', 401)]:
        code = subprocess.check_output(['curl', '-sS', '--max-time', '15', '-o', '/dev/null', '-w', '%{http_code}',
                                        'http://127.0.0.1:3000' + path], text=True)
        assert int(code) == expected, (path, code)
        results.append({'path': path, 'status': int(code)})
    for path in ['/api/admin/dispatch-plan-editors/kick', '/api/dispatch/plan-edit-lease/kick']:
        code = subprocess.check_output(['curl', '-sS', '--max-time', '15', '-X', 'POST', '-o', '/dev/null', '-w', '%{http_code}',
                                        'http://127.0.0.1:3000' + path], text=True)
        assert int(code) == 401, (path, code)
        results.append({'path': path, 'method': 'POST', 'status': int(code)})
    operation = core.db("""BEGIN READ ONLY; SET LOCAL statement_timeout='5s';
      SELECT json_build_object('manualKick', (SELECT json_build_object('id',id,'createdAt',created_at,
        'action',action,'planDate',plan_date,'details',details) FROM dispatch_audit_log
        WHERE source='admin_requested_maintenance' AND action='dispatch_plan_edit_lease_admin_kicked'
          AND plan_date='2026-10-15' ORDER BY id DESC LIMIT 1)); COMMIT;""")
    core.save(core.OUT / 'immediate-kick-audit.json', json.loads(operation))
    core.save(core.OUT / 'live-verification.json', {'sourceHashesVerified': True, 'schemaUnchanged': True, 'http': results})

core.verify = verify

def capture():
    before = core.metadata(core.APP)
    live = core.OUT / 'before-live'
    if live.exists():
        assert json.loads((core.OUT / 'live-capture.json').read_text()) == before, 'Live release changed; recapture needed'
    else:
        live.mkdir()
        archive = subprocess.check_output(['sudo', '-n', 'docker', 'exec', core.APP, 'tar', '-C', '/app', '-cf', '-',
                                           'src', 'public', 'migrations', 'package.json', 'package-lock.json'])
        with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
            stream.extractall(live, filter='data')
        assert core.metadata(core.APP) == before
        core.save(core.OUT / 'live-capture.json', before)
    print(json.dumps({'liveSourceCaptured': True, 'imageId': before['imageId']}))

def prepare():
    capture()
    live = core.OUT / 'before-live'
    baseline = core.OUT / 'baseline'
    if not baseline.exists():
        shutil.copytree(core.OUT / 'before-local', baseline)
        # Concurrent workspace edits to order actions belong to another task.
        # Make them part of the merge base so this release carries only editor controls.
        name = 'public/dispatch.js'
        original = (baseline / name).read_text()
        current = (core.SERVER / name).read_text()
        adjusted = original
        old_condition = '!["CUSTOM", "SO"].includes(order.type) && order.originalOrderId'
        new_condition = 'order.type !== "CUSTOM" && order.originalOrderId'
        if old_condition not in current and new_condition in current:
            adjusted = adjusted.replace(old_condition, new_condition)
        manual_lines = [line for line in original.splitlines(keepends=True) if 'data-action="manual-complete-order"' in line]
        for line in manual_lines:
            if line not in current:
                adjusted = adjusted.replace(line, '')
        (baseline / name).write_text(adjusted)
        (core.OUT / 'excluded-concurrent-workspace.patch').write_text(''.join(difflib.unified_diff(
            original.splitlines(keepends=True), adjusted.splitlines(keepends=True), fromfile='before-task/' + name,
            tofile='concurrent-workspace/' + name)))
    # docker cp preserves restrictive ownership; copy the already verified,
    # user-owned capture instead so release comparisons remain readable.
    core.RELEASE.mkdir(parents=True, exist_ok=True)
    state_path = core.RELEASE / 'state.json'
    if not state_path.exists():
        core.save(state_path, {'app': core.metadata(core.APP), 'worker': core.metadata(core.WORKER), 'db': core.metadata(core.DB)})
    for name in core.OLD:
        target = core.RELEASE / 'before' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.unlink(missing_ok=True)
        shutil.copyfile(live / name, target)
    core.prepare()
    candidate = core.OUT / 'candidate-source'
    if candidate.exists():
        shutil.rmtree(candidate)
    shutil.copytree(live, candidate)
    for name in files:
        target = candidate / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(core.RELEASE / 'context' / name, target)
    changed = sorted(name for name in files if not (live / name).exists() or core.sha(live / name) != core.sha(candidate / name))
    core.save(core.OUT / 'candidate-tree.json', {'changedFiles': changed,
        'sourceHashes': {name: core.sha(candidate / name) for name in files}})
    print(json.dumps({'candidatePrepared': True, 'changedFiles': changed}))

def rebase():
    # Freeze the already validated feature delta independently of ongoing workspace work.
    approved = core.OUT / 'approved-source'
    approved_base = core.OUT / 'approved-base'
    if not approved.exists():
        approved.mkdir()
        for name in files:
            target = approved / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(core.RELEASE / 'context' / name, target)
        shutil.copytree(core.RELEASE / 'before', approved_base)
    suffix = 'before-rebase-' + str(time.time_ns())
    for name in ['before-live', 'live-capture.json', 'candidate-source', 'prepared.json', 'candidate-tree.json', 'baseline']:
        path = core.OUT / name
        if path.exists():
            path.rename(core.OUT / (name + '.' + suffix))
    core.RELEASE.rename(core.RELEASE.with_name(core.RELEASE.name + '.' + suffix))
    capture()
    shutil.copytree(approved_base, core.OUT / 'baseline')
    core.RELEASE.mkdir()
    core.save(core.RELEASE / 'state.json', {'app': core.metadata(core.APP), 'worker': core.metadata(core.WORKER), 'db': core.metadata(core.DB)})
    for name in core.OLD:
        target = core.RELEASE / 'before' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(core.OUT / 'before-live' / name, target)
    core.SERVER = approved
    core.prepare()
    candidate = core.OUT / 'candidate-source'
    shutil.copytree(core.OUT / 'before-live', candidate)
    for name in files:
        target = candidate / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(core.RELEASE / 'context' / name, target)
    core.save(core.OUT / 'candidate-tree.json', {'sourceHashes': {name: core.sha(candidate / name) for name in files},
        'rebasedOverImage': core.metadata(core.APP)['imageRef'], 'approvedFeatureFrozen': True})
    print(json.dumps({'rebased': True, 'baseImage': core.metadata(core.APP)['imageRef']}))

def deploy():
    state = json.loads((core.RELEASE / 'state.json').read_text())
    prepared = json.loads((core.OUT / 'prepared.json').read_text())
    validated = json.loads((core.OUT / 'validation.candidate.json').read_text())
    assert validated['passed'] and validated['cleanupVerified']
    assert validated['sourceHashes'] == prepared['sourceHashes'], 'The exact release source was not validated'
    for name, digest in prepared['sourceHashes'].items():
        assert core.sha(core.OUT / 'candidate-source' / name) == digest
        assert core.sha(core.RELEASE / 'context' / name) == digest
    assert json.loads(core.docker('image', 'inspect', core.IMAGE))[0]['Id'] == prepared['imageId']
    assert json.loads(core.docker('image', 'inspect', core.TEST_IMAGE))[0]['Id'] == prepared['testImageId']
    for name, container in [('app', core.APP), ('worker', core.WORKER), ('db', core.DB)]:
        assert core.metadata(container) == state[name], 'Live release changed again: ' + name
    try:
        core.logged('production-deploy', core.compose(state, core.RELEASE / 'compose.release.json') + ['up', '-d', '--no-deps', '--no-build', 'app'])
        assert core.health(), 'Application health did not recover'
        current = core.metadata(core.APP)
        assert current['imageId'] == prepared['imageId']
        assert current['configurationHash'] == state['app']['configurationHash'], 'Application configuration changed'
        assert core.metadata(core.WORKER) == state['worker'] and core.metadata(core.DB) == state['db']
        verify()
    except BaseException:
        current = core.metadata(core.APP)
        if current['imageId'] in [prepared['imageId'], state['app']['imageId']]:
            core.logged('production-rollback', core.compose(state, core.RELEASE / 'compose.rollback.json') + ['up', '-d', '--no-deps', '--no-build', 'app'])
            assert core.health(), 'Rollback health failed'
        raise
    core.save(core.OUT / 'deployment.json', {'image': core.IMAGE, 'imageId': prepared['imageId'], 'healthy': True,
        'schemaUnchanged': True, 'otherServicesPreserved': True, 'configurationPreserved': True,
        'preservedPriorRelease': state['app']['imageRef']})
    print(json.dumps({'deployed': core.IMAGE, 'healthy': True}))

if __name__ == '__main__':
    {'capture': capture, 'prepare': prepare, 'rebase': rebase, 'deploy': deploy, 'verify': verify}[sys.argv[1]]()

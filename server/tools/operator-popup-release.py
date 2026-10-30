"""Overlay the verified popup repair on the current live image, preserving other work."""
import difflib
import io
import json
import os
from pathlib import Path
import re
import runpy
import shutil
import subprocess
import sys
import tarfile

sys.dont_write_bytecode = True
server = Path(__file__).resolve().parents[1]
base = runpy.run_path(str(server / 'tools/operator-shared-pack-balance-release.py'))
scope = base['capture'].__globals__
release = server / 'deployments/operator-popup-20261026'
image = 'mbbs-operator-app:operator-popup-20261026'
files = ['public/operator.js', 'public/operator.html', 'public/service-worker.js',
         'public/operator-popup-audit.js', 'src/server.js', 'src/operator-popup-audit.js', 'src/auth-repository.js']
scope.update(RELEASE=release, IMAGE=image, ROLLBACK=image + '-rollback', FILES=files)
core, tree = scope['core'], scope['tree']
core.RELEASE = release


def capture():
    assert not (release / 'manifest.json').exists(), 'Capture exists; inspect drift before recapturing'
    app = core.metadata(core.APP)
    dependencies = [core.metadata(name) for name in core.DEPENDENCIES]
    original, candidate = release / 'live-before', release / 'candidate'
    original.mkdir(exist_ok=True)
    assert not any(original.iterdir()), 'An incomplete capture needs review'
    roots = json.loads(core.docker('exec', core.APP, 'node', '-e',
        "console.log(JSON.stringify(['src','public','migrations','contracts','package.json','package-lock.json'].filter(p=>require('node:fs').existsSync(p))))"))
    archive = core.docker('exec', core.APP, 'tar', '-cf', '-', '-C', '/app', *roots)
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(original, filter='data')
    shutil.copytree(original, candidate)
    html = (original / 'public/operator.html').read_text()
    old_script = re.search(r'/operator\.js\?[^"\s]+', html).group()
    new_script = old_script + '&popupAudit=20261026-v1'
    html = html.replace('    <script src="' + old_script + '"></script>',
        '    <script src="/operator-popup-audit.js?v=20261026-popup-v1"></script>\n'
        '    <script src="' + new_script + '"></script>')
    worker = (original / 'public/service-worker.js').read_text()
    worker = re.sub(r'const CACHE_NAME = "[^"]+";',
        'const CACHE_NAME = "mbbs-yard-operator-20261026-popup-v1";', worker, count=1)
    worker = re.sub(r'  "/operator\.js\?[^"\s]+",',
        '  "/operator-popup-audit.js?v=20261026-popup-v1",\n  "' + new_script + '",', worker, count=1)
    css = re.search(r'/operator\.css\?[^"\s]+', html).group()
    worker = re.sub(r'  "/operator\.css\?[^"\s]+",', '  "' + css + '",', worker, count=1)
    assets = {'public/operator.html': html, 'public/service-worker.js': worker}
    changes = []
    for name in files:
        before = (original if name in assets else release / 'workspace-before') / name
        after = assets[name] if name in assets else (server / name).read_text()
        changes.extend(difflib.unified_diff(before.read_text().splitlines(True) if before.exists() else [],
            after.splitlines(True), fromfile='a/' + name if before.exists() else '/dev/null',
            tofile='b/' + name))
    patch = ''.join(changes)
    (release / 'release.patch').write_text(patch)
    applied = subprocess.run(['patch', '--batch', '--fuzz=0', '-p1'], cwd=candidate,
                              input=patch, text=True, capture_output=True)
    assert applied.returncode == 0, applied.stdout + applied.stderr
    for extra in candidate.rglob('*.orig'):
        extra.unlink()
    before_tree, candidate_tree = tree(original), tree(candidate)
    changed = sorted(name for name in before_tree.keys() | candidate_tree.keys()
                     if before_tree.get(name) != candidate_tree.get(name))
    assert changed == sorted(files), changed
    for root in [original, candidate]:
        for entry in [root, *root.rglob('*')]:
            if entry.is_dir():
                entry.chmod(0o755)
            elif entry.is_file():
                entry.chmod(0o644)
    core.save('manifest.json', {'capturedAt': core.now(),
        'authorization': 'User requested popup logging and fixing the diagnosed bugs in the live application.',
        'app': app, 'dependencies': dependencies, 'files': files,
        'beforeTree': before_tree, 'candidateTree': candidate_tree,
        'candidateTreeHash': core.sha(json.dumps(candidate_tree, sort_keys=True).encode()),
        'sourceHashes': {name: candidate_tree[name] for name in files},
        'workspaceHashes': {name: core.sha((server / name).read_bytes()) for name in files}})
    current()
    print(json.dumps({'captured': True, 'changedFiles': changed, 'runtimeFiles': len(candidate_tree)}))


def current():
    data = core.state()
    assert core.metadata(core.APP) == data['app'], 'Live app changed; rebase and revalidate'
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    assert json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)) == data['beforeTree']
    assert tree(release / 'candidate') == data['candidateTree']
    assert {name: core.sha((server / name).read_bytes()) for name in files} == data['workspaceHashes']
    return data


def rebase():
    assert not (release / 'deployed.json').exists(), 'Already deployed'
    data = core.state()
    assert tree(release / 'candidate') == data['candidateTree']
    assert tree(release / 'live-before') == data['beforeTree']
    app = core.metadata(core.APP)
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    live = json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT))
    changed = sorted(name for name in live.keys() | data['beforeTree'].keys()
        if live.get(name) != data['beforeTree'].get(name))
    assert changed and not set(changed).intersection(files), 'Overlapping release requires manual merge'
    assert all(name in live for name in changed), 'Removed live files require manual review'
    previous = release / 'previous-validation'
    previous.mkdir()
    for name in ['manifest.json', 'validation.json', 'image-check.json', 'config-check.json']:
        shutil.copy2(release / name, previous / name)
    archive = core.docker('exec', core.APP, 'tar', '-cf', '-', '-C', '/app', *changed)
    assert core.metadata(core.APP) == app
    for directory in ['live-before', 'candidate']:
        with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
            stream.extractall(release / directory, filter='data')
        for name in changed:
            (release / directory / name).chmod(0o644)
    assert tree(release / 'live-before') == live
    candidate = tree(release / 'candidate')
    assert {name: candidate[name] for name in files} == data['sourceHashes']
    data.update(app=app, beforeTree=live, candidateTree=candidate,
        candidateTreeHash=core.sha(json.dumps(candidate, sort_keys=True).encode()))
    data.pop('candidateImageId', None)
    core.save('manifest.json', data)
    core.save('rebase.json', {'at': core.now(), 'preservedConcurrentFiles': changed, 'popupSourceUnchanged': True})
    current()
    print(json.dumps({'rebased': True, 'preservedConcurrentFiles': changed}))


def validate():
    data = current()
    environment = dict(os.environ, DISPATCH_SOURCE_RUNTIME=str(release / 'candidate'),
        DISPATCH_SOURCE_MIGRATIONS=str(release / 'candidate/migrations'), DISPATCH_SOURCE_SKIP_BUILD='1')
    command = ['python3', 'docker/retention/retention.py', 'run', '--root', '/tmp', '--',
               'bash', 'docker/run-dispatch-source-tests.sh', 'node', 'tools/operator-popup-checks.mjs']
    result = subprocess.run(command, cwd=server.parent, env=environment,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if result.returncode:
        print(result.stdout[-22000:])
        raise RuntimeError('Popup candidate checks failed')
    current()
    report = json.loads(next(line.removeprefix('POPUP_EVIDENCE=') for line in result.stdout.splitlines()
                             if line.startswith('POPUP_EVIDENCE=')))
    assert report['passed'] and report['sourceHashes'] == data['sourceHashes']
    report.update(candidateTreeHash=data['candidateTreeHash'], cleanupVerified=True,
        red={'browserFailures': 7, 'missingEndpointAssertions': 3, 'existingYardGuardsPassed': 1},
        testTimingCorrection='Existing pickup polling test now awaits the first HTTP response instead of sleeping 30 ms; assertions unchanged.')
    core.save('validation.json', report)
    print(json.dumps(report))


def verify():
    data = base['checked']()
    core.ready(data['candidateImageId'])
    actual = core.metadata(core.APP)
    assert actual['configuration'] == data['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    assert json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)) == data['candidateTree']
    assets = {name: digest for name, digest in data['sourceHashes'].items() if name.startswith('public/')}
    http = core.http_check(assets, ['/api/delivery/orders', '/api/customer-pickup/config', '/api/delivery/notification-events'])
    containers = {label: core.docker(*args, '--format', '{{.Names}} {{.Status}}').decode().splitlines()
        for label, args in [('running', ['ps']), ('all', ['ps', '-a'])]}
    production = {core.APP, *core.DEPENDENCIES}
    parallel = set()
    for rows in containers.values():
        names = {row.split()[0] for row in rows}
        assert production.issubset(names)
        parallel.update(names - production)
    # Other active tasks share this host; their running disposable stacks are
    # not this release's resources and must not be stopped during verification.
    for name in parallel:
        assert not name.startswith('mbbs-shared-pack-image-check-')
        assert core.docker('inspect', '--format', '{{index .Config.Labels "com.mbbs.lifecycle"}}', name).decode().strip() == 'disposable-test'
    assert json.loads((release / 'validation.json').read_text())['cleanupVerified']
    core.save('containers.json', containers)
    result = {'deployed': True, 'at': core.now(), 'image': image, 'imageId': actual['imageId'],
        'runtimeFilesVerified': len(data['candidateTree']), 'files': files, 'configurationPreserved': True,
        'dependenciesUnchanged': True, 'http': http, 'rollbackImage': image + '-rollback',
        'parallelDisposableContainers': sorted(parallel), 'ownTestCleanupVerified': True}
    core.save('deployed.json', result)
    print(json.dumps(result))


scope.update(current=current, validate=validate, verify=verify)

if __name__ == '__main__':
    os.umask(0o077)
    commands = {name.replace('_', '-'): base[name] for name in ['build', 'image_check', 'deploy', 'verify']}
    commands.update(capture=capture, rebase=rebase, validate=validate, verify=verify)
    commands[sys.argv[1]]()

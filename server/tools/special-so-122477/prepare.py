"""Preserve live baselines and apply only the SO confirmation patch."""
import difflib
import hashlib
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[3]
STATE = pathlib.Path('/home/ubuntu/operatorapp-deploy-backups/special-so-122477-20261010')
ART = ROOT / 'server/test-artifacts/special-so-122477'
FILES = ['src/special-stock-request-service.js', 'src/special-stock-request-repository.js', 'src/netsuite.js']
spec = importlib.util.spec_from_file_location('deploy_core', ROOT / 'server/tools/operator-to-yard-flow-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
os.umask(0o077)
ART.mkdir(parents=True, exist_ok=True)
mode = sys.argv[1]
if mode == 'replay':
    archived = json.loads((ART / 'manifest.json').read_text())
    archive = ART / 'source-contexts.tar.gz'
    expected = json.loads((ART / 'source-contexts.json').read_text())['sha256']
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == expected
    STATE = ART / 'replay'
    STATE.mkdir(parents=True, exist_ok=True)
    if not (STATE / 'baseline/app').exists():
        with tarfile.open(archive, 'r:gz') as source_archive:
            source_archive.extractall(STATE, filter='data')
    before = {s: {'Image': image} for s, image in archived['baseImages'].items()}
else:
    before = json.loads((STATE / 'before.private.json').read_text())
    assert core.inspect('mbbs-operator-app-app-1')['Image'] == before['app']['Image']
core.STATE = STATE
for service in ['app', 'webhook-worker']:
    base = STATE / 'baseline' / service
    base.mkdir(parents=True, exist_ok=True)
    for name in ['src', 'public', 'contracts', 'migrations', 'package.json', 'package-lock.json']:
        if (base / name).exists():
            continue
        if mode == 'replay':
            assert name == 'contracts', f'Missing archived source: {service}/{name}'
            continue
        if name == 'contracts' and core.run(core.DOCKER + ['exec', before[service]['Id'], 'node', '-e', "console.log(require('fs').existsSync('/app/contracts'))"]).strip() == 'false':
            continue
        subprocess.run(core.DOCKER + ['cp', f"{before[service]['Id']}:/app/{name}", str(base / name)], check=True)
    if mode != 'replay':
        subprocess.run(['sudo', '-n', 'chown', '-R', f'{os.getuid()}:{os.getgid()}', str(base)], check=True)
    target = STATE / ('candidate' if service == 'app' else 'candidate-worker')
    if not target.exists():
        shutil.copytree(base, target)
if mode == 'capture':
    print(json.dumps({'captured': True, 'images': {s: before[s]['Image'] for s in ['app', 'webhook-worker']}}))
    raise SystemExit(0)
changes = {}
patch = ''
for name in FILES:
    original = STATE / 'baseline/app' / name
    current = ROOT / 'server' / name
    shutil.copy2(current, STATE / 'candidate' / name)
    delta = ''.join(difflib.unified_diff(original.read_text().splitlines(True), current.read_text().splitlines(True), fromfile='a/' + name, tofile='b/' + name))
    assert delta, f'Expected scoped patch: {name}'
    changes[name] = {'before': core.digest(original), 'after': core.digest(current)}
    patch += delta
    if name.endswith('special-stock-request-repository.js'):
        worker = STATE / 'baseline/webhook-worker' / name
        # The worker is older: overlay only the shared SO webhook guard, retaining all other worker code.
        def guard(text):
            return text.split('async function reconcileCanonicalOrderLines', 1)[1].split("  if (orderKind === 'purchase_order'", 1)[0]
        old_guard, new_guard = guard(original.read_text()), guard(current.read_text())
        old_worker = worker.read_text()
        assert old_worker.count(old_guard) == 1, 'Worker SO reconciliation guard needs an explicit rebase'
        revised = old_worker.replace(old_guard, new_guard, 1)
        (STATE / 'candidate-worker' / name).write_text(revised)
core.save(ART / 'manifest.json', {'baseImages': {s: before[s]['Image'] for s in ['app', 'webhook-worker']},
                               'changes': changes, 'workerChanges': ['src/special-stock-request-repository.js']})
(ART / 'release.patch').write_text(patch)
print(json.dumps({'prepared': True, 'appFiles': len(changes), 'workerFiles': 1}))

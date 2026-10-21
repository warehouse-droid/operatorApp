"""Capture the latest running image and apply only this task's scoped patches."""
import difflib
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[2]
TASK = Path(__file__).resolve().parent
OUT = SERVER / 'test-artifacts/po-line-identity-20261015'
APP = 'mbbs-operator-app-app-1'
FILES = ['src/dispatch-order-target-repository.js', 'src/dispatch-delivery-group-repository.js',
    'public/dispatch.js', 'public/dispatch.html', 'public/mbt-planning.html']
docker = ['sudo', '-n', 'docker']
baseline = OUT / 'runtime-baseline'
sync = len(sys.argv) > 1 and sys.argv[1] == 'sync'
if len(sys.argv) > 1 and sys.argv[1] == 'refresh':
    previous = json.loads((OUT / 'runtime-capture.json').read_text())
    archive = OUT / ('runtime-baseline-' + previous['imageId'].split(':')[-1][:12])
    assert not archive.exists()
    baseline.rename(archive)
    shutil.copyfile(OUT / 'runtime-capture.json', OUT / ('runtime-capture-' + previous['imageId'].split(':')[-1][:12] + '.json'))
if sync:
    captured = json.loads((OUT / 'runtime-capture.json').read_text())
    before = {'Id': captured['containerId'], 'Image': captured['imageId']}
else:
    assert not baseline.exists(), 'Runtime baseline already captured; retain it for reproducibility'
    baseline.mkdir()
    before = json.loads(subprocess.check_output(docker + ['inspect', APP]))[0]
    for name in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']:
        subprocess.run(docker + ['cp', APP + ':/app/' + name, str(baseline / name)], check=True)
    subprocess.run(['sudo', '-n', 'chown', '-R', f'{os.getuid()}:{os.getgid()}', str(baseline)], check=True)
    assert subprocess.check_output(docker + ['inspect', '--format', '{{.Id}}', APP]).decode().strip() == before['Id']
candidate = OUT / 'candidate'
# Replace only the previous disposable code capture; keep all logs and evidence.
if candidate.exists():
    shutil.rmtree(candidate)
shutil.copytree(baseline, candidate)
patches = []
for name in FILES:
    if name.endswith('.html'):
        old = (candidate / name).read_text()
        new, count = re.subn(r'(/dispatch\.js\?v=)[^"\s]+', r'\g<1>20261015-po-lines-ungroup-v1', old)
        assert count == 1
        (candidate / name).write_text(new)
        continue
    if name == 'public/dispatch.js':
        old = (OUT / 'workspace-before' / name).read_text()
        workspace = (SERVER / name).read_text()
        helper = workspace[workspace.index('async function ungroupOrderWithPoCheck('):
            workspace.index('function ungroupOrder(')]
        new = old.replace('function ungroupOrder(', helper + 'function ungroupOrder(', 1)
        branch_start = new.index('  if (action === "ungroup-order") {')
        branch_end = new.index('  if (action === "unsplit-order") {', branch_start)
        current_start = workspace.index('  if (action === "ungroup-order") {')
        current_end = workspace.index('  if (action === "unsplit-order") {', current_start)
        new = new[:branch_start] + workspace[current_start:current_end] + new[branch_end:]
        for function_name in ['flattenDispatchGroupMembers', 'normalizeOrder', 'effectiveOrderPalletQuantity']:
            pattern = r'^function ' + function_name + r'\([\s\S]*?^}'
            old_function = re.search(pattern, old, re.MULTILINE).group(0)
            new_function = re.search(pattern, workspace, re.MULTILINE).group(0)
            assert new.count(old_function) == 1
            new = new.replace(old_function, new_function, 1)
    elif name == FILES[0]:
        live = (baseline / name).read_bytes()
        record = (OUT / 'record-release.js').read_bytes()
        old = record.decode() if live == record else (OUT / 'baseline' / name).read_text()
    else:
        old = (OUT / 'baseline' / name).read_text()
    if name != 'public/dispatch.js':
        new = (SERVER / name).read_text()
    patch = ''.join(difflib.unified_diff(old.splitlines(True), new.splitlines(True), fromfile='a/' + name, tofile='b/' + name))
    result = subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-d', str(candidate)], input=patch,
        text=True, capture_output=True)
    assert result.returncode == 0, result.stdout + result.stderr
    patches.append(patch)
(OUT / 'production.patch').write_text(''.join(patches))
manifest = {'containerId': before['Id'], 'imageId': before['Image'], 'files': FILES,
    'before': {name: hashlib.sha256((baseline / name).read_bytes()).hexdigest() for name in FILES},
    'after': {name: hashlib.sha256((candidate / name).read_bytes()).hexdigest() for name in FILES}}
(OUT / 'runtime-capture.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'captured': True, 'imageId': before['Image'], 'files': FILES}), flush=True)

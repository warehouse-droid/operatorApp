"""Build the updated Chinese manual with isolated training screenshots."""
import hashlib
import io
import json
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/stock-requests/2026-09-30'
ART = ROOT / 'test-artifacts/stock-request-manual-20260930'
OUT.mkdir(parents=True, exist_ok=True)
ART.mkdir(parents=True, exist_ok=True)


def docker(*args):
    return subprocess.check_output(['sudo', '-n', 'docker', *args])


def browser(script, arguments, mounts, log_name):
    command = ['sudo', '-n', 'docker', 'run', '--rm', '--network', 'none', '--read-only',
               '--tmpfs', '/tmp:uid=1000,gid=1000,mode=1777', '--ipc=host',
               '-v', str(ROOT / script) + ':/app/run.mjs:ro', '-v', str(OUT) + ':/app/manual-out']
    for host, target in mounts:
        command += ['-v', str(host) + ':' + target + ':ro']
    command += ['mbbs-regular-v2:e2e', 'node', 'run.mjs', *arguments]
    with (ART / log_name).open('wb') as log:
        result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT)
    print((ART / log_name).read_text()[-5000:], flush=True)
    result.check_returncode()


def capture():
    runtime = ART / 'runtime'
    runtime.mkdir(exist_ok=True)
    image = docker('inspect', '--format', '{{.Image}}', 'mbbs-operator-app-app-1').decode().strip()
    with tarfile.open(fileobj=io.BytesIO(docker('cp', 'mbbs-operator-app-app-1:/app/public', '-'))) as archive:
        archive.extractall(runtime, filter='data')
    assert image == docker('inspect', '--format', '{{.Image}}', 'mbbs-operator-app-app-1').decode().strip()
    hashes = {str(p.relative_to(runtime / 'public')): hashlib.sha256(p.read_bytes()).hexdigest()
              for p in (runtime / 'public').rglob('*') if p.is_file()}
    (ART / 'source-evidence.json').write_text(json.dumps({'imageId': image, 'publicFiles': hashes,
        'trainingData': True, 'network': 'none', 'orderWrites': 0}, indent=2))
    shutil.copytree(ROOT / 'docs/stock-requests/2026-09-29/screenshots', OUT / 'screenshots', dirs_exist_ok=True)
    browser('tools/stock-request-manual-delivery-capture.mjs', [], [(runtime / 'public', '/app/public')], 'capture.log')
    for name in ['capture-failure.png', 'capture-failure.txt']:
        if (OUT / name).exists():
            shutil.move(OUT / name, ART / name)


def pdf():
    subprocess.run([sys.executable, str(ROOT / 'tools/stock-request-manual-content-zh.py')], check=True)
    browser('tools/stock-request-manual-pdf.mjs', ['zh-CN', '2026-09-30'], [], 'pdf-zh-CN.log')


if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else 'all'
    assert mode in ['all', 'capture', 'pdf']
    if mode in ['all', 'capture']:
        capture()
    if mode in ['all', 'pdf']:
        pdf()

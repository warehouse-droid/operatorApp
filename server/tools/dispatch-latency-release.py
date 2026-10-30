"""Overlay the reviewed latency patch on the current image, preserving concurrent releases."""
import difflib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
RELEASE = SERVER / 'deployments/dispatch-latency-20261023'
FILES = ['src/server.js', 'src/order-dependency-repository.js',
         'src/dispatch-completion-repository.js', 'src/dispatch-history-mode.js',
         'src/scm-reconciliation-repository.js']
spec = importlib.util.spec_from_file_location('guarded_release', SERVER / 'tools/dispatch-source-save-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE = RELEASE
release.FILES = FILES
release.EXISTING = FILES
release.IMAGE = 'mbbs-operator-app:dispatch-latency-20261023'
release.ROLLBACK = 'mbbs-operator-app:rollback-dispatch-latency-20261023'


def prepare():
    # Derive only our patch from the last frozen candidate, never from the
    # concurrently edited workspace. A changed live image becomes the new base.
    patch = ''.join(''.join(difflib.unified_diff(
        (RELEASE / 'live-before' / name).read_text().splitlines(True),
        (RELEASE / 'candidate' / name).read_text().splitlines(True),
        fromfile='a/' + name, tofile='b/' + name)) for name in FILES)
    assert patch, 'No reviewed patch to release'
    (RELEASE / 'release.patch').write_text(patch)
    info = {'app': release.core.metadata(release.APP),
            'dependencies': [release.core.metadata(name) for name in release.DEPENDENCIES]}
    for directory in ['candidate', 'live-before']:
        shutil.rmtree(RELEASE / directory)
    baseline = RELEASE / 'live-before'
    baseline.mkdir()
    subprocess.run(['tar', '--no-same-owner', '-xf', '-', '-C', str(baseline)],
                   input=release.docker('exec', release.APP, 'tar', '-C', '/app', '-cf', '-',
                                        'src', 'public', 'package.json', 'package-lock.json'), check=True)
    stage = RELEASE / 'candidate'
    shutil.copytree(baseline, stage)
    result = subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-d', str(stage)],
                            input=patch, text=True, capture_output=True)
    (RELEASE / 'patch.log').write_text(result.stdout + result.stderr)
    assert result.returncode == 0, 'Concurrent release overlaps our patch; review before continuing'
    changed = {}
    for name in FILES:
        old = (baseline / name).read_text().splitlines()
        new = (stage / name).read_text().splitlines()
        changed[name] = [line + 1 for tag, _, _, start, end in difflib.SequenceMatcher(None, old, new, autojunk=False).get_opcodes()
                         if tag != 'equal' for line in range(start, end)]
    (SERVER / 'test/dispatch/support/dispatch-latency-changed-lines.json').write_text(json.dumps(changed, indent=2) + '\n')
    info['files'] = {name: release.digest(stage / name) for name in FILES}
    release.current(info)
    release.docker('tag', info['app']['imageId'], release.ROLLBACK)
    (stage / 'Dockerfile').write_text('FROM ' + release.ROLLBACK + '\n' + ''.join(
        'COPY --chown=node:node ' + name + ' /app/' + name + '\n' for name in FILES))
    with (RELEASE / 'build.log').open('wb') as output:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network=none', '--pull=false',
                        '-t', release.IMAGE, str(stage)], stdout=output, stderr=subprocess.STDOUT, check=True)
    info['imageId'] = release.docker('image', 'inspect', '--format', '{{.Id}}', release.IMAGE).decode().strip()
    for name, image in [('compose.release.yml', release.IMAGE), ('compose.rollback.yml', release.ROLLBACK)]:
        (RELEASE / name).write_text('services:\n  app:\n    image: ' + image + '\n')
    release.save('manifest.json', info)
    try:
        release.smoke(info)
    finally:
        for args in [('ps',), ('ps', '-a')]:
            print(release.docker(*args, '--format', '{{.Names}} {{.Status}}').decode(), end='')
    release.current(info)
    print(json.dumps({'prepared': True, 'baseImage': info['app']['imageId'], 'imageId': info['imageId'], 'files': info['files']}))


if __name__ == '__main__':
    {'prepare': prepare, 'apply': release.apply, 'verify': release.verify}[sys.argv[1]]()

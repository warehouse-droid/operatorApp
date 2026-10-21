"""Layer the user's standalone REST PO choice over the deployed line-discount release."""
import difflib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('special_release', SERVER / 'tools/special-po-line-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
PREVIOUS = release.RELEASE
release.RELEASE = SERVER / 'deployments/special-po-standalone-20260928'
release.FILES = ['src/special-stock-request-service.js', 'src/special-stock-request-netsuite.js']
release.CONTAINERS = {'app': release.APP}
release.DEPENDENCIES += [release.WORKER]
release.IMAGE = {'app': 'mbbs-operator-app:special-po-standalone-20260928'}


def prepare():
    os.umask(0o077)
    checks = json.loads((release.OUT / 'checks.json').read_text())
    assert checks['completed'] and checks['fail'] == 0 and checks['mutantsKilled'] == 5
    coverage = json.loads((release.OUT / 'changed-lines.json').read_text())
    assert not coverage['uncovered'], 'Changed lines require verification'
    hashes = release.source_hashes()
    tested = json.loads((release.OUT / 'source-manifest.json').read_text())
    assert hashes == {name: tested[name] for name in release.FILES}
    release.RELEASE.mkdir(mode=0o700, exist_ok=True)
    assert not (release.RELEASE / 'manifest.json').exists(), 'Release already prepared'
    previous = json.loads((PREVIOUS / 'manifest.json').read_text())
    before = release.core.metadata(release.APP)
    info = {'files': hashes, 'services': {'app': {'before': before,
        'beforeFiles': {name: previous['services']['app']['afterFiles'][name] for name in release.FILES}}},
        'dependencies': [release.core.metadata(name) for name in release.DEPENDENCIES]}
    release.current(info)
    stage = release.RELEASE / 'stage-app'
    patch = ''
    for name in release.FILES:
        target = stage / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SERVER / name, target)
        patch += ''.join(difflib.unified_diff((PREVIOUS / 'stage-app' / name).read_text().splitlines(True),
            target.read_text().splitlines(True), fromfile='a/' + name, tofile='b/' + name))
    (release.RELEASE / 'release.patch').write_text(patch)
    assert release.docker('image', 'inspect', '--format', '{{.Id}}', before['image']).decode().strip() == before['imageId']
    (stage / 'Dockerfile').write_text('FROM ' + before['image'] + '\n' + ''.join(
        'COPY --chown=node:node ' + name + ' /app/' + name + '\n' for name in release.FILES))
    with (release.RELEASE / 'build.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', release.IMAGE['app'], str(stage)],
            stdout=log, stderr=subprocess.STDOUT, check=True)
    rows = release.docker('run', '--rm', '--network', 'none', '--entrypoint', 'sha256sum', release.IMAGE['app'],
        *['/app/' + name for name in release.FILES]).decode().splitlines()
    assert {row.split()[1].removeprefix('/app/'): row.split()[0] for row in rows} == hashes
    info['services']['app'].update({'afterFiles': hashes,
        'imageId': release.docker('image', 'inspect', '--format', '{{.Id}}', release.IMAGE['app']).decode().strip()})
    (release.RELEASE / 'compose.release.yml').write_text('services:\n  app:\n    image: ' + release.IMAGE['app'] + '\n')
    release.current(info)
    release.config_check(info)
    release.save('manifest.json', info)
    print(json.dumps({'prepared': True, 'appFiles': len(hashes), 'workerChanged': False, 'backupsRun': False}), flush=True)


if __name__ == '__main__':
    {'prepare': prepare, 'apply': release.apply}[sys.argv[1]]()

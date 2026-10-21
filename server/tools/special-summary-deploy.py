"""Publish the six scoped Special summary UI assets; no migration or worker changes."""
import difflib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('release', SERVER / 'tools/special-po-line-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.OUT = SERVER / 'test-artifacts/special-workflow-review/summary-controls-20260928'
release.RELEASE = SERVER / 'deployments/special-summary-controls-20260928'
release.FILES = json.loads((release.OUT / 'runtime-files.json').read_text())
release.CONTAINERS = {'app': release.APP}
release.DEPENDENCIES += [release.WORKER]
release.IMAGE = {'app': 'mbbs-operator-app:special-summary-controls-20260928'}


def prepare():
    os.umask(0o077)
    checks = json.loads((release.OUT / 'checks.json').read_text())
    assert checks['passed'] == checks['browserTests'] == 5 and checks['failed'] == 0
    assert checks['lint'] and checks['helperTypes']
    tested = json.loads((release.OUT / 'source-manifest.json').read_text())
    assert tested == release.source_hashes(), 'Tested UI source changed'
    baseline = json.loads((release.OUT / 'baseline-manifest.json').read_text())
    release.RELEASE.mkdir(mode=0o700, exist_ok=False)
    before = release.core.metadata(release.APP)
    info = {'files': tested, 'services': {'app': {'before': before, 'beforeFiles': baseline}},
            'dependencies': [release.core.metadata(name) for name in release.DEPENDENCIES]}
    release.current(info)
    stage = release.RELEASE / 'stage-app'
    patch = ''
    for name in release.FILES:
        target = stage / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SERVER / name, target)
        patch += ''.join(difflib.unified_diff((release.OUT / 'baseline' / name).read_text().splitlines(True), target.read_text().splitlines(True), fromfile='a/' + name, tofile='b/' + name))
    (release.RELEASE / 'release.patch').write_text(patch)
    assert release.docker('image', 'inspect', '--format', '{{.Id}}', before['image']).decode().strip() == before['imageId']
    (stage / 'Dockerfile').write_text('FROM ' + before['image'] + '\n' + ''.join('COPY --chown=node:node ' + name + ' /app/' + name + '\n' for name in release.FILES))
    with (release.RELEASE / 'build.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', release.IMAGE['app'], str(stage)], stdout=log, stderr=subprocess.STDOUT, check=True)
    rows = release.docker('run', '--rm', '--network', 'none', '--entrypoint', 'sha256sum', release.IMAGE['app'], *['/app/' + name for name in release.FILES]).decode().splitlines()
    assert {row.split()[1].removeprefix('/app/'): row.split()[0] for row in rows} == tested
    for name in release.FILES:
        if name.endswith('.js'):
            release.docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', release.IMAGE['app'], '--check', '/app/' + name)
    info['services']['app'].update({'afterFiles': tested, 'imageId': release.docker('image', 'inspect', '--format', '{{.Id}}', release.IMAGE['app']).decode().strip()})
    (release.RELEASE / 'compose.release.yml').write_text('services:\n  app:\n    image: ' + release.IMAGE['app'] + '\n')
    release.current(info)
    release.config_check(info)
    release.save('manifest.json', info)
    print(json.dumps({'prepared': True, 'uiFiles': len(tested), 'workerChanged': False, 'migration': None, 'backupsRun': False}), flush=True)


if __name__ == '__main__':
    {'prepare': prepare, 'apply': release.apply}[sys.argv[1]]()

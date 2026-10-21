"""Publish Sales and SCM UI files; no migration or regression-suite requirement."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

spec = importlib.util.spec_from_file_location('release', Path(__file__).with_name('special-workflow-native-deploy.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.BASE_IMAGE = 'sha256:91df9f618ae177e5ae3eaf89b8369a48b7d8e3c24b7b422dc2ba80061ce40022'
release.RELEASE = release.SERVER / 'test-artifacts/special-workflow-stock-layout-release-20260926'
release.EVIDENCE = release.SERVER / 'test-artifacts/special-workflow-review/sales-layout'
release.FILES = json.loads((release.EVIDENCE / 'runtime-files.json').read_text())
release.SERVICES = {'app': 'mbbs-operator-app-app-1'}
release.IMAGE = 'mbbs-operator-app:special-stock-layout-20260926'
release.ROLLBACK = 'mbbs-operator-app:rollback-special-stock-layout-20260926'
# apply() reads its first dependency as the database for an active-work check.
release.DEPENDENCIES = ['mbbs-operator-app-db-1', 'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-ollama-1']
release.migrate = lambda _info: None


def evidence():
    checks = json.loads((release.EVIDENCE / 'ui-smoke.json').read_text())
    assert len(checks) == 3 and all(row['passed'] for row in checks)
    scm_checks = json.loads((release.EVIDENCE / 'scm-ui-smoke.json').read_text())
    assert len(scm_checks) == 3 and all(row['passed'] for row in scm_checks)
    hashes = json.loads((release.EVIDENCE / 'source-manifest.json').read_text())
    for file in release.FILES:
        assert release.core.digest((release.SERVER / file).read_bytes()) == hashes[file]
    return hashes


release.evidence = evidence


def prepare():
    os.umask(0o077)
    hashes = evidence()
    release.RELEASE.mkdir(mode=0o700, exist_ok=False)
    info = {'files': hashes, 'services': {s: release.core.metadata(c) for s, c in release.SERVICES.items()},
            'dependencies': [release.core.metadata(c) for c in release.DEPENDENCIES]}
    assert info['services']['app']['imageId'] == release.BASE_IMAGE
    for file in release.FILES:
        assert release.docker('exec', release.SERVICES['app'], 'cat', '/app/' + file) == (release.EVIDENCE / 'baseline' / file).read_bytes(), file
    stage = release.RELEASE / 'stage'
    for file in release.FILES:
        target = stage / file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(release.SERVER / file, target)
    release.docker('tag', release.BASE_IMAGE, release.ROLLBACK)
    (stage / 'Dockerfile').write_text('FROM ' + release.ROLLBACK + '\n' + ''.join('COPY --chown=node:node ' + f + ' /app/' + f + '\n' for f in release.FILES))
    with (release.RELEASE / 'build.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', release.IMAGE, str(stage)], stdout=log, stderr=subprocess.STDOUT, check=True)
    info['imageId'] = release.docker('image', 'inspect', '--format', '{{.Id}}', release.IMAGE).decode().strip()
    for filename, image in [('compose.release.yml', release.IMAGE), ('compose.rollback.yml', release.BASE_IMAGE)]:
        (release.RELEASE / filename).write_text('services:\n  app:\n    image: ' + image + '\n')
    actual = release.docker('run', '--rm', '--network', 'none', '--entrypoint', 'sha256sum', release.IMAGE, *['/app/' + f for f in release.FILES]).decode().splitlines()
    assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in actual} == hashes
    release.docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', release.IMAGE, '--check', '/app/public/sales-special-stock-requests.js')
    release.save('manifest.json', info)
    release.current(info)
    release.config_gate(info)
    print(json.dumps({'prepared': True, 'imageId': info['imageId'], 'files': release.FILES}), flush=True)


if __name__ == '__main__':
    {'prepare': prepare, 'apply': release.apply, 'verify': release.verify}[sys.argv[1]]()

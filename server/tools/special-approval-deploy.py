"""Scoped Special approval/delivery release; no database backup or unrelated source replacement."""
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
release.OUT = SERVER / 'test-artifacts/special-workflow-review/po-approval-reference-20260928'
release.RELEASE = SERVER / 'deployments/special-approval-delivery-20260928'
release.FILES = json.loads((release.OUT / 'runtime-files.json').read_text())
release.IMAGE = {'app': 'mbbs-operator-app:special-approval-delivery-20260928', 'webhook-worker': 'mbbs-operator-app:special-approval-delivery-worker-20260928'}
WORKER_FILES = ['src/special-stock-request-repository.js', 'src/special-stock-planning.js', 'src/special-stock-request-policy.js', 'public/special-stock-workflow.js']
MIGRATION = 'migrations/237_special_purchase_approval.sql'


def prepare():
    os.umask(0o077)
    checks = json.loads((release.OUT / 'checks.json').read_text())
    assert checks['completed'] and checks['fail'] == 0 and checks['tests'] == checks['pass'] and checks['mutantsKilled'] == 5
    coverage = json.loads((release.OUT / 'changed-lines.json').read_text())
    assert not coverage['uncovered'], 'Changed lines require verification'
    assert release.source_hashes() == json.loads((release.OUT / 'source-manifest.json').read_text()), 'Tested source drift'
    release.RELEASE.mkdir(mode=0o700, exist_ok=True)
    assert not (release.RELEASE / 'manifest.json').exists(), 'Already prepared'
    captured = json.loads((release.OUT / 'live-metadata.json').read_text())
    info = {'files': release.source_hashes(), 'services': {}, 'dependencies': [release.core.metadata(name) for name in release.DEPENDENCIES]}
    for service, container in release.CONTAINERS.items():
        files = release.FILES if service == 'app' else WORKER_FILES
        live = release.OUT / ('live-' + service)
        before = release.core.metadata(container)
        assert before == captured[service], 'Deployment changed since scoped capture'
        info['services'][service] = {'before': before, 'beforeFiles': {name: release.digest((live / name).read_bytes()) for name in files if (live / name).exists()}}
        stage = release.RELEASE / ('stage-' + service)
        patch = ''
        for name in files:
            target = stage / name
            target.parent.mkdir(parents=True, exist_ok=True)
            baseline = release.OUT / 'baseline' / name
            if baseline.exists():
                shutil.copy2(live / name, target)
                patch += ''.join(difflib.unified_diff(baseline.read_text().splitlines(True), (SERVER / name).read_text().splitlines(True), fromfile='a/' + name, tofile='b/' + name))
            else:
                release.docker('exec', container, 'test', '!', '-e', '/app/' + name)
                shutil.copy2(SERVER / name, target)
        (release.RELEASE / (service + '.patch')).write_text(patch)
        result = subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-d', str(stage)], input=patch, text=True, capture_output=True)
        (release.RELEASE / (service + '-patch.log')).write_text(result.stdout + result.stderr)
        assert result.returncode == 0, 'Scoped patch conflict'
        if service == 'app':
            assert all((stage / name).read_bytes() == (SERVER / name).read_bytes() for name in files), 'App candidate differs from tested source'
        assert release.live_hashes(container, list(info['services'][service]['beforeFiles'])) == info['services'][service]['beforeFiles']
        assert release.docker('image', 'inspect', '--format', '{{.Id}}', before['image']).decode().strip() == before['imageId']
        (stage / 'Dockerfile').write_text('FROM ' + before['image'] + '\n' + ''.join('COPY --chown=node:node ' + name + ' /app/' + name + '\n' for name in files))
        with (release.RELEASE / ('build-' + service + '.log')).open('wb') as log:
            subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', release.IMAGE[service], str(stage)], stdout=log, stderr=subprocess.STDOUT, check=True)
        hashes = {name: release.digest((stage / name).read_bytes()) for name in files}
        rows = release.docker('run', '--rm', '--network', 'none', '--entrypoint', 'sha256sum', release.IMAGE[service], *['/app/' + name for name in files]).decode().splitlines()
        assert {row.split()[1].removeprefix('/app/'): row.split()[0] for row in rows} == hashes
        for name in files:
            if name.endswith('.js'):
                release.docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', release.IMAGE[service], '--check', '/app/' + name)
        info['services'][service].update({'afterFiles': hashes, 'imageId': release.docker('image', 'inspect', '--format', '{{.Id}}', release.IMAGE[service]).decode().strip()})
    (release.RELEASE / 'compose.release.yml').write_text('services:\n' + ''.join('  ' + service + ':\n    image: ' + image + '\n' for service, image in release.IMAGE.items()))
    release.current(info)
    release.config_check(info)
    release.save('manifest.json', info)
    print(json.dumps({'prepared': True, 'appFiles': len(release.FILES), 'workerFiles': len(WORKER_FILES), 'backupsRun': False}), flush=True)


def apply():
    info = json.loads((release.RELEASE / 'manifest.json').read_text())
    release.current(info)
    release.config_check(info)
    sql = (SERVER / MIGRATION).read_text()
    # Additive schema, transactionally applied; existing cases and NetSuite values are untouched.
    release.database('BEGIN;\n' + sql + "\nINSERT INTO schema_migrations(filename) VALUES('237_special_purchase_approval.sql') ON CONFLICT(filename) DO NOTHING;\nCOMMIT;")
    release.apply()
    result = json.loads((release.RELEASE / 'result.json').read_text())
    result['migration'] = MIGRATION
    release.save('result.json', result)


if __name__ == '__main__':
    {'prepare': prepare, 'apply': apply}[sys.argv[1]]()

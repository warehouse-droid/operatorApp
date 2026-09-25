"""Build a reviewable overlay on the running image; never deploy unrelated edits."""
from pathlib import Path
import difflib
import hashlib
import json
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[2]
ARTIFACT = ROOT / 'server/test-artifacts/operator-background-photos'
RELEASE = ARTIFACT / 'release'
EXISTING = ['src/server.js', 'src/delivery-repository.js', 'src/receiving-repository.js',
            'src/sales-order-reload-repository.js', 'src/consolidation-load-service.js',
            'src/operator-yard-authorization.js', 'src/photo-archive-repository.js',
            'public/operator.js', 'public/operator.html', 'public/service-worker.js',
            'public/control.js', 'public/sales.js', 'public/dispatch-loaded-export.js']
NEW = ['src/operator-background-photos.js', 'src/operator-background-photo-worker.js',
       'public/operator-photo-outbox.js', 'migrations/204_operator_background_photos.sql']

def command(*args):
    return subprocess.check_output(args, text=True)

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def metadata(container):
    return json.loads(command('docker', 'inspect', '--format',
        '{"image":{{json .Config.Image}},"imageId":{{json .Image}},"configFiles":{{json (index .Config.Labels "com.docker.compose.project.config_files")}}}', container))

def prepare():
    RELEASE.mkdir(parents=True, exist_ok=True)
    before = RELEASE / 'before'
    before.mkdir(exist_ok=True)
    app = metadata('mbbs-operator-app-app-1')
    worker = metadata('mbbs-operator-app-webhook-worker-1')
    for folder in ['src', 'public', 'migrations']:
        if (before / folder).exists(): shutil.rmtree(before / folder)
        subprocess.run(['docker', 'cp', 'mbbs-operator-app-app-1:/app/' + folder, str(before / folder)], check=True)
    stage = RELEASE / 'stage'
    if stage.exists(): shutil.rmtree(stage)
    shutil.copytree(before, stage)
    patches = []
    for file in EXISTING:
        baseline = (ARTIFACT / 'baseline' / file).read_text()
        current = (ROOT / 'server' / file).read_text()
        patches.extend(difflib.unified_diff(baseline.splitlines(True), current.splitlines(True), fromfile='a/' + file, tofile='b/' + file))
    patch = RELEASE / 'background-only.patch'
    patch.write_text(''.join(patches))
    subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-d', str(stage), '-i', str(patch)], check=True)
    # The separately verified query optimization was already in the workspace
    # baseline for this fix, so explicitly include its two scoped predicates.
    repository = stage / 'src/delivery-repository.js'
    before_query = repository.read_text()
    query_patch = ROOT / 'server/test/support/local-load-performance-baseline.patch'
    if 'WHERE l.sales_order_id = $1' not in before_query:
        subprocess.run(['patch', '--batch', '--fuzz=0', '-R', '-p1', '-d', str(stage), '-i', str(query_patch)], check=True)
    for file in NEW:
        (stage / file).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / 'server' / file, stage / file)
    manifest = {'app': app, 'worker': worker, 'files': EXISTING + NEW,
                'before': {file: digest(before / file) for file in EXISTING},
                'after': {file: digest(stage / file) for file in EXISTING + NEW},
                'workspace': {file: digest(ROOT / 'server' / file) for file in EXISTING + NEW}}
    (RELEASE / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    (stage / 'Dockerfile').write_text('FROM ' + app['image'] + '\n' + ''.join('COPY ' + file + ' /app/' + file + '\n' for file in EXISTING + NEW))
    print(json.dumps({'prepared': True, 'baseImage': app['image'], 'files': manifest['files']}))

if __name__ == '__main__': prepare()

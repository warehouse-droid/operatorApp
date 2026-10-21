"""Resume the verified release build with one COPY layer and bounded validation."""
import importlib.util
import json
from pathlib import Path
import subprocess

TASK = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('sor_release', TASK / 'deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
data = release.state()
release.evidence()
release.current(data)
(release.RELEASE / 'candidate/Dockerfile').write_text('FROM ' + data['baseImageTag'] + '\nCOPY --chown=node:node src/ /app/src/\n')
with (release.RELEASE / 'build-single-copy.log').open('wb') as log:
    subprocess.run(['sudo', '-n', 'docker', 'build', '--pull=false', '--network=none', '-t', release.IMAGE,
                    str(release.RELEASE / 'candidate')], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=120)
data['candidateImageId'] = release.docker('image', 'inspect', '--format', '{{.Id}}', release.IMAGE).decode().strip()
release.docker('tag', data['app']['imageId'], 'mbbs-operator-app:rollback-sor-return-date-conflict-20261014')
release.save('manifest.json', data)
release.current(data)
before = json.loads(subprocess.check_output(release.compose(data, 'compose.rollback.yml') + ['config', '--format', 'json'], cwd=release.ROOT))
after = json.loads(subprocess.check_output(release.compose(data, 'compose.release.yml') + ['config', '--format', 'json'], cwd=release.ROOT))
before['services']['app'].pop('image', None)
assert after['services']['app'].pop('image') == release.IMAGE
assert before == after, 'Configuration would change'
name = 'mbbs-sor-return-date-conflict-20261014-candidate-check'
try:
    release.docker('run', '--rm', '--init', '--network=none', '--read-only', '--cgroup-parent=mbbs-tests.slice',
        '--memory=256m', '--memory-swap=256m', '--cpus=1', '--pids-limit=64', '--tmpfs', '/tmp:size=64m',
        '--label', 'com.mbbs.lifecycle=disposable-test', '--name', name, '--entrypoint', 'node', release.IMAGE,
        '-e', 'const {spawnSync}=require("node:child_process");const {readFileSync}=require("node:fs");const {createHash}=require("node:crypto");'
        + 'for(const [file,hash] of Object.entries(' + json.dumps(data['after']) + ')) {'
        + 'if(createHash("sha256").update(readFileSync(file)).digest("hex")!==hash||spawnSync(process.execPath,["--check",file]).status)process.exit(1);}')
finally:
    remaining = release.docker('ps', '-a', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}').decode().strip()
    if remaining:
        release.docker('rm', '-f', '-v', remaining)
    release.save('prepare-containers.json', release.listings())
release.save('prepared.json', {'candidateImageId': data['candidateImageId'], 'files': release.FILES,
    'configurationPreserved': True, 'buildStrategy': 'single COPY layer'})
print(json.dumps({'prepared': True, 'imageId': data['candidateImageId'], 'files': release.FILES}), flush=True)

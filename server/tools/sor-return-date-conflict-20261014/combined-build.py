"""Combine the newest file-only release and the verified fix into one image layer."""
import copy
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import tempfile
import time

TASK = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('sor_release', TASK / 'deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.evidence()
data = release.state()
release.current(data)
record = json.loads((release.RELEASE / 'rebase-result.json').read_text())
earlier_id = record['previousBase']
earlier, latest = json.loads(release.docker('image', 'inspect', earlier_id, data['app']['imageId']))
assert latest['RootFS']['Layers'][:-1] == earlier['RootFS']['Layers']
assert latest['Config'] == earlier['Config']
assert (latest['Architecture'], latest['Os']) == (earlier['Architecture'], earlier['Os'])
os.umask(0o077)
stage = release.RELEASE / 'combined-tar-layer'
stage.mkdir(exist_ok=False)
layer_path = release.RELEASE / 'latest-base-file-layer.tar'
# This archive contains image files only, with no live container or data volumes.
if not layer_path.exists():
    with tempfile.TemporaryFile(dir=release.RELEASE) as archive:
        subprocess.run(['sudo', '-n', 'docker', 'save', data['app']['imageId']], stdout=archive,
            check=True, timeout=120)
        archive.seek(0)
        with tarfile.open(fileobj=archive, mode='r:') as image:
            manifests = json.load(image.extractfile('manifest.json'))
            assert len(manifests) == 1
            manifest = manifests[0]
            config = json.load(image.extractfile(manifest['Config']))
            assert config['rootfs']['diff_ids'] == latest['RootFS']['Layers']
            assert config['config'] == latest['Config']
            with layer_path.open('wb') as output:
                shutil.copyfileobj(image.extractfile(manifest['Layers'][-1]), output)
with layer_path.open('rb') as raw:
    compressed = raw.read(2) == b'\x1f\x8b'
with (gzip.open(layer_path, 'rb') if compressed else layer_path.open('rb')) as contents:
    assert hashlib.file_digest(contents, 'sha256').hexdigest() == latest['RootFS']['Layers'][-1].split(':')[-1]
file_metadata = json.loads(release.docker('exec', release.APP, 'node', '--input-type=module', '-e',
    'import {statSync} from "node:fs";console.log(JSON.stringify(Object.fromEntries(' + json.dumps(release.FILES)
    + '.map(file=>{const s=statSync("/app/"+file);return [file,{mode:s.mode&0o777,uid:s.uid,gid:s.gid}]}))));'))
base_files = {}
with tarfile.open(layer_path, mode='r:*') as layer, tarfile.open(stage / 'combined-layer.tar', mode='w:') as combined:
    for item in layer:
        path = PurePosixPath(item.name)
        assert not path.is_absolute() and '..' not in path.parts
        assert path.parts and path.parts[0] == 'app', 'Unexpected image layer scope: ' + item.name
        assert not any(part.startswith('.wh.') for part in path.parts), 'Layer deletion requires another build strategy'
        assert item.isdir() or item.isfile(), 'Special file requires another build strategy: ' + item.name
        if item.isdir():
            combined.addfile(copy.copy(item))
            continue
        file = str(path.relative_to('app'))
        assert path.parts[1] in ['src', 'public', 'migrations'], 'Unexpected application file scope: ' + file
        contents = layer.extractfile(item).read()
        assert contents == release.docker('exec', release.APP, 'cat', '/app/' + file)
        assert file not in release.FILES, 'The newest base layer overlaps the verified patch'
        combined.addfile(copy.copy(item), layer.extractfile(item))
        base_files[file] = release.digest(contents)
    assert base_files, 'The current base layer has no files'
    for file in release.FILES:
        source = TASK / 'candidate' / file
        assert release.digest(source.read_bytes()) == data['after'][file]
        item = tarfile.TarInfo('app/' + file)
        item.size = source.stat().st_size
        item.mode, item.uid, item.gid = (file_metadata[file][key] for key in ['mode', 'uid', 'gid'])
        item.mtime = int(time.time())
        with source.open('rb') as contents:
            combined.addfile(item, contents)
base_tag = 'mbbs-operator-app:sor-return-combined-base-' + earlier_id.split(':')[-1][:12]
release.docker('tag', earlier_id, base_tag)
(stage / 'Dockerfile').write_text('FROM ' + base_tag + '\nADD combined-layer.tar /\n')
release.current(data)
with (release.RELEASE / 'build-combined-layer.log').open('wb') as log:
    subprocess.run(['sudo', '-n', 'docker', 'build', '--pull=false', '--network=none', '-t', release.IMAGE,
        str(stage)], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=120)
data['candidateImageId'] = release.docker('image', 'inspect', '--format', '{{.Id}}', release.IMAGE).decode().strip()
candidate = json.loads(release.docker('image', 'inspect', release.IMAGE))[0]
assert candidate['Config'] == latest['Config'], 'Image configuration changed'
assert candidate['RootFS']['Layers'][:-1] == earlier['RootFS']['Layers']
assert len(candidate['RootFS']['Layers']) == len(latest['RootFS']['Layers'])
release.docker('tag', data['app']['imageId'], 'mbbs-operator-app:rollback-sor-return-date-conflict-20261014')
data['buildStrategy'] = 'single ADD tar preserving newest base-layer file ownership and verified planner fix'
data['buildBaseImageId'] = earlier_id
data['retainedBaseFiles'] = base_files
release.save('manifest.json', data)
release.current(data)
before_config = json.loads(subprocess.check_output(release.compose(data, 'compose.rollback.yml') + ['config', '--format', 'json'], cwd=release.ROOT))
after_config = json.loads(subprocess.check_output(release.compose(data, 'compose.release.yml') + ['config', '--format', 'json'], cwd=release.ROOT))
before_config['services']['app'].pop('image', None)
assert after_config['services']['app'].pop('image') == release.IMAGE
assert before_config == after_config, 'Compose configuration would change'
inventory_script = '''
import {lstatSync,readdirSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const result={};
function visit(file) {
  const stat=lstatSync(file);
  if(stat.isDirectory()) {for(const name of readdirSync(file).sort())visit(file+'/'+name);return;}
  if(!stat.isFile())throw new Error('Unexpected application file type: '+file);
  result[file]={hash:createHash('sha256').update(readFileSync(file)).digest('hex'),
    mode:stat.mode&0o777,uid:stat.uid,gid:stat.gid};
}
for(const file of ['src','public','migrations','package.json','package-lock.json'])visit(file);
console.log(JSON.stringify(result));
'''
before_inventory = json.loads(release.docker('exec', '-i', '-w', '/app', release.APP,
    'node', '--input-type=module', input=inventory_script.encode()))
(release.RELEASE / 'application-inventory-before.json').write_text(json.dumps(before_inventory, indent=2) + '\n')
name = 'mbbs-sor-return-date-conflict-20261014-candidate-check'
# Register removal before launching the bounded, isolated candidate validation.
try:
    syntax = 'import {spawnSync} from "node:child_process";for(const file of ' + json.dumps(release.FILES) + ')if(spawnSync(process.execPath,["--check",file]).status)process.exit(1);\n'
    after_inventory = json.loads(release.docker('run', '--rm', '--init', '--network=none', '--read-only',
        '--cgroup-parent=mbbs-tests.slice', '--memory=256m', '--memory-swap=256m', '--cpus=1',
        '--pids-limit=64', '--tmpfs', '/tmp:size=64m', '--label', 'com.mbbs.lifecycle=disposable-test',
        '--name', name, '--entrypoint', 'node', release.IMAGE, '--input-type=module', '-e', syntax + inventory_script))
    expected = copy.deepcopy(before_inventory)
    for file, hash_value in data['after'].items():
        assert expected[file]['hash'] == data['before'][file]
        expected[file]['hash'] = hash_value
    assert after_inventory == expected, 'Application file inventory differs beyond the two verified changes'
    for file, hash_value in base_files.items():
        if file not in release.FILES:
            assert after_inventory[file]['hash'] == hash_value
    (release.RELEASE / 'application-inventory-after.json').write_text(json.dumps(after_inventory, indent=2) + '\n')
finally:
    remaining = release.docker('ps', '-a', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}').decode().strip()
    if remaining:
        release.docker('rm', '-f', '-v', remaining)
    release.save('prepare-containers.json', release.listings())
release.current(data)
prepared = {'candidateImageId': data['candidateImageId'], 'files': release.FILES,
    'configurationPreserved': True, 'buildStrategy': data['buildStrategy'],
    'applicationFilesVerified': len(after_inventory), 'onlyTwoApplicationFilesChanged': True,
    'retainedBaseFiles': base_files, 'imageLayers': len(candidate['RootFS']['Layers'])}
release.save('prepared.json', prepared)
(release.EVIDENCE / 'combined-build.json').write_text(json.dumps(prepared, indent=2) + '\n')
print(json.dumps(prepared), flush=True)

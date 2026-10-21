"""Build a scoped receiving image, preview read-only live data, and retain a reversible release."""
import datetime
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

server = Path('/home/ubuntu/apps/operatorApp/server')
spec = importlib.util.spec_from_file_location('receiving_release_core', server / 'tools/operator-display-settings-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
source = Path(os.environ.get('RECEIVING_MULTIYARD_SOURCE_ROOT', str(server / 'deployments/receiving-multi-yard-20260930.verified-source'))).resolve()
core.RELEASE = server / 'deployments/receiving-multi-yard-20260930'
core.IMAGE = 'mbbs-operator-app:receiving-multi-yard-20260930'
core.ROLLBACK = 'mbbs-operator-app:rollback-receiving-multi-yard-20260930'
data_manifest = json.loads((source / 'test/receiving-multi-yard-manifest.json').read_text())
core.FILES = sorted(data_manifest['runtimeFiles'])
core.EXISTING = [file for file in core.FILES if file in data_manifest['before']]
core.ADDED = [file for file in core.FILES if file not in data_manifest['before']]
release = core.RELEASE

def prepare():
    os.umask(0o077)
    release.mkdir(parents=True, exist_ok=False)
    state = {'app': core.metadata(core.APP), 'dependencies': [core.metadata(name) for name in core.DEPENDENCIES]}
    raw = core.docker('exec', core.APP, 'tar', '-C', '/app', '-cf', '-', 'src', 'public', 'migrations', 'package.json', 'package-lock.json')
    (release / 'baseline').mkdir()
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
        archive.extractall(release / 'baseline', filter='data')
    before = core.files_at(release / 'baseline')
    assert {file: before[file] for file in core.EXISTING} == data_manifest['before'], 'The live sources changed; rebase required'
    shutil.copytree(release / 'baseline', release / 'candidate')
    for file in core.FILES:
        shutil.copyfile(source / file, release / 'candidate' / file)
        target = release / 'stage' / file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / file, target)
        target.chmod(0o644)
    after = core.files_at(release / 'candidate')
    assert sorted(file for file in after if after[file] != before.get(file)) == core.FILES
    state.update({'before': {file: before[file] for file in core.EXISTING}, 'after': data_manifest['after'],
        'workspace': {file: core.digest((server / file).read_bytes()) for file in core.FILES},
        'allAfter': after, 'changedFiles': core.FILES})
    shutil.copyfile(source / 'test/receiving-multi-yard.changes.patch', release / 'release.patch')
    (release / 'compose.release.yml').write_text('services:\n  app:\n    image: ' + core.IMAGE + '\n')
    (release / 'compose.rollback.yml').write_text('services:\n  app:\n    image: ' + state['app']['imageId'] + '\n')
    core.save('manifest.json', state)
    core.current(state)
    print(json.dumps({'prepared': True, 'files': len(core.FILES), 'parent': state['app']['image']}), flush=True)

def preview():
    state = core.manifest()
    core.current(state)
    config = json.loads(core.docker('inspect', core.APP))[0]
    env = release / 'preview.env'
    env.write_text('\n'.join(config['Config']['Env']) + '\n')
    env.chmod(0o600)
    try:
        mounts = []
        for mount in config['Mounts']:
            mounts += ['--mount', 'type=' + mount['Type'] + ',src=' + str(mount.get('Name') or mount['Source']) + ',dst=' + mount['Destination'] + ',readonly']
        output = core.docker('run', '--rm', '--network', next(iter(config['NetworkSettings']['Networks'])),
            '--env-file', str(env), *mounts, '--mount', f'type=bind,src={source / "tools/receiving-multi-yard-live.mjs"},dst=/app/tools/receiving-multi-yard-live.mjs,readonly',
            '--entrypoint', 'node', core.IMAGE, 'tools/receiving-multi-yard-live.mjs', timeout=90).decode()
        result = json.loads(output.strip().splitlines()[-1])
        assert result['readOnly'] and result['poWrites'] == result['receiptWrites'] == result['netSuitePosts'] == 0
        core.save('preview.json', result)
        core.current(state)
        print(json.dumps(result), flush=True)
    finally:
        env.unlink(missing_ok=True)

def verify():
    state = core.manifest()
    core.ready(state['candidateImageId'])
    after = core.metadata(core.APP)
    assert after['configuration'] == state['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == state['dependencies']
    rows = core.docker('exec', core.APP, 'sha256sum', *['/app/' + file for file in state['allAfter']]).decode().splitlines()
    assert {row.split()[1].removeprefix('/app/'): row.split()[0] for row in rows} == state['allAfter']
    assets = {url: state['after'][file] for url, file in [
        ('/operator', 'public/operator.html'),
        ('/operator.js?v=20260930-receiving-multi-yard-v1', 'public/operator.js'),
        ('/service-worker.js', 'public/service-worker.js')]}
    script = "import assert from 'node:assert/strict'; import {createHash} from 'node:crypto'; " + \
        "const expected=" + json.dumps(assets) + "; for(const [url,hash] of Object.entries(expected)) {" + \
        "const response=await fetch('http://127.0.0.1:3000'+url,{cache:'no-store'}); assert.equal(response.status,200);" + \
        "assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),hash,url); }"
    core.docker('exec', core.APP, 'node', '--input-type=module', '-e', script)
    code = (source / 'tools/receiving-multi-yard-live.mjs').read_bytes()
    result = json.loads(core.docker('exec', '-i', core.APP, 'node', '--input-type=module', input=code.replace(b"'../src/", b"'./src/")).decode().strip().splitlines()[-1])
    outcome = {'deployed': True, 'image': core.IMAGE, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'configurationPreserved': True, 'dependenciesUnchanged': True, 'runtimeFilesVerified': len(rows),
        'publicAssetsVerified': len(assets), 'receiving': result}
    core.save('deployment-result.json', outcome)
    print(json.dumps(outcome), flush=True)

def apply():
    state = core.manifest()
    core.current(state)
    checks = json.loads((source / 'test-artifacts/receiving-multi-yard/gauntlet.json').read_text())
    assert checks['passed'] and any(row['name'] == 'full' for row in checks['results']), 'Full gauntlet required'
    full = json.loads((source / 'test-artifacts/receiving-multi-yard/full-comparison.json').read_text())
    assert not full['newFailures'] and not full['newDeadlines'], 'Full suite must have no new failures or test deadlines'
    assert (release / 'preview.json').exists()
    assert core.database("SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing');").strip() == '0'
    command = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
    try:
        with (release / 'cutover.log').open('wb') as output:
            subprocess.run(core.compose(state, 'compose.release.yml') + command, cwd=core.ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=90)
        verify()
    except Exception:
        with (release / 'rollback.log').open('wb') as output:
            subprocess.run(core.compose(state, 'compose.rollback.yml') + command, cwd=core.ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=90)
        core.ready(state['app']['imageId'])
        raise

if __name__ == '__main__':
    {'prepare': prepare, 'build': core.build, 'preview': preview, 'apply': apply, 'verify': verify}[sys.argv[1]]()

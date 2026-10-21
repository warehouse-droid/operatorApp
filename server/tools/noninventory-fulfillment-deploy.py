"""Scoped four-file fulfillment release, read-only SOM06789 preview, and reversible cutover."""
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

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('noninventory_release_core', HERE/'operator-display-settings-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE = core.SERVER/'deployments/noninventory-fulfillment-20260930'
core.IMAGE = 'mbbs-operator-app:noninventory-fulfillment-20260930'
core.ROLLBACK = 'mbbs-operator-app:rollback-noninventory-fulfillment-20260930'
core.EXISTING = core.FILES = ['src/delivery-repository.js', 'src/operator-netsuite-posting-targets.js', 'src/netsuite.js', 'src/sales-order-auto-fulfillment-repository.js']
core.ADDED = []
R = core.RELEASE
OUT = core.SERVER/'test-artifacts/noninventory-fulfillment'
HASH_SCRIPT = """const fs=require('node:fs'),crypto=require('node:crypto'),hashes={};
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=dir+'/'+e.name;
if(e.isDirectory())walk(p);else if(e.isFile())hashes[p]=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');}}
for(const dir of ['src','public','migrations'])walk(dir);console.log(JSON.stringify(hashes));"""

def prepare():
    os.umask(0o077)
    R.mkdir(exist_ok=False)
    data = {'app': core.metadata(core.APP), 'dependencies': [core.metadata(name) for name in core.DEPENDENCIES]}
    raw = core.docker('exec', core.APP, 'tar', '-C', '/app', '-cf', '-', 'src', 'public', 'migrations')
    (R/'baseline').mkdir()
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
        archive.extractall(R/'baseline', filter='data')
    before = core.files_at(R/'baseline')
    assert {file: before[file] for file in core.FILES} == json.loads((OUT/'baseline-hashes.json').read_text()), 'Rebase required'
    shutil.copytree(R/'baseline', R/'candidate')
    for file in core.FILES:
        shutil.copyfile(core.SERVER/file, R/'candidate'/file)
        (R/'stage'/file).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(core.SERVER/file, R/'stage'/file)
    after = core.files_at(R/'candidate')
    assert sorted(file for file in after if after[file] != before.get(file)) == sorted(core.FILES)
    data.update({'before': {file: before[file] for file in core.FILES}, 'after': {file: after[file] for file in core.FILES},
                 'workspace': {file: core.digest((core.SERVER/file).read_bytes()) for file in core.FILES},
                 'allAfter': after, 'changedFiles': core.FILES})
    core.current(data)
    core.docker('tag', data['app']['imageId'], core.ROLLBACK)
    core.save('manifest.json', data)
    copies = ''.join('COPY --chown=node:node --chmod=0644 '+file+' /app/'+file+'\n' for file in core.FILES)
    (R/'stage/Dockerfile').write_text('FROM '+core.ROLLBACK+'\n'+copies)
    with (R/'build.log').open('wb') as log:
        result = subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', core.IMAGE, str(R/'stage')], stdout=log, stderr=subprocess.STDOUT)
    if result.returncode != 0 and 'max depth exceeded' in (R/'build.log').read_text():
        shutil.copyfile(R/'build.log', R/'build-before-flatten.log')
        group_spec = importlib.util.spec_from_file_location('noninventory_flatten', HERE/'operator-group-packing-deploy.py')
        group = importlib.util.module_from_spec(group_spec)
        group_spec.loader.exec_module(group)
        group.core, group.R = core, R
        base = group.flatten(data)
        (R/'stage/Dockerfile').write_text('FROM '+base+'\n'+copies)
        with (R/'build.log').open('wb') as log:
            result = subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', core.IMAGE, str(R/'stage')], stdout=log, stderr=subprocess.STDOUT)
    assert result.returncode == 0, 'Build failed; see build.log'
    data['candidateImageId'] = core.docker('image', 'inspect', '--format', '{{.Id}}', core.IMAGE).decode().strip()
    assert json.loads(core.docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', core.IMAGE, '-e', HASH_SCRIPT)) == after
    (R/'compose.release.yml').write_text('services:\n  app:\n    image: '+core.IMAGE+'\n')
    (R/'compose.rollback.yml').write_text('services:\n  app:\n    image: '+data['app']['imageId']+'\n')
    shutil.copyfile(OUT/'release.patch', R/'release.patch')
    core.save('manifest.json', data)
    print(json.dumps({'prepared': True, 'image': core.IMAGE, 'sourceFilesChanged': len(core.FILES), 'runtimeFilesVerified': len(after)}), flush=True)

def preview():
    data = core.manifest()
    core.current(data)
    config = json.loads(core.docker('inspect', core.APP))[0]
    env = R/'preview.env'
    assert all('\n' not in value and '\r' not in value for value in config['Config']['Env']), 'Environment contains multiline values'
    env.write_text('\n'.join(config['Config']['Env'])+'\n')
    os.chmod(env, 0o600)
    try:
        mounts = []
        for mount in config['Mounts']:
            mounts += ['--mount', 'type='+mount['Type']+',src='+str(mount.get('Name') or mount['Source'])+',dst='+mount['Destination']+',readonly']
        output = core.docker('run', '--rm', '--network', next(iter(config['NetworkSettings']['Networks'])),
            '--env-file', str(env), *mounts, '--mount', f'type=bind,src={HERE/"noninventory-fulfillment-live.mjs"},dst=/app/tools/noninventory-fulfillment-live.mjs,readonly',
            '--entrypoint', 'node', core.IMAGE, 'tools/noninventory-fulfillment-live.mjs', timeout=240).decode()
        (R/'preview.log').write_text(output)
        result = next(json.loads(line) for line in reversed(output.splitlines()) if line.startswith('{') and '"readOnly":true' in line)
        assert result['netSuitePosts'] == 0 and result['resaleVisible'] is True
        core.current(data)
        core.save('preview.json', result)
        print(json.dumps(result), flush=True)
    finally:
        env.unlink(missing_ok=True)

def configuration_check(data):
    resolved = json.loads(subprocess.check_output(core.compose(data, 'compose.release.yml')+['config', '--format', 'json'], cwd=core.ROOT))['services']['app']
    image = json.loads(core.docker('image', 'inspect', core.IMAGE))[0]['Config']
    actual = json.loads(core.docker('inspect', core.APP))[0]['Config']
    env = dict(row.split('=', 1) for row in image['Env'])
    env.update({key: str(value) for key, value in resolved.get('environment', {}).items()})
    assert env == dict(row.split('=', 1) for row in actual['Env']), 'Compose would change application environment'
    for field, key in [('Cmd', 'command'), ('Entrypoint', 'entrypoint'), ('User', 'user'), ('WorkingDir', 'working_dir')]:
        expected = resolved.get(key)
        assert (image.get(field) if expected is None else expected) == actual.get(field), 'Compose would change '+field

def verify():
    data = core.manifest()
    core.ready(data['candidateImageId'])
    after = core.metadata(core.APP)
    assert after['configuration'] == data['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    assert json.loads(core.docker('exec', core.APP, 'node', '-e', HASH_SCRIPT)) == data['allAfter']
    script = """import assert from 'node:assert/strict';
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
const health=await fetch(base+'/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
assert.equal((await fetch(base+'/operator')).status,200);
assert.equal((await fetch(base+'/api/delivery/orders?locationId=26')).status,401);
}console.log(JSON.stringify({localHealth:200,publicHealth:200,operatorPage:200,anonymousOrders:401}));"""
    checks = json.loads(core.docker('exec', '-i', core.APP, 'node', '--input-type=module', input=script.encode()))
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'image': core.IMAGE,
              'imageId': after['imageId'], 'sourceFilesChanged': len(core.FILES), 'runtimeFilesVerified': len(data['allAfter']),
              'configurationPreserved': True, 'dependenciesPreserved': True, 'netSuitePosts': 0, **checks}
    core.save('result.json', result)
    print(json.dumps(result), flush=True)

def apply():
    data = core.manifest()
    core.current(data)
    configuration_check(data)
    verified = json.loads((OUT/'verified-hashes.json').read_text())
    assert verified == data['after'], 'Fresh verification required'
    assert json.loads((R/'preview.json').read_text())['netSuitePosts'] == 0
    assert core.docker('image', 'inspect', '--format', '{{.Id}}', core.IMAGE).decode().strip() == data['candidateImageId']
    active = json.loads(core.database("""SELECT json_build_object(
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'autoFulfillment',(SELECT count(*) FROM dispatch_sales_order_if_candidates WHERE status='posting'),
      'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'quantityApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying'),
      'stockTransferConfirming',(SELECT count(*) FROM sales_stock_transfers WHERE confirmation_status IN ('creating','approving','hydrating','printing')),
      'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'),
      'scmExecuting',(SELECT count(*) FROM scm_smart_proposals WHERE status='executing'))"""))
    core.save('active-before-release.json', active)
    assert not any(active.values()), 'Wait for active operations before restart: '+json.dumps(active)
    core.current(data)
    try:
        with (R/'publish.log').open('wb') as log:
            subprocess.run(core.compose(data, 'compose.release.yml')+['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'],
                cwd=core.ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except Exception:
        with (R/'rollback.log').open('wb') as log:
            subprocess.run(core.compose(data, 'compose.rollback.yml')+['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'],
                cwd=core.ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        core.ready(data['app']['imageId'])
        raise

def rebase():
    data = core.manifest()
    actual = core.docker('exec', core.APP, 'sha256sum', *['/app/'+file for file in core.FILES]).decode().splitlines()
    assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in actual} == data['before'], 'Fulfillment files changed; manual merge required'
    assert {file: core.digest((core.SERVER/file).read_bytes()) for file in core.FILES} == data['workspace']
    suffix = 1
    while R.with_name(R.name+'.rebase-'+str(suffix)).exists(): suffix += 1
    R.rename(R.with_name(R.name+'.rebase-'+str(suffix)))
    prepare()

if __name__ == '__main__':
    {'prepare': prepare, 'preview': preview, 'apply': apply, 'verify': verify, 'rebase': rebase}[sys.argv[1]]()

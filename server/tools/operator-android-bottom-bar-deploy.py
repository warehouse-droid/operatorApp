"""Deploy only the Android viewport workaround over the confirmed camera release."""
import difflib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('packing_release', HERE/'operator-group-packing-deploy.py')
packing = importlib.util.module_from_spec(spec); spec.loader.exec_module(packing)
core = packing.core
R = core.RELEASE = packing.R = Path('/home/ubuntu/operatorapp-deploy-backups/operator-android-bottom-bar-20260930-v1')
core.IMAGE = 'mbbs-operator-app:operator-android-bottom-bar-20260930-v1'
core.ROLLBACK = 'mbbs-operator-app:rollback-android-bottom-bar-20260930-v1'
core.EXISTING = ['public/operator.css', 'public/operator.html', 'public/service-worker.js']
core.ADDED = ['public/operator-viewport.js']
core.FILES = sorted(core.EXISTING + core.ADDED)
ART = core.SERVER/'test-artifacts/operator-android-bottom-bar'
VERSION = '20260930-android-bottom-bar-v1'
verify_runtime = packing.verify

def prepare():
    os.umask(0o077); R.mkdir(parents=True, exist_ok=False); ART.mkdir(parents=True, exist_ok=True)
    state = {'app': core.metadata(core.APP), 'dependencies': [core.metadata(name) for name in core.DEPENDENCIES]}
    assert state['app']['imageId'] == 'sha256:ecaf968189faf470d97e3ec1615974a52ad31d3195b8419e7873aa06654965c8', 'Rebase on current live release'
    packing.extract(core.APP, '/app', ['src', 'public', 'migrations'], R/'baseline')
    shutil.copytree(R/'baseline', R/'candidate')
    patch = ''
    for file in core.FILES:
        old = (R/'baseline'/file).read_text() if (R/'baseline'/file).exists() else ''
        if file in core.ADDED: assert not (R/'baseline'/file).exists()
        new = (core.SERVER/file).read_text()
        patch += ''.join(difflib.unified_diff(old.splitlines(True), new.splitlines(True), fromfile='a/'+file, tofile='b/'+file))
        shutil.copyfile(core.SERVER/file, R/'candidate'/file)
        target = R/'stage'/file; target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(core.SERVER/file, target); target.chmod(0o644)
    (R/'release.patch').write_text(patch)
    before, after = core.files_at(R/'baseline'), core.files_at(R/'candidate')
    assert sorted(file for file in after if after[file] != before.get(file)) == core.FILES
    for file in ['public/operator.js', 'public/operator-inventory.js', 'src/delivery-repository.js']:
        assert before[file] == after[file], 'Camera and packing must remain unchanged'
    state.update({'image': core.IMAGE, 'before': {file: before.get(file) for file in core.FILES},
                  'after': {file: after[file] for file in core.FILES},
                  'workspace': {file: core.digest((core.SERVER/file).read_bytes()) for file in core.FILES},
                  'changedFiles': core.FILES, 'allBefore': before, 'allAfter': after})
    (R/'compose.release.yml').write_text('services:\n  app:\n    image: '+core.IMAGE+'\n')
    (R/'compose.rollback.yml').write_text('services:\n  app:\n    image: '+state['app']['imageId']+'\n')
    shutil.copytree(R/'candidate/public', R/'test-public')
    for folder, names, source in [('quagga2', ['quagga.min.js'], '@ericblade/quagga2/dist'),
                                  ('qr-scanner', ['qr-scanner.min.js', 'qr-scanner-worker.min.js'], 'qr-scanner')]:
        vendor = R/'test-public/vendor'/folder; vendor.mkdir(parents=True, exist_ok=True)
        for name in names:
            (vendor/name).write_bytes(core.docker('exec', core.APP, 'cat', '/app/node_modules/'+source+'/'+name))
    (ART/'repro-live-manifest.json').write_text(json.dumps({'parentImage': state['app']['imageId'], 'files': state['after']}, indent=2))
    core.save('manifest.json', state); core.current(state)
    print(json.dumps({'prepared': True, 'parent': state['app']['image'], 'files': core.FILES}), flush=True)

def run(name, args, *, browser=False, env=None, baseline=False, expected=0):
    cmd = ['sudo', '-n', 'docker', 'run', '--rm', '--network', 'none', '--ipc', 'private',
           '--mount', f'type=bind,src={R},dst=/release',
           '--mount', f'type=bind,src={R / ("baseline" if baseline else "candidate") / "public"},dst=/app/public,readonly',
           '--mount', f'type=bind,src={core.SERVER / "test"},dst=/app/test,readonly',
           '--mount', f'type=bind,src={core.SERVER / "tools"},dst=/app/tools,readonly',
           '--mount', f'type=bind,src={core.SERVER / "test-artifacts"},dst=/app/test-artifacts']
    for key, value in (env or {}).items(): cmd += ['-e', key+'='+value]
    cmd += ['--entrypoint', 'node', 'mbbs-regular-v2:'+('e2e' if browser else 'test'), *args]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    output = result.stdout+result.stderr
    (R/(name+'.log')).write_text(output); (ART/(name+'.log')).write_text(output)
    counts = {key: int(value) for key, value in re.findall(r'^# (tests|pass|fail|skipped) (\d+)$', output, re.M)}
    row = {'name': name, 'exit': result.returncode, **counts, 'failures': re.findall(r'^not ok \d+ - (.+)$', output, re.M)}
    print(json.dumps(row), flush=True)
    assert result.returncode == expected, 'Unexpected result: '+name
    return row

def tests():
    state = core.manifest(); core.current(state)
    suite = 'test/dispatch/frontend/operator-android-bottom-bar.browser.test.mjs'
    rows = [run('baseline-red', ['--test', '--test-name-pattern=retains its working launch height', suite], browser=True, baseline=True, expected=1)]
    rows.append(run('viewport-browser', ['--test', suite], browser=True))
    rows.append(run('native-camera-regression', ['--test', 'test/dispatch/frontend/operator-android-camera-release.browser.test.mjs'],
                    browser=True, env={'OPERATOR_ANDROID_PUBLIC': '/release/test-public'}))
    rows.append(run('windows-camera-regression', ['--test', '--test-name-pattern=native camera is released|Windows mode',
                    'test/dispatch/frontend/operator-camera-rollback.browser.test.mjs'], browser=True))
    rows.append(run('static', ['tools/operator-android-bottom-bar-checks.mjs']))
    rows.append(run('installed-pwa', ['tools/operator-android-bottom-bar-pwa.mjs', 'receipt'], browser=True, env={
        'OPERATOR_CAMERA_REPRO_ROOT': '/release/test-public',
        'OPERATOR_CAMERA_REPRO_ARTIFACTS': 'test-artifacts/operator-android-bottom-bar',
        'OPERATOR_CAMERA_REPRO_UA': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36'}))
    core.current(state)
    core.save('verified.json', {'passed': True, 'imageId': state['candidateImageId'], 'results': rows, 'sourceHashes': state['after']})

def verify():
    verify_runtime()
    state = core.manifest()
    script = '''import assert from 'node:assert/strict';import crypto from 'node:crypto';
for (const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
 for (const [file,expected] of Object.entries(FILES)) {
  const response=await fetch(base+'/'+file.replace(/^public\\//,'')+'?v=VERSION',{cache:'no-store'});
  assert.equal(response.status,200,file);
  assert.equal(crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),expected,file);
 }
}console.log(JSON.stringify({localAndPublicAssetHashesVerified:Object.keys(FILES).length}));'''.replace('FILES', json.dumps(state['after'])).replace('VERSION', VERSION)
    checks = json.loads(core.docker('exec', '-i', core.APP, 'node', '--input-type=module', input=script.encode()))
    result = json.loads((R/'deployment-result.json').read_text()); result.update(checks)
    result.update({'cameraFilesUnchanged': True, 'packingFixPreserved': True, 'physicalTabletVerified': False})
    core.save('deployment-result.json', result)
    for name in ['deployment-result.json', 'verified.json', 'release.patch']:
        shutil.copyfile(R/name, ART/name)
    print(json.dumps(result), flush=True)

packing.verify = verify

if __name__ == '__main__':
    {'prepare': prepare, 'build': core.build, 'test': tests, 'apply': packing.apply, 'verify': verify}[sys.argv[1]]()

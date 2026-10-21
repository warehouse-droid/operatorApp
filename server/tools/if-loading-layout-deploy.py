"""Release the four UI files after isolated browser verification, preserving live services."""
import difflib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('if_layout_scoped_release', HERE/'noninventory-fulfillment-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
core = release.core
core.RELEASE = release.R = core.SERVER/'deployments/if-loading-layout-20260930'
core.IMAGE = 'mbbs-operator-app:if-loading-layout-20260930'
core.ROLLBACK = 'mbbs-operator-app:rollback-if-loading-layout-20260930'
core.EXISTING = core.FILES = ['public/operator.js', 'public/operator.css', 'public/operator.html', 'public/service-worker.js']
core.ADDED = []
release.OUT = core.SERVER/'test-artifacts/if-loading-layout'
base_verify = release.verify


def prepare():
    patch = ''
    for file in core.FILES:
        before = (release.OUT/'before'/file).read_text()
        after = (core.SERVER/file).read_text()
        patch += ''.join(difflib.unified_diff(before.splitlines(True), after.splitlines(True), fromfile='a/'+file, tofile='b/'+file))
    (release.OUT/'release.patch').write_text(patch)
    release.prepare()


def check():
    data = core.manifest()
    core.current(data)
    result = subprocess.run(['sudo', '-n', 'docker', 'run', '--rm', '--network', 'none', '--shm-size=512m',
        '--mount', f'type=bind,src={release.R/"candidate/public"},dst=/app/public,readonly',
        '--mount', f'type=bind,src={HERE},dst=/app/tools,readonly',
        '--mount', f'type=bind,src={release.OUT},dst=/app/test-artifacts/if-loading-layout',
        '-e', 'IF_LAYOUT_LABEL=candidate', '--entrypoint', 'node', 'mbbs-regular-v2:e2e', 'tools/if-loading-layout-browser.mjs'],
        cwd=core.SERVER, capture_output=True, text=True, timeout=90)
    (release.R/'browser.log').write_text(result.stdout+result.stderr)
    assert result.returncode == 0, 'Browser checks failed; see browser.log'
    browser = json.loads((release.OUT/'candidate.json').read_text())
    assert browser['sourceHashes'] == data['after'] and browser['scenarios'] >= 42 and not browser['failures']
    for file in ['public/operator.js', 'public/service-worker.js']:
        core.docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', core.IMAGE, '--check', file)
    unit = core.docker('run', '--rm', '--network', 'none',
        '--mount', f'type=bind,src={core.SERVER/"test"},dst=/app/test,readonly',
        '--entrypoint', 'node', core.IMAGE, '--test', 'test/mbt/unit/operator-netsuite-posting-ui.red.test.js').decode()
    (release.R/'posting-ui.log').write_text(unit)
    assert '# pass 5' in unit and '# fail 0' in unit
    core.current(data)
    (release.OUT/'verified-hashes.json').write_text(json.dumps(data['after'], indent=2)+'\n')
    # The shared release requires a recorded preflight; this UI preflight performs no NetSuite calls.
    preview = {'kind': 'isolated-browser', 'scenarios': browser['scenarios'], 'layoutFailures': 0,
               'postingUiTestsPassed': 5, 'netSuitePosts': 0, 'sourceHashes': data['after']}
    core.save('preview.json', preview)
    print(json.dumps(preview), flush=True)


def verify():
    base_verify()
    data = core.manifest()
    script = """import assert from 'node:assert/strict'; import crypto from 'node:crypto';
const assets = ASSETS;
for (const base of ['http://127.0.0.1:3000', 'https://test.mbbsoperation.com']) {
  for (const [file, expected] of Object.entries(assets)) {
    const asset = file.replace(/^public\\//, '');
    const version = ['operator.js', 'operator.css'].includes(asset) ? '?v=20260930-if-loading-layout-v1' : '';
    const response = await fetch(base+'/'+asset+version, {headers: {'Cache-Control': 'no-cache'}});
    assert.equal(response.status, 200, asset);
    assert.equal(crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'), expected, asset);
  }
}
console.log(JSON.stringify({publicAssetsVerified:4, localAssetsVerified:4, cacheVersion:'20260930-if-loading-layout-v1'}));
""".replace('ASSETS', json.dumps(data['after']))
    assets = json.loads(core.docker('exec', '-i', core.APP, 'node', '--input-type=module', input=script.encode()))
    result = json.loads((release.R/'result.json').read_text())
    result.update(assets)
    core.save('result.json', result)
    print(json.dumps(assets), flush=True)


release.verify = verify


if __name__ == '__main__':
    {'prepare': prepare, 'check': check, 'apply': release.apply, 'verify': verify, 'rebase': release.rebase}[sys.argv[1]]()

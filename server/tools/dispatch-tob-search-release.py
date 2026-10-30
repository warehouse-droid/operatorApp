"""Publish only the verified Dispatch search delta, with app-only rollback."""
import datetime
import difflib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

sys.dont_write_bytecode = True
SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('search_release_core', SERVER / 'tools/dispatch-source-save-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE = SERVER / 'deployments/dispatch-tob-search-20261028'
release.FILES = json.loads((SERVER / 'tools/dispatch-tob-search-files.json').read_text())
release.EXISTING = [name for name in release.FILES if name != 'src/dispatch-order-pool-sql.js']
release.IMAGE = 'mbbs-operator-app:dispatch-search-20261028'
release.ROLLBACK = 'mbbs-operator-app:rollback-dispatch-search-20261028'


def prepare():
    proof = json.loads((SERVER / 'test/dispatch-tob-search-fix-evidence.json').read_text())
    browser = json.loads((SERVER / 'test/dispatch-tob-search-browser-20261028.json').read_text())
    parity = json.loads((release.RELEASE / 'live-parity.json').read_text())
    assert proof['passed'] and parity['identical'], 'Passing checks and live data parity required'
    assert browser['sourceSha256'] == proof['files']['public/dispatch.js'], 'Browser source differs from verified code'
    assert len(browser['scenarios']) == 6 and all(not row['result']['error'] for row in browser['scenarios'])
    stage = release.RELEASE / 'candidate'
    stage.mkdir(exist_ok=True)
    patch = ''
    for name in release.FILES:
        target = stage / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((SERVER / name).read_bytes())
        assert release.digest(target) == proof['files'][name], 'Code changed since checks: ' + name
        baseline = release.RELEASE / 'live-before' / name
        old = baseline.read_text() if baseline.exists() else ''
        patch += ''.join(difflib.unified_diff(old.splitlines(True), target.read_text().splitlines(True),
                                            fromfile='a/' + name, tofile='b/' + name))
    (release.RELEASE / 'release.patch').write_text(patch)
    release.save('verified.json', proof)
    release.save('browser-verified.json', browser)
    info = {'app': release.core.metadata(release.APP), 'dependencies': [release.core.metadata(name) for name in release.DEPENDENCIES], 'files': proof['files']}
    assert info['app']['imageId'] == proof['baseImage'], 'Live image changed; rerun verification'
    release.current(info)
    rows = release.docker('exec', release.APP, 'sha256sum', *['/app/' + name for name in release.EXISTING]).decode().splitlines()
    assert {row.split()[1].removeprefix('/app/'): row.split()[0] for row in rows} == {
        name: release.digest(release.RELEASE / 'live-before' / name) for name in release.EXISTING}, 'Live source changed'
    release.docker('tag', info['app']['imageId'], release.ROLLBACK)
    (stage / 'Dockerfile').write_text('FROM ' + release.ROLLBACK + '\n' + ''.join(
        'COPY --chown=node:node ' + name + ' /app/' + name + '\n' for name in release.FILES))
    with (release.RELEASE / 'build.log').open('wb') as output:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network=none', '--pull=false', '-t', release.IMAGE, str(stage)],
                       stdout=output, stderr=subprocess.STDOUT, check=True)
    info['imageId'] = release.docker('image', 'inspect', '--format', '{{.Id}}', release.IMAGE).decode().strip()
    for name, image in [('compose.release.yml', release.IMAGE), ('compose.rollback.yml', release.ROLLBACK)]:
        (release.RELEASE / name).write_text('services:\n  app:\n    image: ' + image + '\n')
    release.save('manifest.json', info)
    release.current(info)
    print(json.dumps({'prepared': True, 'baseImage': proof['baseImage'], 'imageId': info['imageId'], 'files': release.FILES}), flush=True)


def verify():
    info = release.state()
    release.core.ready(info['imageId'])
    assert release.core.metadata(release.APP)['configuration'] == info['app']['configuration'], 'App configuration changed'
    assert [release.core.metadata(name) for name in release.DEPENDENCIES] == info['dependencies'], 'Dependency changed'
    rows = release.docker('exec', release.APP, 'sha256sum', *['/app/' + name for name in release.FILES]).decode().splitlines()
    assert {row.split()[1].removeprefix('/app/'): row.split()[0] for row in rows} == info['files']
    script = r'''
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
for (const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
 const health=await fetch(base+'/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
 for(const [file,expected] of Object.entries(FILES)) {
  const response=await fetch(base+'/'+file.replace('public/','')+'?v=20261028-search-consistency');assert.equal(response.status,200);
  assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),expected);
 }
 assert.equal((await fetch(base+'/api/dispatch/v2/order-pool?search=TOB0126')).status,401);
}
console.log(JSON.stringify({health:200,assets:'verified',anonymousSearch:401}));
'''.replace('FILES', json.dumps({name: digest for name, digest in info['files'].items() if name.startswith('public/')}))
    result = json.loads(release.docker('exec', '-i', release.APP, 'node', '--input-type=module', input=script.encode()))
    profile = (SERVER / 'tools/dispatch-tob-search-profile.mjs').read_bytes()
    search = json.loads(release.docker('exec', '-i', '-w', '/app/tools', release.APP, 'node', '--input-type=module', input=profile))
    assert sorted(row['id'] for row in search['orders']) == ['TOB0126' + str(i) for i in range(10)], 'Live search results differ'
    release.save('live-search.json', search)
    result.update({'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'imageId': info['imageId'],
                   'configurationPreserved': True, 'dependenciesUnchanged': True, 'searchMs': search['ms'], 'searchCount': search['count']})
    release.save('deployment-result.json', result)
    print(json.dumps(result), flush=True)


release.verify = verify
if __name__ == '__main__':
    {'prepare': prepare, 'apply': release.apply, 'verify': verify}[sys.argv[1]]()

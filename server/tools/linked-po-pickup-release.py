"""Publish the verified linked-PO feed correction over the captured live image."""
import datetime
import difflib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('linked_po_release', SERVER / 'tools/dispatch-source-save-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE = SERVER / 'deployments/linked-po-pickup-20261028'
release.FILES = json.loads((SERVER / 'tools/linked-po-pickup-files.json').read_text())
release.EXISTING = release.FILES
release.IMAGE = 'mbbs-operator-app:linked-po-pickup-20261028'
release.ROLLBACK = 'mbbs-operator-app:rollback-linked-po-pickup-20261028'
source_spec = importlib.util.spec_from_file_location('linked_po_source', SERVER / 'tools/linked-po-pickup-source.py')
scoped = importlib.util.module_from_spec(source_spec)
source_spec.loader.exec_module(scoped)


def prepare():
    proof = json.loads((SERVER / 'test/linked-po-pickup-20261028-evidence.json').read_text())
    assert proof['passed'], 'Passing isolated verification required'
    stage = release.RELEASE / 'candidate'
    stage.mkdir(exist_ok=True)
    patch = ''
    for file in release.FILES:
        target = stage / file
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(scoped.candidate_source(SERVER, file, (release.RELEASE / 'live-before' / file).read_text()))
        assert release.digest(target) == proof['files'][file], 'Source changed after tests: ' + file
        patch += ''.join(difflib.unified_diff((release.RELEASE / 'live-before' / file).read_text().splitlines(True), target.read_text().splitlines(True), fromfile='a/' + file, tofile='b/' + file))
    (release.RELEASE / 'release.patch').write_text(patch)
    release.save('verified.json', proof)
    info = {'app': release.core.metadata(release.APP), 'dependencies': [release.core.metadata(name) for name in release.DEPENDENCIES], 'files': proof['files']}
    assert info['app']['imageId'] == proof['baseImage'], 'Live image changed; rerun validation'
    release.current(info)
    rows = release.docker('exec', release.APP, 'sha256sum', *['/app/' + name for name in release.FILES]).decode().splitlines()
    assert {row.split()[1].removeprefix('/app/'): row.split()[0] for row in rows} == {name: release.digest(release.RELEASE / 'live-before' / name) for name in release.FILES}, 'Live source changed'
    release.docker('tag', info['app']['imageId'], release.ROLLBACK)
    (stage / 'Dockerfile').write_text('FROM ' + release.ROLLBACK + '\n' + ''.join('COPY --chown=node:node ' + name + ' /app/' + name + '\n' for name in release.FILES))
    with (release.RELEASE / 'build.log').open('wb') as output:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network=none', '--pull=false', '-t', release.IMAGE, str(stage)], stdout=output, stderr=subprocess.STDOUT, check=True)
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
    script = r"""
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
 const health=await fetch(base+'/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
 for(const [file,expected] of Object.entries(FILES)) {
  const response=await fetch(base+'/'+file.replace('public/','')+'?v=20261028-linked-po-pickup');
  assert.equal(response.status,200);assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),expected);
 }
}
console.log(JSON.stringify({health:200,assets:'verified'}));
"""
    result = json.loads(release.docker('exec', '-i', release.APP, 'node', '--input-type=module', input=script.replace('FILES', json.dumps({file: digest for file, digest in info['files'].items() if file.startswith('public/')})).encode()))
    result.update({'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'imageId': info['imageId'], 'configurationPreserved': True, 'dependenciesUnchanged': True})
    release.save('deployment-result.json', result)
    print(json.dumps(result), flush=True)


def repair(apply=False):
    source = (SERVER / 'tools/linked-po-pickup-repair.mjs').read_text().replace("'../src/", "'./src/")
    if apply:
        preview = json.loads((release.RELEASE / 'repair-preview.json').read_text())
        revision = preview.get('beforeRevision', preview.get('revision'))
    else:
        revision = None
    invocation = "\nimport {closeDb} from './src/db.js';\ntry {console.log(JSON.stringify(await repairLinkedPoPickup(OPTIONS)));} finally {await closeDb();}\n"
    result = json.loads(release.docker('exec', '-i', release.APP, 'node', '--input-type=module', input=(source + invocation.replace('OPTIONS', json.dumps({'apply': apply, 'expectedRevision': revision}))).encode()))
    release.save('repair-result.json' if apply else 'repair-preview.json', result)
    print(json.dumps(result), flush=True)


def repair_feed(apply=False):
    source = (SERVER / 'tools/linked-po-pickup-repair.mjs').read_text().replace("'../src/", "'./src/")
    invocation = "\nimport {closeDb} from './src/db.js';\ntry {console.log(JSON.stringify(await repairLinkedPoFeedDefinitions(OPTIONS)));} finally {await closeDb();}\n"
    result = json.loads(release.docker('exec', '-i', release.APP, 'node', '--input-type=module', input=(source + invocation.replace('OPTIONS', json.dumps({'apply': apply}))).encode()))
    release.save('feed-repair-result.json' if apply else 'feed-repair-preview.json', result)
    print(json.dumps(result), flush=True)


release.verify = verify
if __name__ == '__main__':
    {'prepare': prepare, 'apply': release.apply, 'verify': verify, 'preview-repair': repair, 'repair': lambda: repair(True), 'preview-feed': repair_feed, 'repair-feed': lambda: repair_feed(True)}[sys.argv[1]]()

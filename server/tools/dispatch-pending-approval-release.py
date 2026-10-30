"""Release only the validated Dispatch pending-approval explanation."""
import datetime
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('guarded_release', SERVER / 'tools/dispatch-source-save-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE = SERVER / 'deployments/dispatch-pending-approval-20261027'
release.FILES = ['src/dispatch-repository.js', 'src/server.js']
release.EXISTING = release.FILES
release.IMAGE = 'mbbs-operator-app:dispatch-pending-approval-20261027'
release.ROLLBACK = 'mbbs-operator-app:rollback-dispatch-pending-approval-20261027'


def prepare():
    proof = json.loads((release.RELEASE / 'verified.json').read_text())
    assert proof['passed'], 'Passing isolated checks are required'
    info = {'app': release.core.metadata(release.APP),
            'dependencies': [release.core.metadata(name) for name in release.DEPENDENCIES],
            'files': proof['files']}
    assert info['app']['imageId'] == proof['baseImage'], 'Live image changed; rerun checks against it'
    release.current(info)
    live = release.docker('exec', release.APP, 'sha256sum', *['/app/' + name for name in release.FILES]).decode().splitlines()
    assert {row.split()[1].removeprefix('/app/'): row.split()[0] for row in live} == {
        name: release.digest(release.RELEASE / 'live-before' / name) for name in release.FILES}, 'Live source changed'
    release.docker('tag', info['app']['imageId'], release.ROLLBACK)
    stage = release.RELEASE / 'candidate'
    (stage / 'Dockerfile').write_text('FROM ' + release.ROLLBACK + '\n' + ''.join(
        'COPY --chown=node:node ' + name + ' /app/' + name + '\n' for name in release.FILES))
    with (release.RELEASE / 'build.log').open('wb') as output:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network=none', '--pull=false',
                        '-t', release.IMAGE, str(stage)], stdout=output, stderr=subprocess.STDOUT, check=True)
    info['imageId'] = release.docker('image', 'inspect', '--format', '{{.Id}}', release.IMAGE).decode().strip()
    for name, image in [('compose.release.yml', release.IMAGE), ('compose.rollback.yml', release.ROLLBACK)]:
        (release.RELEASE / name).write_text('services:\n  app:\n    image: ' + image + '\n')
    release.save('manifest.json', info)
    release.current(info)
    print(json.dumps({'prepared': True, 'baseImage': info['app']['imageId'], 'imageId': info['imageId'], 'files': release.FILES}))


def verify():
    info = release.state()
    release.core.ready(info['imageId'])
    assert release.core.metadata(release.APP)['configuration'] == info['app']['configuration'], 'App configuration changed'
    assert [release.core.metadata(name) for name in release.DEPENDENCIES] == info['dependencies'], 'Dependency changed'
    rows = release.docker('exec', release.APP, 'sha256sum', *['/app/' + name for name in release.FILES]).decode().splitlines()
    assert {row.split()[1].removeprefix('/app/'): row.split()[0] for row in rows} == info['files']
    script = r"""
import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from './src/db.js';
import {app} from './src/server.js';
try {
 const result=await withTransaction(async()=>{
  await query('SET TRANSACTION READ ONLY');
  await query("SET LOCAL statement_timeout='15s'");
  const source=(await query("SELECT tranid,status,status_text FROM sales_orders WHERE tranid='SOR00264'")).rows[0];
  const handler=app._router.stack.find(layer=>layer.route?.path==='/api/dispatch/v2/order-feed/:id').route.stack[0].handle;
  let status=200,payload;
  const response={setHeader(){},status(value){status=value;return this;},json(value){payload=value;return this;}};
  await handler({params:{id:'SOR00264'},query:{fresh:'true'}},response,error=>{throw error;});
  if(source.status==='A') {
   assert.equal(status,409); assert.equal(payload.code,'DISPATCH_ORDER_PENDING_APPROVAL');
   assert.match(payload.error,/pending approval in NetSuite/);
  } else { assert.equal(status,200); assert.equal(payload.order.id,'SOR00264'); }
  return {orderRef:'SOR00264',sourceStatus:source.status_text,httpStatus:status,
   code:payload.code||'OK',message:payload.error||'Details available',readOnly:true};
 });
 const health=await fetch('http://127.0.0.1:3000/health');
 assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
 console.log(JSON.stringify({...result,health:200}));
} finally {await closeDb();}
"""
    checked = json.loads(release.docker('exec', '-i', release.APP, 'node', '--input-type=module', input=script.encode()))
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'imageId': info['imageId'], 'files': info['files'], 'configurationPreserved': True,
              'dependenciesUnchanged': True, **checked}
    release.save('deployment-result.json', result)
    print(json.dumps(result), flush=True)


release.verify = verify
if __name__ == '__main__':
    {'prepare': prepare, 'apply': release.apply, 'verify': verify}[sys.argv[1]]()

"""Release only the Receiving display filter and its Operator cache version."""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('receiving_display_release', SERVER / 'tools/aggregate-access-deploy.py')
access = importlib.util.module_from_spec(spec)
spec.loader.exec_module(access)
release, core = access.release, access.core
CHECKS = SERVER / 'test-artifacts/receiving-deleted-lines'
VERSION = '20260922-receiving-active-lines-v1'
FILES = ['public/operator.html', 'public/operator.js', 'public/service-worker.js']
for module in [access, release, core]:
    for key, value in {'RELEASE': SERVER / 'test-artifacts/receiving-deleted-lines-deployment-20260922',
        'IMAGE': 'mbbs-operator-app:receiving-active-lines-20260922-v1',
        'ROLLBACK': 'mbbs-operator-app:rollback-receiving-active-lines-20260922-v1',
        'FILES': FILES, 'EXISTING': FILES, 'ADDED': []}.items():
        setattr(module, key, value)
core.BEFORE = CHECKS / 'before'


def source_gate(require_full=True):
    hashes = {name: core.digest((SERVER / name).read_bytes()) for name in FILES}
    return core.digest(json.dumps(hashes, sort_keys=True).encode())


def shell_assets(name, content):
    content, count = re.subn(r'/operator\.js\?v=[^"\s]+', '/operator.js?v=' + VERSION, content)
    assert count == 1
    if name.endswith('service-worker.js'):
        content, count = re.subn(r'const CACHE_NAME = "[^"]+";',
            'const CACHE_NAME = "mbbs-yard-operator-' + VERSION + '";', content)
        assert count == 1
    return content


def check():
    state = core.manifest()
    core.current(state)
    root = release.RELEASE / 'candidate'
    commands = {
        'syntax.log': ['sh', '-c', 'node --check public/operator.js && node --check public/service-worker.js'],
        'quantity-and-receipt.log': ['node', '--test',
            'test/mbt/unit/operator-receiving-quantity-ui.test.js',
            'test/mbt/unit/receiving-followup-progress.test.js',
            'test/mbt/unit/operator-receiving-return.test.js',
            'test/mbt/unit/driver-pwa-recovery-assets.test.js'],
        'page-confirm.log': ['node', '--test', '--test-name-pattern=Customer Pickup reuses|PO Receiving exposes|server exposes',
            'test/mbt/unit/operator-page-confirm-ui.contract.test.js'],
        'browser.log': ['node', '/app/tools/receiving-deleted-lines-browser.mjs']
    }
    for log, command in commands.items():
        args = ['sudo', '-n', 'docker', 'run', '--rm', '--network', 'none', '--read-only',
            '--tmpfs', '/tmp:mode=1777', '-e', 'PLAYWRIGHT_BROWSERS_PATH=/ms-playwright',
            '-v', str(root / 'public') + ':/app/public:ro',
            '-v', str(root / 'src') + ':/app/src:ro',
            '-v', str(SERVER / 'test') + ':/app/test:ro',
            '-v', str(SERVER / 'tools') + ':/app/tools:ro',
            '-v', str(CHECKS) + ':/app/test-artifacts/receiving-deleted-lines:ro',
            '-w', '/app', '--entrypoint', command[0], 'field-sales-check-2941306:latest', *command[1:]]
        with (release.RELEASE / log).open('wb') as output:
            subprocess.run(args, stdout=output, stderr=subprocess.STDOUT, check=True)
        print(json.dumps({'passed': log}), flush=True)
    core.current(state)
    core.save('candidate-checks.json', {'passed': True, 'imageId': state['candidateImageId'], 'sources': state['after']})


def no_migration():
    core.save('migration-check.json', {'required': False, 'operationalDataChanged': False})


def verify():
    state = core.manifest()
    core.ready(state['candidateImageId'])
    current = core.metadata(core.APP)
    assert current['configuration'] == state['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == state['dependencies']
    actual = core.docker('exec', core.APP, 'sha256sum', *['/app/' + name for name in FILES]).decode().splitlines()
    assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in actual} == state['after']
    script = '''import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { getReceivingOrder } from '/app/src/receiving-repository.js';
import { closeDb } from '/app/src/db.js';
const assets = ASSETS;
try {
 for (const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
  const health=await fetch(base+'/health'); assert.equal(health.status,200); assert.equal((await health.json()).ok,true);
  for (const [name,sha] of Object.entries(assets)) {
   const response=await fetch(base+'/'+name.replace('public/',''),{headers:{'Cache-Control':'no-cache'}});
   assert.equal(response.status,200,name);
   assert.equal(crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),sha,name);
  }
 }
 const source=readFileSync('/app/public/operator.js','utf8'), context=vm.createContext({});
 for (const name of ['qty','receivingRemainingSalesQty','hasReceivingRemainingQty']) {
  const start=source.indexOf('function '+name+'('), end=source.indexOf('\\n}',start)+2;
  assert.ok(start>=0 && end>start);
  new vm.Script(source.slice(start,end)).runInContext(context);
 }
 const order=await getReceivingOrder(990616);
 const visible=order.lines.filter(line=>context.hasReceivingRemainingQty(line));
 const inactive=order.lines.filter(line=>line.netsuite_active===false || line.sync_exception==='line_deleted');
 assert.ok(inactive.length>0);
 assert.ok(inactive.every(line=>!visible.includes(line)));
 assert.ok(visible.every(line=>line.netsuite_active!==false && line.sync_exception!=='line_deleted'));
 console.log(JSON.stringify({health:200,assetHashesVerified:6,order:order.tranid,hiddenRemovedLines:inactive.length,openLines:visible.length}));
} finally { await closeDb(); }
'''.replace('ASSETS', json.dumps(state['after']))
    probes = json.loads(core.docker('exec', '-i', core.APP, 'node', '--input-type=module', input=script.encode()))
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'image': release.IMAGE, 'imageId': current['imageId'], 'runtimeFilesVerified': len(FILES),
        'configurationPreserved': True, 'otherServicesUnchanged': True, 'checks': probes}
    core.save('deployment-result.json', result)
    print(json.dumps(result), flush=True)


access.source_gate = source_gate
access.shell_assets = shell_assets
release.source_gate = source_gate
release.backup_and_migrate = no_migration
release.verify = verify
if __name__ == '__main__':
    os.umask(0o077)
    {'prepare': access.prepare, 'build': release.build, 'check': check, 'apply': release.apply, 'verify': verify}[sys.argv[1]]()

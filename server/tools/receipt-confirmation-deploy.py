"""Build and release only the receipt recovery change over the running image."""
import datetime
import difflib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('receipt_release', SERVER / 'tools/receiving-posting-status-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
core = release.core
CHECKS = SERVER / 'test-artifacts/receipt-confirmation'
core.RELEASE = CHECKS / 'release'
core.BEFORE = CHECKS / 'before'
core.EXISTING = ['public/operator.html', 'public/operator.js', 'public/service-worker.js', 'src/server.js']
core.ADDED = ['src/operator-receipt-recovery.js']
core.FILES = sorted(core.EXISTING + core.ADDED)
core.IMAGE = 'mbbs-operator-app:receipt-confirmation-20260925-v1'
core.ROLLBACK = 'mbbs-operator-app:rollback-receipt-confirmation-20260925-v1'
VERSION = '20260925-receipt-confirmation-v1'
release.CHECKS = CHECKS


# Keep captured files owned by the workspace user. Docker access is granted by
# the execution environment; sudo here would make a private capture unreadable.
def docker(*args, **kwargs):
    return subprocess.check_output(['docker', *args], **kwargs)


core.docker = docker


def shell_assets(file, text):
    text, count = re.subn(r'/operator\.js\?v=[^"\s]+', '/operator.js?v=' + VERSION, text)
    assert count == 1
    if file.endswith('service-worker.js'):
        text, count = re.subn(r'const CACHE_NAME = "[^"]+";', 'const CACHE_NAME = "mbbs-yard-operator-' + VERSION + '";', text)
        assert count == 1
    return text


core.shell_assets = shell_assets


def incident():
    # Read only: the original completed command, exact order claim, and receipt.
    return json.loads(core.database("""BEGIN READ ONLY;
      SELECT json_build_object('orderId', p.netsuite_id::text, 'orderRef',p.tranid,
        'receiptId',p.last_item_receipt_id::text,'receiptRef',p.last_item_receipt_tranid,
        'commandId',c.id,'status',c.status,
        'commands',(SELECT count(*) FROM operator_netsuite_posting_order_claims WHERE local_order_key='receiving:purchase_order:-185021706058979'),
        'steps',(SELECT count(*) FROM operator_netsuite_posting_steps WHERE command_id=c.id))
      FROM purchase_orders p CROSS JOIN operator_netsuite_posting_commands c
      WHERE p.netsuite_id=-185021706058979 AND c.id='ee1aa1bb-8673-40d6-a807-1ddfa768588a';
      COMMIT;""").strip().removeprefix('BEGIN\n').removesuffix('\nCOMMIT'))


def prepare():
    core.RELEASE.mkdir(parents=True, exist_ok=False)
    state = {'app': core.metadata(core.APP), 'dependencies': [core.metadata(name) for name in core.DEPENDENCIES]}
    baseline = core.RELEASE / 'baseline'
    baseline.mkdir()
    for folder in ['src', 'public', 'migrations']:
        core.docker('cp', core.APP + ':/app/' + folder, str(baseline / folder))
    for file in ['package.json', 'package-lock.json']:
        core.docker('cp', core.APP + ':/app/' + file, str(baseline / file))
    assert core.metadata(core.APP) == state['app']
    candidate = core.RELEASE / 'candidate'
    shutil.copytree(baseline, candidate)
    patch = ''
    for file in core.EXISTING:
        if file in ['public/operator.html', 'public/service-worker.js']:
            old = (baseline / file).read_text()
            new = shell_assets(file, old)
        elif file == 'src/server.js':
            # The live image does not yet have unrelated priority middleware.
            # Add the router after the live authentication/yard guard verbatim.
            old = (baseline / file).read_text()
            new = old
            anchors = [
                ('import { startOperatorNetSuitePostingRuntime } from "./operator-netsuite-posting-runtime.js";',
                 'import { createOperatorReceiptRecoveryRouter } from "./operator-receipt-recovery.js";'),
                ('app.use("/api/receiving", requireOperator, requireOperatorAccess, requireOperatorYardRequest);',
                 'app.use("/api/receiving", createOperatorReceiptRecoveryRouter());')]
            for anchor, addition in anchors:
                assert new.count(anchor) == 1 and addition not in new
                new = new.replace(anchor, anchor + '\n' + addition)
        else:
            old, new = (core.BEFORE / file).read_text(), (SERVER / file).read_text()
        patch += ''.join(difflib.unified_diff(old.splitlines(True), new.splitlines(True), fromfile='a/' + file, tofile='b/' + file))
    (core.RELEASE / 'release.patch').write_text(patch)
    result = subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-d', str(candidate)], input=patch, text=True, capture_output=True)
    (core.RELEASE / 'patch.log').write_text(result.stdout + result.stderr)
    assert result.returncode == 0, 'Release patch requires review'
    for file in core.ADDED:
        assert not (baseline / file).exists()
        shutil.copy2(SERVER / file, candidate / file)
    for file in candidate.rglob('*.orig'):
        file.unlink()
    before, after = core.files_at(baseline), core.files_at(candidate)
    changed = sorted(file for file in after if after[file] != before.get(file))
    assert changed == core.FILES
    state.update({'image': core.IMAGE, 'before': {file: before.get(file) for file in core.FILES},
                  'after': {file: after[file] for file in core.FILES},
                  'workspace': {file: core.digest((SERVER / file).read_bytes()) for file in core.FILES}, 'changedFiles': changed})
    for file in core.FILES:
        target = core.RELEASE / 'stage' / file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(candidate / file, target)
    (core.RELEASE / 'compose.release.yml').write_text('services:\n  app:\n    image: ' + core.IMAGE + '\n')
    (core.RELEASE / 'compose.rollback.yml').write_text('services:\n  app:\n    image: ' + state['app']['imageId'] + '\n')
    core.save('manifest.json', state)
    core.save('incident-before.json', incident())
    print(json.dumps({'prepared': True, 'changedFiles': changed, 'baseImage': state['app']['imageId']}))


def verify():
    state = core.manifest()
    core.ready(state['candidateImageId'])
    current = core.metadata(core.APP)
    assert current['configuration'] == state['app']['configuration'], 'Runtime configuration changed'
    assert [core.metadata(name) for name in core.DEPENDENCIES] == state['dependencies'], 'Other services changed'
    actual = core.docker('exec', core.APP, 'sha256sum', *['/app/' + file for file in core.FILES]).decode().splitlines()
    assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in actual} == state['after']
    public = {file: value for file, value in state['after'].items() if file.startswith('public/')}
    script = """import assert from 'node:assert/strict'; import crypto from 'node:crypto';
import {query,withTransaction,closeDb} from './src/db.js';
import {readOperatorReceiptRecovery} from './src/operator-receipt-recovery.js';
for (const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
  for (const [file,expected] of Object.entries(FILES)) {
    const r=await fetch(base+'/'+file.replace('public/',''),{headers:{'Cache-Control':'no-cache'}});
    assert.equal(r.status,200); assert.equal(crypto.createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex'),expected);
  }
  const health=await fetch(base+'/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
  assert.equal((await fetch(base+'/api/receiving/orders/-185021706058979/posting-status?locationId=1')).status,401);
}
try {
  await withTransaction(async()=>{
    await query('SET TRANSACTION READ ONLY');
    const {rows:[command]}=await query("SELECT actor_operator_id FROM operator_netsuite_posting_commands WHERE id='ee1aa1bb-8673-40d6-a807-1ddfa768588a'");
    const recovered=await readOperatorReceiptRecovery({operatorId:command.actor_operator_id,
      order:{netsuite_id:'-185021706058979',order_type:'purchase_order',tranid:'SN1401278',destination_location_id:1},locationId:1});
    assert.equal(recovered.job.id,'ee1aa1bb-8673-40d6-a807-1ddfa768588a');
    assert.equal(recovered.job.result.localFinalization.itemReceiptTranid,'IR14813');
  },{rollback:true});
}finally{await closeDb();}
console.log(JSON.stringify({localHealth:200,publicHealth:200,publicAssetsVerified:3,anonymousReceiptLookup:401,readOnlyReceipt:'IR14813'}));
""".replace('FILES', json.dumps(public))
    probes = json.loads(core.docker('exec', '-i', core.APP, 'node', '--input-type=module', input=script.encode()))
    assert incident() == json.loads((core.RELEASE / 'incident-before.json').read_text()), 'Incident receipt records changed'
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'imageId': current['imageId'], 'files': core.FILES, 'configurationPreserved': True,
              'otherServicesUnchanged': True, 'incidentRecordsUnchanged': True, **probes}
    core.save('deployment-result.json', result)
    print(json.dumps(result))


release.verify = verify

if __name__ == '__main__':
    os.umask(0o077)
    {'prepare': prepare, 'build': core.build, 'validate': release.validate, 'apply': release.apply, 'verify': verify}[sys.argv[1]]()

"""Scoped whole-order delivery instruction completion fix."""
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('release_helpers', SERVER / 'tools/delivery-scm-release.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
r.RELEASE = SERVER / 'deployments/delivery-instruction-split-20261019'
r.IMAGE = 'mbbs-operator-app:delivery-instruction-split-20261019'
r.ROLLBACK = r.IMAGE + '-rollback'
r.READ_NAME = 'mbbs-delivery-instruction-split-reader'
r.CHECK_NAME = 'mbbs-delivery-instruction-split-check'
FILES = ['src/delivery-instruction-repository.js']

def capture():
    r.RELEASE.mkdir(parents=True, exist_ok=False)
    before = r.metadata(r.APP)
    dependencies = [r.metadata(n) for n in r.DEPENDENCIES]
    target = r.RELEASE / 'before'
    target.mkdir()
    archive = r.docker('exec', r.APP, 'tar', '-cf', '-', '-C', '/app', 'src', 'public', 'migrations', 'package.json', 'package-lock.json')
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(target, filter='data')
    for p in target.rglob('*'):
        p.chmod(p.stat().st_mode | (0o055 if p.is_dir() else 0o044))
    assert r.metadata(r.APP) == before
    shutil.copytree(target, r.RELEASE / 'candidate')
    workspace = r.RELEASE / 'workspace-before'
    for name in FILES:
        p = workspace / name
        p.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SERVER / name, p)
        assert p.read_bytes() == (target / name).read_bytes(), 'Workspace/live differ: ' + name
    r.save('capture.json', {'app': before, 'dependencies': dependencies, 'beforeTree': r.files_at(target), 'capturedAt': r.now()})
    print(json.dumps({'captured': True, 'imageId': before['imageId']}))

def stage():
    data = json.loads((r.RELEASE / 'capture.json').read_text())
    for name in FILES:
        shutil.copy2(SERVER / name, r.RELEASE / 'candidate' / name)
    tree = r.files_at(r.RELEASE / 'candidate')
    changed = sorted(n for n in data['beforeTree'].keys() | tree.keys() if data['beforeTree'].get(n) != tree.get(n))
    assert changed == sorted(FILES), changed
    data.update(files=FILES, candidateTree=tree, candidateTreeHash=r.sha(json.dumps(tree, sort_keys=True).encode()),
                workspace={n: r.sha((SERVER / n).read_bytes()) for n in FILES},
                packages={n: r.sha((r.RELEASE / 'candidate' / n).read_bytes()) for n in ['package.json', 'package-lock.json']})
    r.save('manifest.json', data)
    r.current(data)
    print(json.dumps({'staged': True, 'files': FILES, 'candidateTreeHash': data['candidateTreeHash']}))

def verify():
    data = r.state()
    r.ready(data['candidateImageId'])
    live = r.metadata(r.APP)
    assert live['imageId'] == data['candidateImageId']
    assert live['configuration'] == data['app']['configuration']
    assert [r.metadata(n) for n in r.DEPENDENCIES] == data['dependencies']
    assert json.loads(r.docker('exec', r.APP, 'node', '-e', r.HASH_SCRIPT)) == data['candidateTree']
    readback = live_readback()
    assert all(row['dropoffCompleted'] == readback['allDelivered'] for row in readback['instructions'])
    assert all(row['editable'] == (not readback['allDelivered']) for row in readback['instructions'])
    r.save('deployment-result.json', {'deployed': True, 'at': r.now(), 'imageId': live['imageId'],
        'changedFiles': FILES, 'configurationPreserved': True, 'dependentContainersUnchanged': True})
    print(json.dumps({'deployed': True, 'imageId': live['imageId']}))

def live_readback(filename='live-readback.json'):
    script = """
import { query, withTransaction, closeDb } from './src/db.js';
import { getDeliveryInstruction, listDeliveryInstructionOrders } from './src/delivery-instruction-repository.js';
try {
  const result = await withTransaction(async () => {
    await query('SET TRANSACTION READ ONLY');
    await query("SET LOCAL statement_timeout='10s'");
    const splits = (await query("SELECT split_so_ref FROM dispatch_scm_so_splits WHERE source_so_ref=$1 AND status='active'", ['SOA08854'])).rows;
    const jobs = (await query("SELECT stop_type,status,order_refs FROM driver_job_records WHERE order_refs::text LIKE $1", ['%SOA08854%'])).rows;
    const completed = new Set(jobs.filter(job => job.status === 'complete' && job.stop_type === 'dropoff')
      .flatMap(job => Array.isArray(job.order_refs) ? job.order_refs : []).map(ref => ref.trim().toUpperCase()));
    const targets = splits.length ? splits.map(row => row.split_so_ref) : ['SOA08854'];
    const details = [];
    for (const ref of ['SOA08854', ...splits.map(row => row.split_so_ref)]) {
      details.push(await getDeliveryInstruction(ref));
    }
    const listed = await listDeliveryInstructionOrders({ search: 'SOA08854' });
    return {
      orderRef: 'SOA08854',
      deliveries: targets.map(ref => ({ orderRef: ref, complete: completed.has(ref.toUpperCase()) })),
      allDelivered: targets.every(ref => completed.has(ref.toUpperCase())),
      instructions: [...details, ...listed.filter(row => row.orderRef === 'SOA08854')].map(row => ({
        orderId: row.orderId, orderRef: row.orderRef, revision: row.revision,
        editable: row.editable, dropoffCompleted: row.dropoffCompleted, terminal: row.terminal
      }))
    };
  });
  console.log(JSON.stringify(result));
} finally { await closeDb(); }
"""
    result = json.loads(r.docker('exec', r.APP, 'node', '--input-type=module', '-e', script))
    r.save(filename, result)
    return result

def apply():
    data = r.state()
    r.current(data)
    check = json.loads((r.RELEASE / 'image-check.json').read_text())
    assert check['passed'] and check['imageId'] == data['candidateImageId']
    r.config_check(data)
    r.assert_no_active_operations(r.preflight())
    args = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
    try:
        with (r.RELEASE / 'cutover.log').open('wb') as output:
            subprocess.run(r.compose(data, 'release') + args, cwd=r.ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except BaseException:
        with (r.RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(r.compose(data, 'rollback') + args, cwd=r.ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=60)
        r.ready(data['app']['imageId'])
        raise

if __name__ == '__main__':
    {'capture': capture, 'stage': stage, 'build': r.build, 'apply': apply, 'verify': verify,
     'before': lambda: print(json.dumps(live_readback('live-before.json')))}[sys.argv[1]]()

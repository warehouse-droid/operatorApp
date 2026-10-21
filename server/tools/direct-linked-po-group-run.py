"""Capture and test the split-group fix in its own remote-disabled database."""
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tarfile

SERVER = Path(__file__).resolve().parents[1]
RELEASE = SERVER / 'deployments/direct-linked-po-group-20261002-v2'


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, SERVER / 'tools' / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


runner = load('split_group_test_runner', 'direct-linked-po-lifecycle-run.py')
release = load('split_group_release_core', 'po-status-waitlist-deploy.py')
runner.RELEASE = RELEASE
runner.DATABASE_NAME = 'direct_linked_po_group_20261002'
runner.REMOTE = '/tmp/direct-linked-po-group-20261002-v2'
TEST = 'test/dispatch/integration/direct-linked-po-group-lifecycle.test.js'


def capture():
    RELEASE.mkdir(exist_ok=False)
    before = release.metadata(release.APP)
    target = RELEASE / 'before'
    target.mkdir()
    for name in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']:
        with tarfile.open(fileobj=io.BytesIO(release.docker('cp', release.APP + ':/app/' + name, '-'))) as archive:
            archive.extractall(target, filter='data')
    assert release.metadata(release.APP) == before
    assert json.loads(release.docker('exec', release.APP, 'node', '-e', release.HASH)) == release.files_at(target)
    shutil.copy2(SERVER / 'eslint.mbt.config.js', target)
    shutil.copy2(SERVER / 'deployments/direct-linked-po-lifecycle-20261002/test-database-fixture.sql', RELEASE)
    (RELEASE / 'capture.json').write_text(json.dumps({'before': before,
        'untouched': {name: release.metadata(name) for name in release.UNTOUCHED}}, indent=2) + '\n')
    print(json.dumps({'captured': True, 'image': before['image']}), flush=True)


def baseline():
    runner.sync('before')
    runner.setup(reset=True)
    assert runner.run('baseline-bootstrap', ['node', '--input-type=module', '-e',
        "import{readFile}from'node:fs/promises';import{query,closeDb}from'./src/db.js';try{for(const f of ['253_direct_ship_netsuite_posting.sql','256_direct_linked_po_transport_lifecycle.sql'])await query(await readFile('migrations/'+f,'utf8'));}finally{await closeDb();}"]) == 0
    code = runner.run('baseline-group-red', ['env', 'DIRECT_LINKED_PO_GROUP_BASELINE=1', 'node', '--test', '--test-concurrency=1', TEST], reset_db=False)
    assert code != 0, 'The original group bug must fail the behavior tests'
    print(json.dumps({'observedRed': True}), flush=True)


def stage():
    target = RELEASE / 'candidate'
    shutil.copytree(RELEASE / 'before', target)
    file = 'src/dispatch-repository.js'
    original = (target / file).read_text()
    old = """         AND job.order_refs ?| ARRAY[allocation.sales_order_ref, allocation.dispatch_target_ref]
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(job.order_refs) reference(value)
            WHERE reference.value IN (allocation.sales_order_ref, allocation.dispatch_target_ref)
              AND dispatch_completion_driver_order_kind(reference.value, job.job_details) = 'SO'
         )"""
    assert original.count(old) == 1
    start = original.index('    linked_po_progress AS MATERIALIZED (')
    end = original.index('    fully_linked_po AS MATERIALIZED (',start)
    workspace = (SERVER / file).read_text()
    new_start = workspace.index('    linked_po_allocations AS MATERIALIZED (')
    new_end = workspace.index('    fully_linked_po AS MATERIALIZED (',new_start)
    (target / file).write_text(original[:start]+workspace[new_start:new_end]+original[end:])
    migration_file = 'migrations/257_direct_linked_po_group_completion.sql'
    shutil.copy2(SERVER / migration_file, target / migration_file)
    before, after = release.files_at(RELEASE / 'before'), release.files_at(target)
    assert sorted(file for file in after if after[file] != before.get(file)) == sorted([file,migration_file])
    print(json.dumps({'candidateStaged': True, 'runtimeFiles': 2,
        'workspaceRepositoryMatchesCandidate': (SERVER / file).read_bytes() == (target / file).read_bytes()}), flush=True)


if __name__ == '__main__':
    os.umask(0o077)
    if sys.argv[1] == 'capture': capture()
    elif sys.argv[1] == 'baseline': baseline()
    elif sys.argv[1] == 'stage': stage()
    elif sys.argv[1] == 'sync': runner.sync('candidate')
    else: sys.exit(runner.run(sys.argv[1], sys.argv[2:]))

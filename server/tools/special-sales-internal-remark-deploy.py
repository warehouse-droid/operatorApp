"""Release the Sales-only internal remark as a scoped overlay on the live app."""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('remark_release_core', SERVER / 'tools/special-stock-updates-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE = SERVER / 'deployments/special-sales-internal-remark-20261003'
release.EVIDENCE = SERVER / 'test-artifacts/special-workflow-review/sales-internal-remark-20261003'
release.MIGRATION = '259_special_sales_internal_remark.sql'
release.FILES = json.loads((SERVER / 'tools/special-sales-internal-remark-files.json').read_text())
release.CONTAINERS = {'app': 'mbbs-operator-app-app-1'}
release.DEPENDENCIES.append('mbbs-operator-app-webhook-worker-1')
release.core.RELEASE, release.core.CONTAINERS = release.RELEASE, release.CONTAINERS
docker, database, save, state = release.docker, release.database, release.save, release.state


def capture():
    release.capture()
    data = state()
    data['services']['app']['image'] = 'mbbs-operator-app:special-sales-internal-remark-20261003'
    save('manifest.json', data)


def prepare():
    release.prepare()
    data = state()
    for kind in ['release', 'rollback']:
        image = data['services']['app']['image'] if kind == 'release' else data['services']['app']['before']['imageId']
        (release.RELEASE / ('compose.' + kind + '.yml')).write_text('services:\n  app:\n    image: ' + image + '\n')


def prepare_rollback():
    # Older app versions do not know the new private audit audience. Keep the
    # privacy projection even when rolling back the rest of the feature.
    data = state()
    directory = release.RELEASE / 'rollback-privacy'
    (directory / 'src').mkdir(parents=True, exist_ok=True)
    shutil.copy2(release.RELEASE / 'candidate-app/src/special-stock-request-policy.js', directory / 'src/special-stock-request-policy.js')
    before = data['services']['app']['before']['imageId']
    parent = 'mbbs-operator-app:internal-remark-rollback-base-' + before.split(':')[1][:12]
    docker('tag', before, parent)
    (directory / 'Dockerfile').write_text('FROM ' + parent + '\nCOPY --chown=node:node src/ /app/src/\n')
    image = 'mbbs-operator-app:special-sales-internal-remark-rollback-20261003'
    with (release.RELEASE / 'rollback-build.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', image, str(directory)], stdout=log, stderr=subprocess.STDOUT, check=True)
    data['rollbackImageId'] = docker('image', 'inspect', '--format', '{{.Id}}', image).decode().strip()
    probe = "import assert from 'node:assert/strict';import {projectSpecialStockCase as project} from './src/special-stock-request-policy.js';const d={salesInternalRemark:'PRIVATE',events:[{eventType:'special_sales_internal_remark_updated',details:{after:{salesInternalRemark:'PRIVATE'}}}]};for(const role of ['scm','dispatch','admin'])assert.ok(!JSON.stringify(project(d,role)).includes('PRIVATE'));assert.equal(project(d,'sales').salesInternalRemark,'PRIVATE');process.exit(0);"
    docker('run', '--rm', '--network', 'none', '-e', 'MBBS_ENV_FILE=/nonexistent', '--entrypoint', 'node', image, '--input-type=module', '-e', probe)
    expected = release.core.files_at(release.RELEASE / 'before-app')
    expected['src/special-stock-request-policy.js'] = data['services']['app']['sourceHashes']['src/special-stock-request-policy.js']
    assert json.loads(docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', image, '-e', release.TREE)) == expected
    (release.RELEASE / 'compose.rollback.yml').write_text('services:\n  app:\n    image: ' + data['rollbackImageId'] + '\n')
    save('manifest.json', data)
    print(json.dumps({'rollbackPreservesSalesPrivacy': True}), flush=True)


def sync_checks():
    directory = release.RELEASE / 'checks-app'
    shutil.copytree(release.RELEASE / 'candidate-app', directory, dirs_exist_ok=True)
    for folder in ['test', 'tools']:
        shutil.copytree(SERVER / folder, directory / folder, dirs_exist_ok=True)
    runner, remote = 'mbbs-special-review-runner', '/tmp/special-sales-internal-remark-release-app'
    docker('exec', runner, 'node', '-e', "const f=require('fs');f.rmSync(process.argv[1],{recursive:true,force:true});f.mkdirSync(process.argv[1]);", remote)
    docker('cp', str(directory) + '/.', runner + ':' + remote)
    docker('exec', runner, 'node', '-e', "const f=require('fs');f.symlinkSync('/app/node_modules',process.argv[1]+'/node_modules','dir');f.symlinkSync('/app/test-artifacts',process.argv[1]+'/test-artifacts','dir');", remote)
    print(json.dumps({'candidateChecksSynced': True}), flush=True)


def verify():
    data = state()
    row = data['services']['app']
    release.core.core.ready(row['candidateImageId'])
    current = release.metadata(release.CONTAINERS['app'])
    assert current['imageId'] == row['candidateImageId']
    assert current['configuration'] == row['before']['configuration']
    assert json.loads(docker('exec', release.CONTAINERS['app'], 'node', '-e', release.TREE)) == json.loads((release.RELEASE / 'app-source-tree.json').read_text())
    assert {name: release.metadata(name) for name in release.DEPENDENCIES} == data['dependencies']
    runtime = json.loads(docker('inspect', release.CONTAINERS['app']))[0]
    assert runtime['State']['Running'] and runtime['RestartCount'] == 0
    assert database("SELECT count(*) FROM schema_migrations WHERE filename='" + release.MIGRATION + "'") == '1'
    probe = (SERVER / 'tools/special-sales-internal-remark-live.mjs').read_text().replace('RELEASE_HASHES', json.dumps(row['sourceHashes']))
    checks = json.loads(docker('exec', '-i', release.CONTAINERS['app'], 'node', '--input-type=module', input=probe.encode()))
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'appImage': row['candidateImageId'],
              'configurationAndDependenciesPreserved': True, 'migration': release.MIGRATION, **checks}
    save('result.json', result)
    print(json.dumps(result), flush=True)


def apply():
    os.umask(0o077)
    data = state()
    release.current(data)
    release.validate_checks(data)
    assert data.get('rollbackImageId'), 'Prepare a rollback image that preserves private audit access'
    release.core.config_check(data)
    active = release.active_work()
    save('active-before-release.json', active)
    assert not any(active.values()), 'Wait for active operations: ' + json.dumps(active)
    release.backup_schema()
    release.current(data)
    try:
        if database("SELECT count(*) FROM schema_migrations WHERE filename='" + release.MIGRATION + "'") == '0':
            sql = (release.RELEASE / 'candidate-app/migrations' / release.MIGRATION).read_text()
            output = database("BEGIN ISOLATION LEVEL REPEATABLE READ; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';\n"
                "CREATE TEMP TABLE remark_stage_baseline ON COMMIT DROP AS SELECT * FROM special_stock_workflow_stages;\n" + sql +
                "\nDO $$ BEGIN IF EXISTS(SELECT * FROM remark_stage_baseline EXCEPT SELECT * FROM special_stock_workflow_stages) "
                "OR EXISTS(SELECT * FROM special_stock_workflow_stages EXCEPT SELECT * FROM remark_stage_baseline) "
                "THEN RAISE EXCEPTION 'Workflow stages changed'; END IF; END $$;\n"
                "INSERT INTO schema_migrations(filename) VALUES('" + release.MIGRATION + "'); COMMIT;")
            (release.RELEASE / 'migration.log').write_text(output)
            save('migration-result.json', {'applied': release.MIGRATION, 'transactional': True, 'existingStagesPreserved': True})
        with (release.RELEASE / 'publish.log').open('wb') as log:
            subprocess.run(release.core.compose(data) + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'], cwd=SERVER.parent,
                           stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except Exception:
        with (release.RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(release.core.compose(data, 'compose.rollback.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'],
                           cwd=SERVER.parent, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        release.core.core.ready(data['rollbackImageId'])
        save('rollback-result.json', {'restoredPreviousAppWithPrivacyFilter': True, 'additiveSchemaRetained': True})
        raise


if __name__ == '__main__':
    {'capture': capture, 'stage': release.stage, 'freeze': release.freeze, 'prepare': prepare, 'prepare-rollback': prepare_rollback,
     'sync-checks': sync_checks, 'apply': apply, 'verify': verify}[sys.argv[1]]()

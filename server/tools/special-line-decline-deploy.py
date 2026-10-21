"""Release reversible Sales line declines as a scoped overlay on the live app."""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('corrections_release_core', SERVER / 'tools/special-stock-updates-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE = SERVER / 'deployments/special-line-decline-20261003'
release.EVIDENCE = SERVER / 'test-artifacts/special-workflow-review/line-decline-20261003'
release.MIGRATION = '262_special_line_decline.sql'
release.FILES = json.loads((SERVER / 'tools/special-line-decline-files.json').read_text())
release.CONTAINERS = {'app': 'mbbs-operator-app-app-1'}
release.DEPENDENCIES.append('mbbs-operator-app-webhook-worker-1')
release.core.RELEASE, release.core.CONTAINERS = release.RELEASE, release.CONTAINERS
docker, database, save, state = release.docker, release.database, release.save, release.state


def capture():
    release.capture()
    data = state()
    data['services']['app']['image'] = 'mbbs-operator-app:special-line-decline-20261003'
    save('manifest.json', data)


def prepare():
    release.prepare()
    data = state()
    for kind in ['release', 'rollback']:
        image = data['services']['app']['image'] if kind == 'release' else data['services']['app']['before']['imageId']
        (release.RELEASE / ('compose.' + kind + '.yml')).write_text('services:\n  app:\n    image: ' + image + '\n')


def prepare_rollback():
    # Retain the draft-review guard if new decisions were saved before rollback.
    data = state()
    directory = release.RELEASE / 'rollback-compatible'
    (directory / 'src').mkdir(parents=True, exist_ok=True)
    original = (release.RELEASE / 'before-app/src/special-stock-request-repository.js').read_text()
    candidate = (release.RELEASE / 'candidate-app/src/special-stock-request-repository.js').read_text()
    guard = candidate.split('/** @param {Record<string,any>} special */\nfunction assertNoSpecialLineDecisionReview', 1)[1].split('export async function linkSpecialSalesOrder', 1)[0]
    source = original.replace('export async function linkSpecialSalesOrder', 'function assertNoSpecialLineDecisionReview' + guard + 'export async function linkSpecialSalesOrder', 1)
    for name in ['linkSpecialSalesOrder', 'claimSpecialOrderOperation', 'skipSpecialOrderCreation']:
        start = source.index('export async function ' + name)
        offset = source.index('    assertNoSpecialQuantityReview(special);', start)
        source = source[:offset] + source[offset:].replace('    assertNoSpecialQuantityReview(special);', '    assertNoSpecialQuantityReview(special);\n    assertNoSpecialLineDecisionReview(special);', 1)
    needle = "delivery_fee_rate=$16, vendor_discount_review='{}', updated_at=now()"
    assert needle in source
    source = source.replace(needle, "delivery_fee_rate=$16, vendor_discount_review='{}', line_edit_state='{}', updated_at=now()", 1)
    (directory / 'src/special-stock-request-repository.js').write_text(source)
    parent = 'mbbs-operator-app:line-decline-rollback-base-' + data['services']['app']['before']['imageId'].split(':')[1][:12]
    docker('tag', data['services']['app']['before']['imageId'], parent)
    (directory / 'Dockerfile').write_text('FROM ' + parent + '\nCOPY --chown=node:node src/ /app/src/\n')
    image = 'mbbs-operator-app:special-line-decline-rollback-20261003'
    with (release.RELEASE / 'rollback-build.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', image, str(directory)], stdout=log, stderr=subprocess.STDOUT, check=True)
    data['rollbackImageId'] = docker('image', 'inspect', '--format', '{{.Id}}', image).decode().strip()
    docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', image, '--check', 'src/special-stock-request-repository.js')
    expected = release.core.files_at(release.RELEASE / 'before-app')
    expected['src/special-stock-request-repository.js'] = release.digest(source.encode())
    assert json.loads(docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', image, '-e', release.TREE)) == expected
    (release.RELEASE / 'compose.rollback.yml').write_text('services:\n  app:\n    image: ' + data['rollbackImageId'] + '\n')
    save('manifest.json', data)
    print(json.dumps({'rollbackPreservesOrderReview': True}), flush=True)


def sync_checks():
    directory = release.RELEASE / 'checks-app'
    shutil.copytree(release.RELEASE / 'candidate-app', directory, dirs_exist_ok=True)
    for folder in ['test', 'tools']:
        shutil.copytree(SERVER / folder, directory / folder, dirs_exist_ok=True)
    runner, remote = 'mbbs-special-review-runner', '/tmp/special-line-decline-release-app'
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
    probe = (SERVER / 'tools/special-line-decline-live.mjs').read_text().replace('RELEASE_HASHES', json.dumps(row['sourceHashes']))
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
    assert data.get('rollbackImageId'), 'Prepare the compatible rollback image first'
    rollback = json.loads((release.RELEASE / 'rollback-compatibility.json').read_text())
    assert rollback['passed'] and rollback['image'] == data['rollbackImageId']
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
                "CREATE TEMP TABLE decline_stage_baseline ON COMMIT DROP AS SELECT * FROM special_stock_workflow_stages;\n" + sql +
                "\nDO $$ BEGIN IF EXISTS(SELECT * FROM decline_stage_baseline EXCEPT SELECT * FROM special_stock_workflow_stages) "
                "OR EXISTS(SELECT * FROM special_stock_workflow_stages EXCEPT SELECT * FROM decline_stage_baseline) "
                "THEN RAISE EXCEPTION 'Workflow stages changed'; END IF; END $$;\n"
                "INSERT INTO schema_migrations(filename) VALUES('" + release.MIGRATION + "'); COMMIT;")
            (release.RELEASE / 'migration.log').write_text(output)
            save('migration-result.json', {'applied': release.MIGRATION, 'transactional': True, 'existingStagesPreserved': True})
        with (release.RELEASE / 'publish.log').open('wb') as log:
            subprocess.run(release.core.compose(data) + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'], cwd=SERVER.parent,
                           stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except Exception:
        migrated = database("SELECT count(*) FROM schema_migrations WHERE filename='" + release.MIGRATION + "'") == '1'
        rollback_image = data['rollbackImageId'] if migrated else data['services']['app']['before']['imageId']
        (release.RELEASE / 'compose.rollback-effective.yml').write_text('services:\n  app:\n    image: ' + rollback_image + '\n')
        with (release.RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(release.core.compose(data, 'compose.rollback-effective.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'],
                           cwd=SERVER.parent, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        release.core.core.ready(rollback_image)
        save('rollback-result.json', {'restoredPreviousApp': True, 'orderReviewGuardRetained': migrated, 'additiveSchemaRetained': migrated})
        raise


if __name__ == '__main__':
    {'capture': capture, 'stage': release.stage, 'freeze': release.freeze, 'prepare': prepare, 'prepare-rollback': prepare_rollback, 'sync-checks': sync_checks, 'apply': apply, 'verify': verify}[sys.argv[1]]()

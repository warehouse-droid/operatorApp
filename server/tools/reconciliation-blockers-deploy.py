"""Deploy only this task's source delta, with health checks and image rollback."""
import datetime
import difflib
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
STATE = ROOT / 'server/deployments/reconciliation-blockers-20261022'
APP = 'mbbs-operator-app-app-1'
TAG = 'mbbs-operator-app:reconciliation-blockers-20261022'
ROLLBACK = 'mbbs-operator-app:reconciliation-blockers-rollback-20261022'
MIGRATION = 'migrations/304_return_verification_retry_blocks.sql'


def run(args, **kwargs):
    return subprocess.check_output(args, cwd=ROOT, text=True, **kwargs)


def inspect(name):
    return json.loads(run(['docker', 'inspect', name]))[0]


def save(name, data):
    destination = STATE / name
    destination.write_text(json.dumps(data, indent=2) + '\n')
    destination.chmod(0o600)


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def compose(before, override):
    labels = before['Config']['Labels']
    command = ['sudo', '-n', 'docker', 'compose', '-p', labels['com.docker.compose.project'],
               '--project-directory', labels['com.docker.compose.project.working_dir']]
    if labels.get('com.docker.compose.project.environment_file'):
        command += ['--env-file', labels['com.docker.compose.project.environment_file']]
    for file in labels['com.docker.compose.project.config_files'].split(','):
        command += ['-f', file]
    return command + ['-f', str(STATE / override)]


def sql(statement):
    return run(['docker', 'exec', '-i', 'mbbs-operator-app-db-1', 'sh', '-c',
                'exec psql -X -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1'], input=statement)


def check_evidence():
    evidence = json.loads((ROOT / 'server/test/reconciliation-blockers-evidence.json').read_text())
    assert evidence['suite']['fail'] == 0 and evidence['suite']['tests'] >= 125
    assert evidence['lint']['added'] == 0 and all(row['killed'] for row in evidence['mutation'])
    for name, expected in evidence['sourceHashes'].items():
        assert digest(ROOT / 'server' / name) == expected, f'Untested change: {name}'
    return evidence


def prepare():
    check_evidence()
    before = inspect(APP)
    save('release-before.private.json', before)
    save('other-services.private.json', [inspect(name) for name in [
        'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1']])
    names = list(json.loads((STATE / 'source-before.json').read_text()))
    candidate = STATE / 'candidate'
    assert not candidate.exists(), 'Do not overwrite an existing prepared release'
    changes = []
    for name in names:
        target = candidate / name
        target.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(['docker', 'cp', f'{APP}:/app/{name}', str(target)], check=True)
        previous = (STATE / 'workspace-before' / name).read_text()
        final = (ROOT / 'server' / name).read_text()
        changes.extend(difflib.unified_diff(previous.splitlines(True), final.splitlines(True),
                                            fromfile='a/' + name, tofile='b/' + name))
    patch = ''.join(changes)
    (STATE / 'application.patch').write_text(patch)
    subprocess.run(['patch', '--batch', '--forward', '--fuzz=0', '-p1', '-d', str(candidate)], input=patch, text=True, check=True)
    (candidate / MIGRATION).parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / 'server' / MIGRATION, candidate / MIGRATION)
    subprocess.run(['docker', 'tag', before['Image'], ROLLBACK], check=True)
    (STATE / 'Dockerfile').write_text(f'FROM {ROLLBACK}\nCOPY --chown=node:node candidate/ /app/\n')
    (STATE / '.dockerignore').write_text('*\n!Dockerfile\n!candidate/\n!candidate/**\n')
    subprocess.run(['docker', 'build', '-t', TAG, str(STATE)], check=True)
    for kind, image in [('release', TAG), ('rollback', ROLLBACK)]:
        save(f'compose.{kind}.json', {'services': {'app': {'image': image, 'pull_policy': 'never'}}})
    configure()


def configure():
    check_evidence()
    before = json.loads((STATE / 'release-before.private.json').read_text())
    candidate = STATE / 'candidate'
    names = list(json.loads((STATE / 'source-before.json').read_text()))
    configured = json.loads(run(compose(before, 'compose.release.json') + ['config', '--format', 'json']))
    save('compose.resolved.private.json', configured)
    environment = dict(value.split('=', 1) for value in inspect(TAG)['Config']['Env'])
    environment.update({key: str(value) for key, value in configured['services']['app'].get('environment', {}).items()})
    assert environment == dict(value.split('=', 1) for value in before['Config']['Env']), 'Deployment would change runtime configuration'
    save('manifest.json', {'baseImage': before['Image'], 'image': inspect(TAG)['Id'],
                          'hashes': {name: digest(candidate / name) for name in names + [MIGRATION]}})
    print('Prepared tested app overlay and rollback image; runtime configuration matches.', flush=True)


def verify():
    manifest = json.loads((STATE / 'manifest.json').read_text())
    before = json.loads((STATE / 'release-before.private.json').read_text())
    current = inspect(APP)
    assert current['Image'] == manifest['image'] and current['State']['Health']['Status'] == 'healthy'
    assert sorted(current['Config']['Env']) == sorted(before['Config']['Env'])
    for previous in json.loads((STATE / 'other-services.private.json').read_text()):
        other = inspect(previous['Name'])
        assert other['Id'] == previous['Id'] and other['State']['Running']
    script = 'const fs=require("fs"),c=require("crypto");console.log(JSON.stringify(Object.fromEntries(JSON.parse(process.argv[1]).map(n=>[n,c.createHash("sha256").update(fs.readFileSync("/app/"+n)).digest("hex")]))));'
    hashes = json.loads(run(['docker', 'exec', APP, 'node', '-e', script, json.dumps(list(manifest['hashes']))]))
    assert hashes == manifest['hashes']
    subprocess.run(['curl', '-fsS', '-o', '/dev/null', 'http://127.0.0.1:3000/health'], check=True)
    result = {'verifiedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'healthy': True,
              'image': current['Image'], 'startedAt': current['State']['StartedAt'], 'filesVerified': len(hashes),
              'otherServicesPreserved': True, 'configurationPreserved': True}
    save('deployed.json', result)
    print(json.dumps(result), flush=True)


def deploy():
    check_evidence()
    before = json.loads((STATE / 'release-before.private.json').read_text())
    assert inspect(APP)['Image'] == before['Image'], 'Live image changed; rebase before cutover'
    active = sql("BEGIN READ ONLY; SET LOCAL statement_timeout='10s'; SELECT json_build_object('reconciliation',(SELECT count(*) FROM scm_reconciliation_runs WHERE status IN ('queued','running')),'posting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing'))); COMMIT;")
    active = next(json.loads(line) for line in active.splitlines() if line.startswith('{'))
    assert active == {'reconciliation': 0, 'posting': 0}, f'Wait for active work: {active}'
    snapshot = sql("BEGIN READ ONLY; SELECT row_to_json(a) FROM return_batch_authorizations a WHERE batch_id=27; COMMIT;")
    save('batch27-before.private.json', next(json.loads(line) for line in snapshot.splitlines() if line.startswith('{')))
    migration = (STATE / 'candidate' / MIGRATION).read_text()
    sql("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='20s';\n" + migration
        + "\nINSERT INTO schema_migrations(filename) VALUES ('304_return_verification_retry_blocks.sql') ON CONFLICT DO NOTHING; COMMIT;")
    try:
        subprocess.run(compose(before, 'compose.release.json') + ['up', '-d', '--no-deps', '--no-build', 'app'], check=True)
        for _ in range(55):
            if inspect(APP)['State'].get('Health', {}).get('Status') == 'healthy':
                break
            time.sleep(1)
        else:
            raise RuntimeError('New app did not become healthy')
        verify()
    except Exception:
        subprocess.run(compose(before, 'compose.rollback.json') + ['up', '-d', '--no-deps', '--no-build', 'app'], check=True)
        raise


def recover():
    verify()
    program = (ROOT / 'server/tools/reconciliation-blockers-recover.mjs').read_text().replace("from '../src/", "from './src/")
    result = json.loads(run(['docker', 'exec', '-i', '-w', '/app', APP, 'node', '--input-type=module'], input=program))
    save('recovered.json', result)
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    os.umask(0o077)
    {'prepare': prepare, 'configure': configure, 'deploy': deploy, 'verify': verify, 'recover': recover}[sys.argv[1]]()

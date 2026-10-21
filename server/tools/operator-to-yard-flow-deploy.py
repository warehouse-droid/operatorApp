"""Deploy only the verified TO patch over captured live app/worker images."""
import datetime
import difflib
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
SERVER = ROOT / 'server'
STATE = pathlib.Path('/home/ubuntu/operatorapp-deploy-backups/operator-to-yard-flow-20261009')
ARTIFACT = SERVER / 'test-artifacts/operator-to-yard-flow-deployment'
DOCKER = ['sudo', '-n', 'docker']
SERVICES = {'app': 'mbbs-operator-app-app-1', 'webhook-worker': 'mbbs-operator-app-webhook-worker-1'}
NAMES = ['transfer-order-posting-domain.js', 'transfer-order-posting-repository.js',
         'transfer-order-posting-service.js', 'receiving-repository.js', 'delivery-repository.js',
         'server.js', 'order-sync-repository.js', 'netsuite.js']
MIGRATION = '279_operator_to_yard_flow.sql'


def run(args, **kwargs):
    return subprocess.check_output(args, cwd=ROOT, text=True, **kwargs)


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')
    path.chmod(0o600)


def inspect(name):
    return json.loads(run(DOCKER + ['inspect', name]))[0]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def runtime_hashes(container, names=None):
    script = "const fs=require('fs'),c=require('crypto');console.log(JSON.stringify(Object.fromEntries(JSON.parse(process.argv[1]).map(n=>[n,fs.existsSync('/app/'+n)?c.createHash('sha256').update(fs.readFileSync('/app/'+n)).digest('hex'):null]))));"
    names = names or ['src/' + n for n in NAMES] + ['migrations/' + MIGRATION]
    return json.loads(run(DOCKER + ['exec', container, 'node', '-e', script, json.dumps(names)]))


def compose(before, override):
    labels = before['app']['Config']['Labels']
    args = DOCKER + ['compose', '--project-name', labels['com.docker.compose.project'],
                     '--project-directory', labels['com.docker.compose.project.working_dir']]
    if labels.get('com.docker.compose.project.environment_file'):
        args += ['--env-file', labels['com.docker.compose.project.environment_file']]
    for name in labels['com.docker.compose.project.config_files'].split(','):
        args += ['-f', name]
    return args + ['-f', str(STATE / override)]


def capture():
    prior = STATE / 'before.private.json'
    if prior.exists():
        before = json.loads(prior.read_text())
        assert all(inspect(c)['Id'] == before[s]['Id'] for s, c in SERVICES.items()), 'Runtime changed during capture'
    else:
        before = {service: inspect(container) for service, container in SERVICES.items()}
        before['db'] = inspect('mbbs-operator-app-db-1')
        before['ollama'] = inspect('mbbs-operator-app-ollama-1')
        save(prior, before)
    for service, container in SERVICES.items():
        directory = STATE / 'baseline' / service
        directory.mkdir(parents=True, exist_ok=True)
        for name in ['src', 'public', 'contracts', 'migrations', 'package.json', 'package-lock.json']:
            if (directory / name).exists():
                continue
            if name == 'contracts' and run(DOCKER + ['exec', container, 'node', '-e',
                    "console.log(require('fs').existsSync('/app/contracts'))"]).strip() == 'false':
                continue
            subprocess.run(DOCKER + ['cp', f'{container}:/app/{name}', str(directory / name)], check=True)
        subprocess.run(['sudo', '-n', 'chown', '-R', f'{os.getuid()}:{os.getgid()}', str(directory)], check=True)
    save(ARTIFACT / 'captured.json', {
        'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'services': {s: {'containerId': before[s]['Id'], 'image': before[s]['Image'],
                         'sourceHashes': runtime_hashes(c)} for s, c in SERVICES.items()}})
    print('Captured live app and worker sources and rollback configuration privately.')


def audit():
    label = sys.argv[2] if len(sys.argv) > 2 else 'before'
    assert label in ['before', 'after']
    path = STATE / f'audit-{label}.private.json'
    assert not path.exists() or not path.stat().st_size, 'Do not replace an existing audit snapshot'
    source = (SERVER / 'tools/operator-to-yard-flow-audit.mjs').read_text().replace("from '../src/", "from './src/")
    result = run(DOCKER + ['exec', '-i', '-w', '/app', SERVICES['app'], 'node', '--input-type=module'], input=source)
    data = json.loads(result)
    save(path, data)
    print(json.dumps({'at': data['at'], 'orders': len(data['orders']), 'lines': len(data['lines']),
                      'loads': len(data['loads']), 'receipts': len(data['receipts']), 'jobs': len(data['jobs'])}))


def netsuite_audit():
    path = STATE / 'netsuite-audit.private.json'
    assert not path.exists(), 'Preserve the captured NetSuite evidence'
    source = (SERVER / 'tools/operator-to-yard-flow-netsuite-audit.mjs').read_text().replace("from '../src/", "from './src/")
    partial = STATE / 'netsuite-audit.partial.private.json'
    data = json.loads(partial.read_text()) if partial.exists() else {'headers': [], 'sources': [], 'linked': [], 'records': [], 'sourceDone': [], 'linkedDone': []}
    source = 'globalThis.operatorToYardResumeEvidence = ' + json.dumps(data) + ';\n' + source
    # Keep long read-only audit work independent of app health-check restarts.
    process = subprocess.Popen(DOCKER + ['exec', '-i', '-w', '/app', SERVICES['webhook-worker'], 'node', '--input-type=module'],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    process.stdin.write(source)
    process.stdin.close()
    for line in process.stdout:
        part = json.loads(line)
        if part['kind'] in ['headers', 'sources', 'linked']:
            key = part['kind']
            data[key].extend(part[key])
            if key != 'headers':
                data['sourceDone' if key == 'sources' else 'linkedDone'].extend(part['ids'])
            print(f"Verified NetSuite {key}: {len(data[key])} records", flush=True)
        elif part['kind'] == 'record':
            data['records'].append(part['entry'])
        elif part['kind'] == 'complete':
            data.update({k: v for k, v in part.items() if k != 'kind'})
        save(STATE / 'netsuite-audit.partial.private.json', data)
    code = process.wait()
    assert code == 0 and 'at' in data, f'NetSuite verification exited {code}; partial evidence retained'
    save(path, data)
    print(json.dumps({'ordersChecked': data['localCount'], 'parentsRequested': data['requestedParentCount'],
        'headersFound': len(data['headers']), 'sourcesFound': len(data['sources']),
        'linkedLines': len(data['linked']), 'restRecords': len(data['records']), 'netSuiteWrites': 0}))


def prepare():
    report = json.loads((SERVER / 'test-artifacts/operator-to-yard-flow/results.json').read_text())
    assert not report['newFailures'] and not report['types']['new'] and not report['coverage']['uncovered']
    assert all(digest(SERVER / name) == sha for name, sha in report['sourceHashes'].items())
    before = json.loads((STATE / 'before.private.json').read_text())
    original_patch = (SERVER / 'test/support/operator-to-yard-flow-baseline.patch').read_text()
    sections = original_patch.split('--- a/')
    patch = ''.join('--- a/' + part for part in sections[1:] if part.startswith('src/'))
    assert len([part for part in sections[1:] if part.startswith('src/')]) == len(NAMES)
    (STATE / 'application.patch').write_text(patch)
    manifest = {}
    for service, container in SERVICES.items():
        assert inspect(container)['Id'] == before[service]['Id'], f'{service} changed since capture'
        candidate = STATE / 'candidate' / service
        if candidate.exists():
            assert not (ARTIFACT / 'manifest.json').exists(), 'Candidate already reviewed; do not replace it'
            candidate.rename(candidate.with_name(service + '.incomplete-' + str(time.time_ns())))
        shutil.copytree(STATE / 'baseline' / service, candidate)
        selected = NAMES if service == 'app' else ['server.js', 'order-sync-repository.js', 'netsuite.js']
        service_patch = ''.join('--- a/' + part for part in sections[1:]
                                if any(part.startswith('src/' + name + '\n') for name in selected))
        applied = subprocess.run(['patch', '--batch', '--forward', '--fuzz=0', '-p1', '-d', str(candidate)],
                                 input=service_patch, text=True, capture_output=True)
        (ARTIFACT / f'patch-{service}.log').write_text(applied.stdout + applied.stderr)
        assert applied.returncode == 0, f'TO patch does not apply exactly to {service}; inspect the retained log'
        shutil.copy2(SERVER / 'migrations' / MIGRATION, candidate / 'migrations' / MIGRATION)
        overlay = STATE / 'image' / service / 'overlay'
        changes = {}
        for name in ['src/' + n for n in selected] + ['migrations/' + MIGRATION]:
            target = overlay / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(candidate / name, target)
            prior = STATE / 'baseline' / service / name
            changes[name] = {'before': digest(prior) if prior.exists() else None, 'after': digest(target)}
            if prior.exists():
                difference = ''.join(difflib.unified_diff(prior.read_text().splitlines(True),
                    target.read_text().splitlines(True), fromfile='a/' + name, tofile='b/' + name))
                (ARTIFACT / f'{service}-{pathlib.Path(name).name}.patch').write_text(difference)
        base_tag = f'mbbs-operator-app:to-yard-rollback-{service}-20261009'
        image_tag = f'mbbs-operator-app:to-yard-{service}-20261009'
        run(DOCKER + ['tag', before[service]['Image'], base_tag])
        (overlay.parent / 'Dockerfile').write_text(f'FROM {base_tag}\nCOPY --chown=node:node overlay/ /app/\n')
        manifest[service] = {'baseImage': before[service]['Image'], 'rollbackTag': base_tag,
                             'candidateTag': image_tag, 'changes': changes}
    save(ARTIFACT / 'manifest.json', manifest)
    for kind, key in [('release', 'candidateTag'), ('rollback', 'rollbackTag')]:
        (STATE / f'compose.{kind}.yml').write_text('services:\n' + ''.join(
            f'  {s}:\n    image: {m[key]}\n    pull_policy: never\n' for s, m in manifest.items()))
    print('Prepared eight app TO source patches, three worker sync/progress patches, and migration 279 over the current live images.')


def build():
    manifest = json.loads((ARTIFACT / 'manifest.json').read_text())
    for service, entry in manifest.items():
        with (ARTIFACT / f'build-{service}.log').open('w') as output:
            subprocess.run(DOCKER + ['build', '--network=none', '--pull=false', '-t', entry['candidateTag'],
                                     str(STATE / 'image' / service)], stdout=output, stderr=subprocess.STDOUT, check=True)
        entry['candidateImage'] = inspect(entry['candidateTag'])['Id']
    save(ARTIFACT / 'manifest.json', manifest)
    print('Built both scoped release images; dependency installation and network were disabled.')


def review():
    before = json.loads((STATE / 'before.private.json').read_text())
    manifest = json.loads((ARTIFACT / 'manifest.json').read_text())
    configured = json.loads(run(compose(before, 'compose.release.yml') + ['config', '--format', 'json']))
    save(STATE / 'compose.resolved.private.json', configured)
    for service, entry in manifest.items():
        old = before[service]
        spec = configured['services'][service]
        image_env = dict(v.split('=', 1) for v in inspect(entry['candidateImage'])['Config']['Env'])
        candidate_env = {**image_env, **{k: str(v) for k, v in spec.get('environment', {}).items()}}
        assert candidate_env == dict(v.split('=', 1) for v in old['Config']['Env']), f'Unexpected environment drift: {service}'
        assert spec['image'] == entry['candidateTag']
    save(ARTIFACT / 'configuration-review.json', {'environmentUnchanged': True, 'services': list(SERVICES)})
    print('Release configuration preserves the live environment for app and worker.')


def validation():
    manifest = json.loads((ARTIFACT / 'manifest.json').read_text())
    results = {}
    for service, count in [('app', 77), ('worker', 3)]:
        text = (ARTIFACT / f'candidate-{service}-tests.log').read_text()
        for label, expected in [('tests', count), ('pass', count), ('fail', 0)]:
            actual = re.findall(rf'^# {label} (\d+)$', text, re.M)
            assert actual and int(actual[-1]) == expected, f'Candidate {service} validation failed'
        results[service] = {'passed': count, 'failed': 0}
    for service, entry in manifest.items():
        for name, change in entry['changes'].items():
            assert digest(STATE / 'candidate' / service / name) == change['after']
            assert digest(STATE / 'image' / service / 'overlay' / name) == change['after']
    save(ARTIFACT / 'candidate-tests-passed.json', {'results': results,
        'images': {s: m['candidateImage'] for s, m in manifest.items()}})
    print('Exact app and worker candidates validated: 77 + 3 passing checks.')


def deploy():
    before = json.loads((STATE / 'before.private.json').read_text())
    manifest = json.loads((ARTIFACT / 'manifest.json').read_text())
    assert (ARTIFACT / 'configuration-review.json').exists()
    assert (ARTIFACT / 'candidate-tests-passed.json').exists(), 'Candidate validation must finish before cutover'
    for service, container in SERVICES.items():
        assert inspect(container)['Id'] == before[service]['Id'], f'{service} changed since capture'
        assert runtime_hashes(container, list(manifest[service]['changes'])) == {n: v['before'] for n, v in manifest[service]['changes'].items()}
    # Apply only this additive migration, not unrelated pending workspace migrations.
    migration = (SERVER / 'migrations' / MIGRATION).read_text()
    migration = re.sub(r'^BEGIN;\s*', '', migration)
    migration = re.sub(r'COMMIT;\s*$', '', migration)
    script = "import {query,withTransaction,closeDb} from './src/db.js';try{await withTransaction(async()=>{await query(" + json.dumps(migration) + ");await query('INSERT INTO schema_migrations(filename) VALUES($1) ON CONFLICT DO NOTHING',[" + json.dumps(MIGRATION) + "]);});console.log('TO waiting-status migration applied');}finally{await closeDb();}"
    run(DOCKER + ['exec', '-i', '-w', '/app', SERVICES['app'], 'node', '--input-type=module'], input=script)
    try:
        subprocess.run(compose(before, 'compose.release.yml') + ['up', '-d', '--no-deps', '--no-build', 'app', 'webhook-worker'], check=True)
        for _ in range(55):
            live = {s: inspect(c) for s, c in SERVICES.items()}
            if (all(live[s]['Image'] == manifest[s]['candidateImage'] and live[s]['State']['Running'] for s in SERVICES)
                    and live['app']['State'].get('Health', {}).get('Status') == 'healthy'):
                break
            time.sleep(1)
        else:
            raise RuntimeError('TO release did not become healthy')
        with urllib.request.urlopen('http://127.0.0.1:3000/health', timeout=5) as response:
            assert response.status == 200 and json.load(response)['ok']
        for service, container in SERVICES.items():
            assert runtime_hashes(container, list(manifest[service]['changes'])) == {n: v['after'] for n, v in manifest[service]['changes'].items()}
        for service in ['db', 'ollama']:
            current = inspect(before[service]['Id'])
            assert current['Id'] == before[service]['Id'] and current['State']['Health']['Status'] == 'healthy'
        save(ARTIFACT / 'deployed.json', {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                                         'images': {s: m['candidateImage'] for s, m in manifest.items()},
                                         'health': 'healthy', 'migration': MIGRATION})
        print('TO release deployed and verified on app and webhook worker; database and Ollama unchanged.')
    except Exception:
        subprocess.run(compose(before, 'compose.rollback.yml') + ['up', '-d', '--no-deps', '--no-build', 'app', 'webhook-worker'], check=True)
        raise


if __name__ == '__main__':
    os.umask(0o077)
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    ARTIFACT.mkdir(parents=True, exist_ok=True)
    {'capture': capture, 'audit': audit, 'netsuite-audit': netsuite_audit, 'prepare': prepare, 'build': build, 'review': review,
     'validation': validation, 'deploy': deploy}[sys.argv[1]]()

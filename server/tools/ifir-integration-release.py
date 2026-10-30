"""Scoped app-only IR/IF feature-gate rollout with source checks and rollback."""
import atexit
import difflib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tarfile
import time

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
EVIDENCE = SERVER / 'test-artifacts/ifir-posting-integration-20261021'
OPERATIONAL = SERVER / 'artifacts/ifir-posting-integration-20261021'
RELEASE = SERVER / 'deployments/ifir-posting-integration-20261021'
IMAGE = 'mbbs-operator-app:ifir-posting-integration-20261021'
ROLLBACK = IMAGE + '-rollback'
CHECK = 'mbbs-ifir-integration-image-check'
FLAGS = {'NETSUITE_IFIR_POSTING_ENABLED': 'true', 'NETSUITE_IFIR_POSTING_RESTLET_URL':
         'https://6518947.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=507&deploy=1'}
DOCKER = ['docker']
spec = importlib.util.spec_from_file_location('release_core', SERVER / 'tools/delivery-scm-release.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE = RELEASE
core.HASH_SCRIPT = """const fs=require('node:fs'),c=require('node:crypto'),result={};
function hash(p){result[p]=c.createHash('sha256').update(fs.readFileSync(p)).digest('hex');}
function walk(d){if(!fs.existsSync(d))return;for(const e of fs.readdirSync(d,{withFileTypes:true})){
const p=d+'/'+e.name;if(e.isDirectory())walk(p);else if(e.isFile())hash(p);}}
for(const d of ['src','public','migrations','contracts'])walk(d);
for(const p of ['package.json','package-lock.json'])hash(p);console.log(JSON.stringify(result));"""


def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + '\n')


def tree(directory):
    files = [p for root in ['src', 'public', 'migrations', 'contracts']
             for p in (directory / root).rglob('*') if p.is_file()]
    files += [directory / name for name in ['package.json', 'package-lock.json']]
    return {str(p.relative_to(directory)): core.sha(p.read_bytes()) for p in sorted(files)}


def evidence():
    report = json.loads((EVIDENCE / 'final/report.json').read_text())
    assert report['newFailures'] == []
    assert not report['types']['newIssues'] and not report['lint']['newIssues']
    assert len(report['mutation']) == 6 and all(row['killed'] for row in report['mutation'])
    assert len(report['source']) == 7
    assert all(row['covered'] == row['total'] for row in report['changedLineCoverage'].values())
    allowed = [{name: core.sha((SERVER / name).read_bytes()) for name in report['source']}]
    candidate = RELEASE / 'candidate'
    if candidate.exists():
        allowed.append({name: core.sha((candidate / name).read_bytes()) for name in report['source']})
    assert report['source'] in allowed, 'Tested source changed'
    history = [json.loads(line) for line in (OPERATIONAL / 'history-final-replay.jsonl').read_text().splitlines()]
    summary = next(row for row in history if row['event'] == 'history-summary')
    assert summary['created'] == 0 and summary['passed'] == summary['cases']
    assert summary['existing'] >= 7 and summary['native'] >= 1
    return report['source']


def expected_configuration():
    row = json.loads(core.docker('inspect', core.APP))[0]
    configuration = {key: row['Config'].get(key) for key in ['Cmd', 'Entrypoint', 'User', 'WorkingDir', 'Healthcheck']}
    env = dict(entry.split('=', 1) for entry in row['Config'].get('Env', []))
    env.update(FLAGS)
    configuration['env'] = sorted(f'{key}={value}' for key, value in env.items())
    configuration['mounts'] = sorted(row['Mounts'], key=lambda item: item['Destination'])
    configuration['host'] = {key: row['HostConfig'].get(key) for key in ['PortBindings', 'RestartPolicy',
        'Memory', 'MemorySwap', 'MemoryReservation', 'NanoCpus', 'PidsLimit', 'Init', 'ReadonlyRootfs',
        'Tmpfs', 'SecurityOpt', 'CapDrop']}
    return core.sha(json.dumps(configuration, sort_keys=True).encode())


def current(data):
    assert core.metadata(core.APP) == data['app'], 'Live app changed; recapture required'
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    assert json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)) == data['beforeTree']
    assert tree(RELEASE / 'candidate') == data['candidateTree']
    assert all(core.sha((SERVER / name).read_bytes()) == digest for name, digest in data['sourceHashes'].items())
    evidence()


def capture(hashes=None):
    if hashes is None:
        evidence()
        report = json.loads((EVIDENCE / 'final/report.json').read_text())
        hashes = {name: core.sha((SERVER / name).read_bytes()) for name in report['source']}
    os.umask(0o077)
    RELEASE.mkdir(parents=True, exist_ok=False)
    before = core.metadata(core.APP)
    dependencies = [core.metadata(name) for name in core.DEPENDENCIES]
    roots = json.loads(core.docker('exec', core.APP, 'node', '-e',
        "console.log(JSON.stringify(['src','public','migrations','contracts','package.json','package-lock.json'].filter(p=>require('node:fs').existsSync(p))))"))
    archive = core.docker('exec', core.APP, 'tar', '-cf', '-', '-C', '/app', *roots)
    baseline = RELEASE / 'before'
    baseline.mkdir()
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(baseline, filter='data')
    candidate = RELEASE / 'candidate'
    shutil.copytree(baseline, candidate)
    patch = ''
    for name in hashes:
        original = OPERATIONAL / 'before' / name
        if original.exists():
            patch += ''.join(difflib.unified_diff(original.read_text().splitlines(True),
                (SERVER / name).read_text().splitlines(True), fromfile='a/' + name, tofile='b/' + name,
                n=1 if name == 'src/netsuite.js' else 3))
        else:
            assert not (candidate / name).exists()
            shutil.copy2(SERVER / name, candidate / name)
    core.apply_patch(candidate, patch, 'ifir')
    before_tree, after_tree = tree(baseline), tree(candidate)
    changed = sorted(name for name in before_tree.keys() | after_tree.keys() if before_tree.get(name) != after_tree.get(name))
    assert changed == sorted(hashes), 'Unexpected release scope'
    assert all(after_tree[name] == digest for name, digest in hashes.items() if name != 'src/netsuite.js')
    data = {'capturedAt': core.now(), 'authorization': 'User requested enabling the new flow behind a feature gate',
            'app': before, 'dependencies': dependencies, 'files': changed, 'sourceHashes': hashes,
            'candidateSourceHashes': {name: after_tree[name] for name in changed},
            'beforeTree': before_tree, 'candidateTree': after_tree,
            'candidateTreeHash': core.sha(json.dumps(after_tree, sort_keys=True).encode()),
            'expectedConfiguration': expected_configuration(), 'featureGate': FLAGS}
    save('manifest.json', data)
    current(data)
    print(json.dumps({'captured': True, 'files': changed, 'runtimeFiles': len(after_tree)}), flush=True)


def refresh():
    # A concurrent public-asset rollout must not be overwritten by this release.
    # Test reuse is allowed only when all executable server source is identical.
    evidence()
    old = core.state()
    prior = RELEASE.with_name(RELEASE.name + '.before-refresh')
    assert not prior.exists()
    RELEASE.rename(prior)
    capture(old['sourceHashes'])
    new = core.state()
    changed = sorted(name for name in old['candidateTree'].keys() | new['candidateTree'].keys()
                     if old['candidateTree'].get(name) != new['candidateTree'].get(name))
    assert all(name.startswith('public/') for name in changed), 'Server source drift requires fresh candidate tests'
    save('refresh-audit.json', {'beforeApp': old['app'], 'afterApp': new['app'],
         'unrelatedPublicChangesPreserved': changed, 'testedServerSourceUnchanged': True})
    (OPERATIONAL / 'pre-refresh-manifest.json').write_text(json.dumps(old, indent=2) + '\n')
    shutil.rmtree(prior)


def cleanup():
    subprocess.run(DOCKER + ['rm', '-fv', CHECK], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for args, name in [(['ps'], 'docker-ps.log'), (['ps', '-a'], 'docker-ps-a.log')]:
        (RELEASE / name).write_bytes(core.docker(*args, '--format', '{{.Names}} {{.Status}}'))
    assert not core.docker('ps', '-a', '--filter', 'name=^/' + CHECK + '$', '--format', '{{.ID}}').strip()


def config_check(data):
    release = json.loads(subprocess.check_output(core.compose(data, 'release') + ['config', '--format', 'json'], cwd=ROOT))
    rollback = json.loads(subprocess.check_output(core.compose(data, 'rollback') + ['config', '--format', 'json'], cwd=ROOT))
    for config in [release, rollback]:
        config['services']['app'].pop('image')
    for key, value in FLAGS.items():
        assert release['services']['app']['environment'][key] == value
        if key in rollback['services']['app'].get('environment', {}):
            release['services']['app']['environment'][key] = rollback['services']['app']['environment'][key]
        else:
            release['services']['app']['environment'].pop(key)
    assert release == rollback, 'Configuration changes beyond the two feature-gate settings'
    save('config-check.json', {'onlyChanges': list(FLAGS), 'rollbackPreservesConfiguration': True})


def build():
    data = core.state()
    current(data)
    core.docker('tag', data['app']['imageId'], ROLLBACK)
    stage = RELEASE / 'stage'
    for name in data['files']:
        target = stage / 'overlay' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(RELEASE / 'candidate' / name, target)
    (stage / 'Dockerfile').write_text('FROM ' + ROLLBACK + '\nCOPY --chown=node:node overlay/ /app/\n')
    (RELEASE / 'compose.release.yml').write_text('services:\n  app:\n    image: ' + IMAGE + '\n    environment:\n'
        + ''.join('      ' + key + ': ' + json.dumps(value) + '\n' for key, value in FLAGS.items()))
    (RELEASE / 'compose.rollback.yml').write_text('services:\n  app:\n    image: ' + ROLLBACK + '\n')
    with (RELEASE / 'build.log').open('wb') as output:
        subprocess.run(DOCKER + ['build', '--network=none', '--pull=false', '-t', IMAGE, str(stage)],
                       stdout=output, stderr=subprocess.STDOUT, check=True, timeout=180)
    data['candidateImageId'] = core.docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    save('manifest.json', data)
    atexit.register(cleanup)
    try:
        actual = json.loads(core.bounded(data['candidateImageId'], CHECK, 'node', '-e', core.HASH_SCRIPT))
        assert actual == data['candidateTree']
        (RELEASE / 'server-import.log').write_bytes(core.bounded(data['candidateImageId'], CHECK,
            'node', '--input-type=module', '-e', "await import('./src/server.js');console.log('import OK');process.exit(0)"))
    finally:
        cleanup()
        atexit.unregister(cleanup)
    config_check(data)
    current(data)
    save('image-check.json', {'passed': True, 'imageId': data['candidateImageId']})
    print(json.dumps({'built': True, 'imageId': data['candidateImageId']}), flush=True)


def health(name):
    code = (SERVER / 'tools/ifir-posting-restlet-live-read.mjs').read_bytes()
    result = json.loads(core.docker('exec', '-i', '-w', '/app', core.APP, 'node', '--input-type=module', input=code))
    save(name, result)
    assert result['contractMatches'] and result['data']['writesEnabled'] and result['data']['productionAllowed']


def validate():
    data = core.state()
    evidence()
    report_bytes = (EVIDENCE / 'final/report.json').read_bytes()
    report = json.loads(report_bytes)
    assert report['source'] == data['candidateSourceHashes']
    assert tree(RELEASE / 'candidate') == data['candidateTree']
    check = json.loads((RELEASE / 'image-check.json').read_text())
    assert check['passed'] and check['imageId'] == data['candidateImageId']
    (RELEASE / 'validation-report.json').write_bytes(report_bytes)
    save('validation-passed.json', {'passed': True, 'candidateTreeHash': data['candidateTreeHash'],
         'source': report['source'], 'reportSha256': core.sha(report_bytes), 'validatedAt': core.now()})
    print(json.dumps({'validated': True, 'candidateTreeHash': data['candidateTreeHash']}), flush=True)


def verify():
    data = core.state()
    core.ready(data['candidateImageId'])
    actual = core.metadata(core.APP)
    assert actual['configuration'] == data['expectedConfiguration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    assert json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)) == data['candidateTree']
    settings = json.loads(core.docker('exec', '-w', '/app', core.APP, 'node', '--input-type=module', '-e',
        "import {config} from './src/config.js';console.log(JSON.stringify({enabled:config.netsuite.ifirPostingEnabled,url:config.netsuite.ifirPostingRestletUrl,direct:config.netsuite.directAccessEnabled}))"))
    assert settings == {'enabled': True, 'url': FLAGS['NETSUITE_IFIR_POSTING_RESTLET_URL'], 'direct': True}
    health('health-after.json')
    cleanup()
    result = {'deployed': True, 'at': core.now(), 'image': IMAGE, 'imageId': actual['imageId'],
              'files': data['files'], 'runtimeFilesVerified': len(data['candidateTree']), 'settings': settings,
              'dependenciesUnchanged': True, 'schemaChanged': False, 'rollbackImage': ROLLBACK,
              'rollbackImageId': data['app']['imageId']}
    save('deployment-result.json', result)
    print(json.dumps(result), flush=True)


def apply():
    data = core.state()
    current(data)
    validation = json.loads((RELEASE / 'validation-passed.json').read_text())
    assert validation['passed'] and validation['candidateTreeHash'] == data['candidateTreeHash']
    assert json.loads((EVIDENCE / 'final/report.json').read_text())['source'] == data['candidateSourceHashes']
    check = json.loads((RELEASE / 'image-check.json').read_text())
    assert check['passed'] and check['imageId'] == data['candidateImageId']
    health('health-before.json')
    for attempt in range(30):
        active = core.preflight()
        active['automaticFulfillment'] = int(core.sql("SELECT count(*) FROM dispatch_sales_order_if_candidates WHERE status='posting';"))
        try:
            core.assert_no_active_operations(active)
            break
        except AssertionError:
            if attempt == 29:
                raise
            time.sleep(2)
    current(data)
    args = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
    try:
        with (RELEASE / 'publish.log').open('wb') as output:
            subprocess.run(core.compose(data, 'release') + args, cwd=ROOT,
                           stdout=output, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except BaseException:
        with (RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(core.compose(data, 'rollback') + args, cwd=ROOT,
                           stdout=output, stderr=subprocess.STDOUT, check=True, timeout=60)
        core.ready(data['app']['imageId'])
        save('rollback-result.json', {'previousImageRestored': True})
        raise


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, lambda signum, _: sys.exit(128 + signum))
    {'capture': capture, 'refresh': refresh, 'build': build, 'validate': validate,
     'apply': apply, 'verify': verify}[sys.argv[1]]()

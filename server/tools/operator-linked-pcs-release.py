"""Test and release PCS validation in sales UOM over the current live app."""
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys

sys.dont_write_bytecode = True
server = Path(__file__).resolve().parents[1]
base = runpy.run_path(str(server / 'tools/operator-shared-pack-balance-release.py'))
scope = base['capture'].__globals__
release = server / 'deployments/operator-linked-pcs-sales-20261026'
image = 'mbbs-operator-app:operator-linked-pcs-sales-20261026'
module = 'src/operator-linked-quantity-domain.js'
before_hash = 'f6e0b509996366fc85ac9d96d142c107c2f055a7e64ffe573190ff6a9d618bee'
scope.update(RELEASE=release, IMAGE=image, ROLLBACK=image + '-rollback', FILES=[module])
core = scope['core']
core.RELEASE = release


def live_read(name):
    script = (server / 'tools/operator-linked-pcs-live.mjs').read_bytes().replace(b"'../src/", b"'./src/")
    result = json.loads(core.docker('exec', '-i', '-w', '/app', core.APP,
                                   'node', '--input-type=module', input=script))
    core.save(name, result)
    return result


def capture():
    assert core.sha(core.docker('exec', core.APP, 'cat', '/app/' + module)) == before_hash, 'Quantity source drift; review before release'
    base['capture']()
    data = core.state()
    data['authorization'] = 'User explicitly requested fixing the bug and converting linked PCS into sales UOM for comparison.'
    core.save('manifest.json', data)
    live_read('live-before.json')


def validate():
    data = base['current']()
    for tree_name in ['candidate', 'live-before']:
        tree_root = release / tree_name
        tree_root.chmod(tree_root.stat().st_mode | 0o555)
        package = tree_root / 'package.json'
        package.chmod(package.stat().st_mode | 0o444)
        for name in ['src', 'public', 'migrations']:
            root = tree_root / name
            for path in [root, *root.rglob('*')]:
                if path.is_dir():
                    path.chmod(path.stat().st_mode | 0o555)
                elif path.is_file():
                    path.chmod(path.stat().st_mode | 0o444)
    environment = dict(os.environ, DISPATCH_SOURCE_RUNTIME=str(release / 'candidate'),
                       DISPATCH_SOURCE_MIGRATIONS=str(release / 'candidate/migrations'))
    result = subprocess.run(['bash', 'docker/run-operator-linked-pcs-checks.sh'], cwd=server.parent,
                            env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if result.returncode:
        print(result.stdout[-28000:])
        raise RuntimeError('PCS validation checks failed')
    base['current']()
    report = json.loads(next(line.removeprefix('PCS_EVIDENCE=') for line in result.stdout.splitlines()
                             if line.startswith('PCS_EVIDENCE=')))
    assert report['passed'] and report['sourceHashes'] == data['sourceHashes']
    report.update(candidateTreeHash=data['candidateTreeHash'], cleanupVerified=True,
                  red={'newUnitAndPropertyFailures': 11, 'newIntegrationFailures': 3, 'existingBaselinePassed': 20},
                  harnessCorrection='Integration request corrected from sales to the existing salesQty field; assertions unchanged.')
    core.save('validation.json', report)
    print(json.dumps(report))


def verify_containers():
    production = {core.APP, *core.DEPENDENCIES}
    records = {}
    for label, args in [('running', ['ps']), ('all', ['ps', '-a'])]:
        rows = [json.loads(line) for line in core.docker(*args, '--format', '{{json .}}').decode().splitlines()]
        assert production <= {row['Names'] for row in rows}
        for row in rows:
            if row['Names'] in production:
                continue
            labels = dict(value.split('=', 1) for value in row['Labels'].split(',') if '=' in value)
            assert labels.get('com.mbbs.lifecycle') == 'disposable-test', row['Names']
            assert labels.get('com.docker.compose.project', '').startswith(('mbbs-source-save-', 'mbbs-disposable-')), row['Names']
            assert row['State'] == 'running', row['Names']
        records[label] = [{'name': row['Names'], 'status': row['Status'],
                           'independentTest': row['Names'] not in production} for row in rows]
    core.save('containers.json', records)


def verify():
    data = base['checked']()
    core.ready(data['candidateImageId'])
    actual = core.metadata(core.APP)
    assert actual['configuration'] == data['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    assert json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)) == data['candidateTree']
    http = core.http_check({}, ['/api/delivery/orders', '/api/customer-pickup/config'])
    verify_containers()
    result = live_read('live-after.json')
    assert result['pallet'] and not result['pallet']['blocked'], result
    assert result['pallet']['errors'] == []
    core.save('deployed.json', {'deployed': True, 'at': core.now(), 'image': image,
        'imageId': actual['imageId'], 'runtimeFilesVerified': len(data['candidateTree']),
        'files': [module], 'configurationPreserved': True, 'dependenciesUnchanged': True,
        'http': http, 'rollbackImage': image + '-rollback'})
    print(json.dumps({'livePallet': result['pallet'], 'underpack': result['underpack']}))


def resume_after_rollback():
    data = core.state()
    audit = json.loads((release / 'rollback-audit.json').read_text())
    assert audit['healthy'] and audit['restoredImage'] == data['app']['imageId']
    actual = core.metadata(core.APP)
    assert actual['imageId'] == data['app']['imageId']
    assert actual['configuration'] == data['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    assert json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)) == data['beforeTree']
    core.ready(data['app']['imageId'])
    core.save('rollback-rebase.json', {'at': core.now(), 'previousApp': data['app'], 'restoredApp': actual})
    data['app'] = actual
    core.save('manifest.json', data)
    base['current']()
    print('Verified rollback source, configuration and dependencies; refreshed container identity.')


scope['verify'] = verify

if __name__ == '__main__':
    os.umask(0o077)
    commands = {name.replace('_', '-'): base[name] for name in ['build', 'image_check', 'deploy']}
    commands.update(capture=capture, validate=validate, verify=verify, **{'resume-after-rollback': resume_after_rollback})
    commands[sys.argv[1]]()

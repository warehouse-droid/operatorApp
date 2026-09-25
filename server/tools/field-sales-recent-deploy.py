"""Deploy only the five verified Field Sales recency files over the active image."""
import argparse
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
RELEASE = SERVER / 'test-artifacts/field-sales/recent-deployment-20260919'
CHECKS = SERVER / 'test-artifacts/field-sales/recent'
IMAGE = 'mbbs-operator-app:field-sales-recent-20260919-v3'
ROLLBACK = 'mbbs-operator-app:rollback-field-sales-recent-20260919-v3'
FILES = ['src/field-sales/repository.js', 'src/field-sales/lead-filters.js', 'public/field-sales/lead-policy.js', 'public/field-sales/planner.js', 'public/field-sales/service-worker.js']
EXISTING = [name for name in FILES if not name.endswith(('/lead-policy.js', '/lead-filters.js'))]
spec = importlib.util.spec_from_file_location('field_sales_previous', SERVER / 'tools/field-sales-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
core = release.core
for module in [release, core]:
    module.RELEASE, module.IMAGE, module.ROLLBACK, module.FILES = RELEASE, IMAGE, ROLLBACK, FILES
core.EXISTING = EXISTING
APP, DEPENDENCIES = release.APP, release.DEPENDENCIES
docker, save = core.docker, core.save


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_gate():
    report = json.loads((CHECKS / 'recent-browser-results.json').read_text())
    assert report['passed'] == 3 and report['errors'] == []
    for name in FILES:
        assert digest(SERVER / name) == report['source'][name], 'Verified source changed: ' + name
    for file, count in [('map-browser-results.json', 7), ('browser-results.json', 5)]:
        browser = json.loads((CHECKS / file).read_text())
        assert browser['passed'] == count and browser['errors'] == []
    for file in ['focused.log', 'coverage.log']:
        log = (CHECKS / file).read_text()
        assert '# tests 80' in log and '# fail 0' in log and '# skipped 0' in log
    for file in ['lint.log', 'types.log']:
        assert not (CHECKS / file).read_text().strip(), file + ' must pass'
    mutants = json.loads((CHECKS / 'mutations.log').read_text())
    assert mutants['killed'] == 5 and all(row['killed'] for row in mutants['results'])
    assert json.loads((CHECKS / 'health.log').read_text())['passed']
    return report


def prepare():
    report = source_gate()
    RELEASE.mkdir(parents=True, exist_ok=False)
    state = {'app': core.metadata(APP), 'dependencies': [core.metadata(n) for n in DEPENDENCIES]}
    baseline = RELEASE / 'baseline'
    baseline.mkdir()
    for name in EXISTING:
        target = baseline / name
        target.parent.mkdir(parents=True, exist_ok=True)
        docker('cp', APP + ':/app/' + name, str(target))
        original = SERVER / 'test-artifacts/field-sales/recent-baseline' / name
        assert digest(original) == digest(target), 'Live source changed since work began: ' + name
    assert core.metadata(APP) == state['app'], 'App changed during capture'
    for folder in ['candidate', 'stage']:
        for name in FILES:
            target = RELEASE / folder / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(SERVER / name, target)
    state.update({'before': {name: digest(baseline / name) for name in EXISTING},
                  'after': {name: digest(SERVER / name) for name in FILES},
                  'workspace': {name: digest(SERVER / name) for name in FILES},
                  'checks': report, 'scope': 'Five recency/filter files; no database or configuration change'})
    save('manifest.json', state)
    for name, image in [('release', IMAGE), ('rollback', ROLLBACK)]:
        (RELEASE / f'compose.{name}.yml').write_text(f'services:\n  app:\n    image: {image}\n    pull_policy: never\n')
    print(json.dumps({'prepared': True, 'baseImage': state['app']['imageId'], 'files': FILES}), flush=True)


def build():
    source_gate()
    core.build()


def verify():
    state = core.manifest()
    core.ready(state['candidateImageId'])
    after = core.metadata(APP)
    assert after['configuration'] == state['app']['configuration'], 'Service configuration changed'
    assert [core.metadata(n) for n in DEPENDENCIES] == state['dependencies'], 'Another service changed'
    actual = docker('exec', APP, 'sha256sum', *['/app/' + name for name in FILES]).decode().splitlines()
    assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in actual} == state['after']
    script = """import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const expected=EXPECTED;let checks=0;
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
 const health=await fetch(base+'/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);checks++;
 for(const [file,sha] of Object.entries(expected)){const r=await fetch(base+'/'+file.replace(/^public\\//,''),{headers:{'Cache-Control':'no-cache'}});assert.equal(r.status,200);assert.equal(createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex'),sha);checks++;}
 assert.equal((await fetch(base+'/api/field-sales/jobsites')).status,401);checks++;
 assert.equal((await fetch(base+'/field-sales/')).status,200);checks++;
}console.log(JSON.stringify({passed:true,checks}));
""".replace('EXPECTED', json.dumps({name: sha for name, sha in state['after'].items() if name.startswith('public/')}))
    checks = json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', input=script.encode()))
    probe = subprocess.check_output(['python3', str(SERVER / 'tools/field-sales-recent-probe.py'), '--deployed'], cwd=ROOT, timeout=70)
    assert json.loads(probe)['passed']
    save('city-read-probe.json', json.loads(probe))
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'image': IMAGE, 'imageId': after['imageId'], 'configurationPreserved': True,
              'otherServicesUnchanged': True, 'runtimeFilesVerified': len(FILES), 'liveChecks': checks}
    save('deployment-result.json', result)
    print(json.dumps(result), flush=True)


def apply():
    source_gate()
    state = core.manifest()
    core.current(state)
    assert docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip() == state['candidateImageId']
    packaged = json.loads((RELEASE / 'candidate-checks.json').read_text())
    assert packaged['passed'] and packaged['imageId'] == state['candidateImageId']
    release.config_gate(state)
    assert not any(release.preflight().values()), 'Wait for an idle cutover'
    command = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
    try:
        with (RELEASE / 'cutover.log').open('wb') as output:
            subprocess.run(core.compose(state, 'compose.release.yml') + command, cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=100)
        verify()
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(core.compose(state, 'compose.rollback.yml') + command, cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=100)
        core.ready(state['app']['imageId'])
        save('rolled-back.json', {'at': datetime.datetime.now(datetime.timezone.utc).isoformat()})
        raise


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['prepare', 'build', 'apply', 'verify'])
    globals()[parser.parse_args().action]()

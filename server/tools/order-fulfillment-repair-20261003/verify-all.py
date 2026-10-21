"""Reproduce the incident checks without applying repairs or deploying images.

Requires Docker and the pinned private application/tool images in evidence.json.
--evidence-only checks saved results; --live also checks the deployed orders.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time
import uuid

HERE = Path(__file__).resolve().parent
OUT = Path('/home/ubuntu/operatorapp-investigations/operator-review-navigation-20261003')

def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)

def tree_hash(folder):
    files = {str(p.relative_to(folder)): hashlib.sha256(p.read_bytes()).hexdigest()
        for part in ['src', 'public', 'migrations']
        for p in (folder/part).rglob('*') if p.is_file()}
    return hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()

def prepare_sources(report):
    OUT.mkdir(parents=True, exist_ok=True)
    for name, spec in report['sourceTrees'].items():
        target = OUT/name
        if not target.exists():
            container = 'incident-evidence-' + uuid.uuid4().hex
            run('docker', 'create', '--name', container, '--network', 'none', spec['image'], stdout=subprocess.DEVNULL)
            try:
                target.mkdir()
                for part in ['src', 'public', 'migrations']:
                    run('docker', 'cp', f'{container}:/app/{part}', str(target/part))
            finally:
                run('docker', 'rm', container, stdout=subprocess.DEVNULL)
        assert tree_hash(target) == spec['sha256'], 'Source drift: ' + name

def check_results():
    def read(name):
        return json.loads((OUT/(name+'.json')).read_text())
    for name in ['baseline-regression', 'candidate-regression', 'new-tests',
            'review-rule', 'units', 'worker-units', 'baseline-posting', 'candidate-posting',
            'db-migrations', 'db-regression', 'receiving-browser', 'review-browser',
            'mutations', 'review-mutations', 'units-mutations', 'backend-coverage']:
        assert read(name)['exit'] == 0, name
    before, after = read('baseline-uom-regression'), read('candidate-uom-regression')
    assert before['failures'] == after['failures'] == ['not ok 3 - /app/src/scm-netsuite-po-history-harness.js']
    assert before['counts'] == after['counts']
    baseline = json.loads((OUT/'baseline-static.log').read_text())
    candidate = json.loads((OUT/'candidate-static.log').read_text())
    comparison = {}
    for key in ['lint', 'types', 'backendLint', 'backendTypes']:
        new = list((Counter(candidate[key]) - Counter(baseline[key])).elements())
        comparison[key] = {'baseline': len(baseline[key]), 'candidate': len(candidate[key]), 'new': new}
        assert not new, (key, new)
    (OUT/'static-comparison.json').write_text(json.dumps(comparison, indent=2)+'\n')
    return {'newRegressionFailures': 0, 'newStaticDiagnostics': 0,
        'preexistingFailure': after['failures'][0]}

def database_check(report):
    name = 'mbbs-incident-review-db'
    inspected = subprocess.run(['docker', 'inspect', name], text=True, capture_output=True)
    created = inspected.returncode != 0
    running = False
    if created:
        run('docker', 'create', '--name', name, '--network', 'none',
            '-e', 'POSTGRES_USER=incident_test', '-e', 'POSTGRES_PASSWORD=incident_local_test',
            '-e', 'POSTGRES_DB=incident_test', report['toolchain']['postgresImage'], stdout=subprocess.DEVNULL)
    else:
        info = json.loads(inspected.stdout)[0]
        assert info['Image'] == report['toolchain']['postgresImage']
        assert info['HostConfig']['NetworkMode'] == 'none'
        assert 'POSTGRES_USER=incident_test' in info['Config']['Env']
        running = info['State']['Running']
    try:
        if not running:
            run('docker', 'start', name, stdout=subprocess.DEVNULL)
        for _ in range(40):
            ready = subprocess.run(['docker', 'exec', name, 'pg_isready', '-U', 'incident_test'], capture_output=True)
            if ready.returncode == 0:
                break
            time.sleep(.5)
        else:
            raise RuntimeError('Isolated test database did not become ready')
        run(sys.executable, str(HERE/'db-check.py'))
    finally:
        if not running:
            run('docker', 'stop', name, stdout=subprocess.DEVNULL)
        if created:
            run('docker', 'rm', '-v', name, stdout=subprocess.DEVNULL)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-only', action='store_true')
    parser.add_argument('--live', action='store_true')
    args = parser.parse_args()
    report = json.loads((HERE/'evidence.json').read_text())
    if not args.evidence_only:
        prepare_sources(report)
        actual = subprocess.check_output(['docker', 'image', 'inspect', '--format', '{{.Id}}', 'mbbs-regular-v2:e2e'], text=True).strip()
        assert actual == report['toolchain']['testImage'], 'Test-tool image drift'
        for mode in ['baseline', 'candidate', 'review-rule', 'units', 'worker-units',
                'posting-regression', 'uom-regression', 'mutations', 'static', 'browser', 'coverage']:
            run(sys.executable, str(HERE/'checks.py'), mode)
        database_check(report)
    for name, spec in report['sourceTrees'].items():
        assert tree_hash(OUT/name) == spec['sha256'], 'Source drift: ' + name
    print(json.dumps(check_results()))
    if args.live:
        for script in ['run.py', 'som-run.py']:
            run(sys.executable, str(HERE/script), 'verify')
        run(sys.executable, str(HERE/'units-live.py'))
        run(sys.executable, str(HERE/'final-checks.py'))

if __name__ == '__main__':
    main()

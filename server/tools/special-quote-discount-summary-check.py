"""Repeatable quote checks using an isolated, disposable database and existing tools."""
import difflib
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

SERVER = Path(__file__).resolve().parents[1]
OUT = SERVER / 'test-artifacts/special-quote-discount-summary'
FILES = json.loads((SERVER / 'tools/special-quote-discount-summary-files.json').read_text())
MODE = sys.argv[1] if len(sys.argv) > 1 else 'all'
assert MODE in ['baseline', 'all', 'constraints']
OUT.mkdir(parents=True, exist_ok=True)


def docker(*args):
    return subprocess.check_output(['sudo', '-n', 'docker', *args])


def main():
    env = dict(value.split('=', 1) for value in json.loads(docker('inspect', 'mbbs-regular-v2-runner'))[0]['Config']['Env'])
    assert env['MBT_TEST_ISOLATED'] == '1' and env['NETSUITE_DIRECT_ACCESS_ENABLED'] == 'false'
    baseline = json.loads((OUT / 'baseline.json').read_text())
    package_sha = hashlib.sha256((SERVER / 'package.json').read_bytes()).hexdigest()
    assert baseline.get('packageSha256', package_sha) == package_sha, 'Dependencies changed'
    baseline['packageSha256'] = package_sha
    (OUT / 'baseline.json').write_text(json.dumps(baseline, indent=2) + '\n')
    patch, changed = '', {}
    for file in FILES:
        old = (OUT / 'before' / file).read_text().splitlines(True)
        new = (SERVER / file).read_text().splitlines(True)
        patch += ''.join(difflib.unified_diff(old, new, fromfile='a/' + file, tofile='b/' + file))
        changed[file] = [i + 1 for tag, _a, _b, start, end in difflib.SequenceMatcher(None, old, new).get_opcodes()
                         if tag in ['insert', 'replace'] for i in range(start, end)]
    (SERVER / 'test/special-quote-discount-summary.changes.patch').write_text(patch)
    (OUT / 'changed-source-lines.json').write_text(json.dumps(changed, indent=2) + '\n')
    if MODE == 'all':
        for file in ['checks.json', 'render-review.json', 'suite-results.json', 'all-results.json']:
            (OUT / file).unlink(missing_ok=True)
        for folder in ['coverage', 'pdf']:
            shutil.rmtree(OUT / folder, ignore_errors=True)
    (OUT / 'pdf').mkdir(exist_ok=True)
    network = 'mbbs-quote-discount-internal-' + str(os.getpid())
    db = 'mbbs-quote-discount-db-' + str(os.getpid())
    layers = []
    try:
        docker('network', 'create', '--internal', network)
        docker('run', '-d', '--name', db, '--network', network, '--network-alias', 'db', '--tmpfs', '/var/lib/postgresql',
               '-e', 'POSTGRES_DB=mbt_test', '-e', 'POSTGRES_USER=mbt_test', '-e', 'POSTGRES_PASSWORD=mbt_test_password',
               '-e', 'PGDATA=/var/lib/postgresql/data', 'postgres:18-alpine')
        for _ in range(60):
            probe = subprocess.run(['sudo', '-n', 'docker', 'exec', db, 'pg_isready', '-U', 'mbt_test', '-d', 'mbt_test'], capture_output=True)
            if probe.returncode == 0:
                break
            time.sleep(.5)
        else:
            raise RuntimeError('Disposable database did not start')
        args = ['sudo', '-n', 'docker', 'run', '--rm', '--network', network, '--read-only',
                '--user', f'{os.getuid()}:{os.getgid()}', '--tmpfs', '/tmp:mode=1777',
                '--tmpfs', f'/app/data:uid={os.getuid()},gid={os.getgid()},mode=0700']
        for key, value in env.items():
            args += ['-e', key + '=' + value]
        args += ['-e', 'SPECIAL_DISCOUNT_OUTPUT=/app/test-artifacts/pdf']
        for path in ['src', 'public', 'test', 'tools', 'migrations', 'package.json', 'eslint.mbt.config.js']:
            args += ['-v', f'{SERVER / path}:/app/{path}:ro']
        for path in SERVER.glob('netsuite*.js'):
            args += ['-v', f'{path}:/app/{path.name}:ro']
        if MODE == 'baseline':
            for file in FILES:
                args += ['-v', f'{OUT / "before" / file}:/app/{file}:ro']
        args += ['-v', f'{OUT}:/app/test-artifacts', 'mbbs-regular-v2:test']
        commands = [('migrations', ['node', 'src/migrate.js'])]
        if MODE == 'baseline':
            commands += [('baseline', ['node', 'tools/special-quote-discount-summary-tests.mjs', '--baseline'])]
        elif MODE == 'all':
            commands += [('quotes-and-coverage', ['node', 'node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false',
                *['--include=' + file for file in FILES], '--reporter=json', '--reporter=text-summary',
                '--reports-dir=test-artifacts/coverage', '--temp-directory=/tmp/quote-discount-coverage',
                'node', 'tools/special-quote-discount-summary-tests.mjs'])]
        commands += [] if MODE == 'baseline' else [('constraints', ['node', 'tools/special-quote-discount-summary-check.mjs'])]
        for name, command in commands:
            started = time.monotonic()
            log = OUT / f'{MODE}-{name}.log'
            with log.open('wb') as output:
                result = subprocess.run(args + command, stdout=output, stderr=subprocess.STDOUT, cwd=SERVER)
            record = {'layer': name, 'exitCode': result.returncode, 'seconds': round(time.monotonic() - started, 2)}
            layers.append(record)
            (OUT / f'{MODE}-results.json').write_text(json.dumps(layers, indent=2) + '\n')
            print(json.dumps(record), flush=True)
            if result.returncode:
                print(log.read_text()[-7000:], flush=True)
                raise SystemExit(result.returncode)
        if MODE == 'all':
            reviewers = sorted(Path('/tmp').glob('quote-pdf-review-*/pypdfium2/__init__.py'))
            assert reviewers, 'Existing PDFium reviewer unavailable'
            subprocess.run([sys.executable, str(SERVER / 'tools/special-quote-discount-summary-review.py')],
                           env=dict(os.environ, PYTHONPATH=str(reviewers[0].parents[1])), check=True)
    finally:
        subprocess.run(['sudo', '-n', 'docker', 'rm', '-f', db], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['sudo', '-n', 'docker', 'network', 'rm', network], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == '__main__':
    main()

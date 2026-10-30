"""Run targeted reconciliation checks with the standard isolated Compose budgets."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]


def main():
    if not os.environ.get('MBBS_TEST_ARTIFACT_DIR'):
        os.execvp('python3', ['python3', str(ROOT / 'docker/retention/retention.py'),
                             'run', '--', 'python3', __file__, *sys.argv[1:]])
    artifact = Path(os.environ['MBBS_TEST_ARTIFACT_DIR'])
    context = artifact / 'source'
    context.mkdir()
    # Historical deployment copies and protected test artifacts are not build inputs.
    for name in ['src', 'public', 'contracts', 'migrations', 'test']:
        shutil.copytree(ROOT / 'server' / name, context / name)
    (context / 'tools').mkdir()
    for source in (ROOT / 'server/tools').iterdir():
        if source.is_file():
            shutil.copy2(source, context / 'tools' / source.name)
    for source in (ROOT / 'server').iterdir():
        if source.is_file() and not source.name.startswith('.env'):
            shutil.copy2(source, context / source.name)
    shutil.copy2(ROOT / 'server/.env.example', context / '.env.example')
    project = f'mbbs-reconciliation-{os.getpid()}'
    image = f'{project}:test'
    override = artifact / 'compose.json'
    services = {}
    for service in ['test', 'migrate']:
        services[service] = {'image': image, 'build': {'context': str(context)},
                             'labels': {'com.mbbs.lifecycle': 'disposable-test'},
                             'volumes': [{'type': 'bind', 'source': str(artifact), 'target': '/app/test-artifacts'}]}
        if os.environ.get('MBBS_TEST_BUILD_TARGET'):
            services[service]['build']['target'] = os.environ['MBBS_TEST_BUILD_TARGET']
    services['db'] = {'labels': {'com.mbbs.lifecycle': 'disposable-test'}}
    override.write_text(json.dumps({'services': services}))
    artifact.chmod(0o777)
    compose = ['docker', 'compose', '-p', project, '-f', str(ROOT / 'docker-compose.mbt-test.yml'), '-f', str(override)]

    def run(name, command):
        with (artifact / f'{name}.log').open('w') as output:
            result = subprocess.run(command, cwd=ROOT, stdout=output, stderr=subprocess.STDOUT)
        lines = (artifact / f'{name}.log').read_text().splitlines()
        print(f'{name}: exit {result.returncode}', flush=True)
        if name == 'tests':
            print('\n'.join(line for line in lines if line.startswith(('not ok ', '# tests ', '# pass ', '# fail ', '# skipped ', '  error:', '  code:', 'CHECK '))), flush=True)
            if result.returncode:
                print('\n'.join(lines[-45:]), flush=True)
        elif result.returncode:
            print('\n'.join(lines[-40:]), flush=True)
        if result.returncode:
            raise subprocess.CalledProcessError(result.returncode, command)

    try:
        run('budgets', ['python3', 'docker/verify-memory-limits.py'])
        run('build', compose + ['build', 'test'])
        run('db', compose + ['up', '-d', '--wait', 'db'])
        run('migrate', compose + ['run', '--rm', '--no-deps', '-T', 'migrate'])
        command = sys.argv[1:] or ['node', 'tools/reconciliation-blockers-checks.mjs']
        run('tests', compose + ['run', '--rm', '--no-deps', '-T', 'test', *command])
        if (artifact / 'checks-summary.json').exists():
            shutil.copy2(artifact / 'checks-summary.json', ROOT / 'server/test/reconciliation-blockers-evidence.json')
        if (artifact / 'run-5825-checks-summary.json').exists():
            shutil.copy2(artifact / 'run-5825-checks-summary.json', ROOT / 'server/test/reconciliation-run-5825-evidence.json')
        if (artifact / 'aggregate-nightly-summary.json').exists():
            shutil.copy2(artifact / 'aggregate-nightly-summary.json', ROOT / 'server/test/aggregate-nightly-evidence.json')
    finally:
        subprocess.run(compose + ['down', '--volumes', '--remove-orphans'], check=True)
        subprocess.run(['docker', 'image', 'rm', image], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for args in [['docker', 'ps'], ['docker', 'ps', '-a']]:
            subprocess.run(args + ['--format', '{{.Names}}\t{{.Status}}'], check=True)
        for resource in ['container', 'volume', 'network']:
            remaining = subprocess.check_output(['docker', resource, 'ls', '-q', '--filter', f'label=com.docker.compose.project={project}'], text=True)
            assert not remaining.strip(), f'Remaining disposable {resource}: {remaining}'
        subprocess.run(['curl', '-fsS', '-o', '/dev/null', 'http://127.0.0.1:3000/health'], check=True)


if __name__ == '__main__':
    main()

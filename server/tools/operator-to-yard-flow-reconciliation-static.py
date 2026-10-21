"""Run static maintenance checks in a bounded disposable container."""
import importlib.util
import json
import os
import subprocess
import sys
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('to_deploy', ROOT / 'server/tools/operator-to-yard-flow-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
FILES = ['tools/operator-to-yard-flow-reconcile.mjs', 'tools/operator-to-yard-flow-reconciliation-plan.mjs',
         'tools/operator-to-yard-flow-reconciliation-proof.mjs', 'tools/operator-to-yard-flow-reconciliation-mutations.mjs',
         'tools/operator-to-partial-receiving-mutations.mjs',
         'tools/operator-to-yard-flow-netsuite-audit.mjs', 'tools/operator-to-yard-flow-audit.mjs',
         'test/mbt/unit/operator-to-yard-flow-reconciliation.test.js', 'test/mbt/unit/operator-to-yard-flow-reconciliation-proof.test.js',
         'test/mbt/integration/operator-to-yard-flow-reconciliation.test.js', 'test/mbt/integration/operator-to-legacy-receiving.test.js']
name = f'mbbs-to-reconciliation-static-{os.getpid()}'
image = 'node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0'
args = release.DOCKER + ['run', '--rm', '--name', name, '--init', '--cgroup-parent=mbbs-tests.slice', '--label',
                         'com.mbbs.lifecycle=disposable-test', '--memory=1g', '--memory-swap=1g', '--cpus=1', '--pids-limit=256',
                         '--tmpfs', '/tmp:rw,size=256m', '--workdir', '/app']
for source, target in [(ROOT / 'server/tools', '/app/tools'), (ROOT / 'server/test/mbt', '/app/test/mbt'),
                       (ROOT / 'server/test-artifacts/operator-to-yard-flow-tooling/node_modules', '/app/node_modules'),
                       (ROOT / 'server/package.json', '/app/package.json'), (ROOT / 'server/eslint.mbt.config.js', '/app/eslint.mbt.config.js')]:
    args += ['--mount', f'type=bind,src={source},dst={target},readonly']
if sys.argv[1] == 'secrets':
    for source, target in [(ROOT / 'server/test', '/app/test'),
                           (release.ARTIFACT, '/app/test-artifacts/operator-to-yard-flow-deployment')]:
        args += ['--mount', f'type=bind,src={source},dst={target},readonly']
try:
    if sys.argv[1] == 'secrets':
        paths = FILES + ['test/mbt/integration/operator-to-yard-flow-worker.test.js',
                        'test/operator-to-yard-flow-deployment-evidence.md', 'test/operator-to-yard-flow-spec.md']
        paths += ['tools/' + path.name for path in (ROOT / 'server/tools').glob('operator-to-yard-flow-*.py')]
        paths += ['tools/operator-to-legacy-receiving-deploy.py', 'tools/operator-to-partial-receiving-deploy.py',
                  'tools/operator-to-yard-flow-release-checks.sh']
        command = args + [image, 'node', 'test/support/scan-diff-secrets.mjs', '--unified-diff',
                          'test-artifacts/operator-to-yard-flow-deployment/release-source.patch'] + paths
        result = subprocess.run(command, capture_output=True, text=True)
        (release.ARTIFACT / 'release-secrets.log').write_text(result.stdout + result.stderr)
        print(result.stdout + result.stderr)
        assert result.returncode == 0, 'Release secret scan failed'
    else:
        command = args + [image, 'node', 'node_modules/eslint/bin/eslint.js', '--config', 'eslint.mbt.config.js', '--format', 'json']
        if sys.argv[1] == 'format': command += ['--fix-dry-run']
        result = subprocess.run(command + FILES, capture_output=True, text=True)
        assert result.stdout, result.stderr
        rows = json.loads(result.stdout)
        release.save(release.ARTIFACT / f'maintenance-lint-{sys.argv[1]}.json', rows)
        for row in rows:
            local = row['filePath'].removeprefix('/app/')
            assert local in FILES
            if sys.argv[1] == 'format' and row.get('output'): (ROOT / 'server' / local).write_text(row['output'])
            for message in row['messages']:
                print(f"{local}:{message['line']} {message['ruleId']} {message['message']}")
        print(json.dumps({'files': len(rows), 'errors': sum(row['errorCount'] for row in rows), 'warnings': sum(row['warningCount'] for row in rows)}))
        if sys.argv[1] != 'format': assert result.returncode == 0, 'Maintenance lint failed'
finally:
    subprocess.run(release.DOCKER + ['rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for flags, label in [([], 'running'), (['-a'], 'all')]:
        output = release.run(release.DOCKER + ['ps'] + flags + ['--format', '{{.Names}} {{.Status}}'])
        (release.ARTIFACT / f'static-docker-{label}-{os.getpid()}.log').write_text(output)
        assert name not in output

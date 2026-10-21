"""Collect fresh release numbers and scan only this change for credentials."""
import difflib
import hashlib
import json
import os
import pathlib
import re
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[2]
ARTIFACT = ROOT / 'server/test-artifacts/operator-to-direct-customer'
CANDIDATE = pathlib.Path('/home/ubuntu/operatorapp-deploy-backups/to01208-delivery-prep/direct-release/candidate')
DOCKER = ['sudo', '-n', 'docker']


if __name__ == '__main__':
    manifest = json.loads((ARTIFACT / 'manifest.json').read_text())
    log = (ARTIFACT / 'checks.log').read_text()
    tests = {key: int(re.findall(rf'^# {key} (\d+)$', log, re.M)[-1]) for key in ['tests', 'pass', 'fail']}
    assert tests['tests'] == tests['pass'] and tests['fail'] == 0
    mutations = json.loads((ARTIFACT / 'mutations/results.json').read_text())
    assert len(mutations) == 8 and all(row['killed'] for row in mutations)
    static = json.loads((ARTIFACT / 'static.json').read_text())
    assert not static['types']['new'] and not static['lint']['new']
    hashes = {name: hashlib.sha256((CANDIDATE / name).read_bytes()).hexdigest() for name in manifest['changes']}
    assert hashes == {name: change['after'] for name, change in manifest['changes'].items()}
    patch = ''.join(path.read_text() for path in sorted(ARTIFACT.glob('*.js.patch')))
    for name, change in manifest['changes'].items():
        if change['before'] is None:
            patch += ''.join(difflib.unified_diff([], (CANDIDATE / name).read_text().splitlines(True), fromfile='a/' + name, tofile='b/' + name))
    (ARTIFACT / 'release-source.patch').write_text(patch)
    name = f'mbbs-direct-to-secrets-{os.getpid()}'
    args = DOCKER + ['run', '--rm', '--name', name, '--init', '--cgroup-parent=mbbs-tests.slice',
        '--label', 'com.mbbs.lifecycle=disposable-test', '--memory=1g', '--memory-swap=1g', '--cpus=1',
        '--pids-limit=256', '--tmpfs', '/tmp:rw,size=256m', '--workdir', '/app']
    for source, target in [(ROOT / 'server/tools', '/app/tools'), (ROOT / 'server/test', '/app/test'),
                           (ROOT / 'server/test-artifacts', '/app/test-artifacts'), (CANDIDATE / 'src', '/app/src')]:
        args += ['--mount', f'type=bind,src={source},dst={target},readonly']
    paths = ['tools/' + path.name for path in sorted((ROOT / 'server/tools').glob('operator-to-direct-customer-*'))]
    paths += ['test/mbt/integration/direct-to-completion.test.js', 'test/mbt/property/direct-to-completion.property.test.js',
              'test/operator-to-direct-customer-spec.md', 'src/direct-to-completion-repository.js']
    try:
        scan = subprocess.run(args + ['node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0',
            'node', 'test/support/scan-diff-secrets.mjs', '--unified-diff', 'test-artifacts/operator-to-direct-customer/release-source.patch']
            + paths, capture_output=True, text=True)
        (ARTIFACT / 'secrets.log').write_text(scan.stdout + scan.stderr)
        assert scan.returncode == 0, 'The redacted credential scan failed'
    finally:
        subprocess.run(DOCKER + ['rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for flags, label in [([], 'running'), (['-a'], 'all')]:
            result = subprocess.check_output(DOCKER + ['ps'] + flags + ['--format', '{{.Names}} {{.Status}}'], text=True)
            (ARTIFACT / f'docker-{label}.log').write_text(result)
            assert name not in result
    coverage = json.loads((ARTIFACT / 'coverage/coverage-final.json').read_text())
    new_module = coverage['/app/src/direct-to-completion-repository.js']
    report = {'tests': tests, 'mutantsKilled': len(mutations), 'propertyOnlyMutantsKilled': sum(row.get('propertyKilled') is True for row in mutations),
              'newTypeErrors': len(static['types']['new']), 'types': static['types'], 'lintErrors': len(static['lint']['new']),
              'sourceHashes': hashes, 'secrets': 'passed', 'newModuleStatements': {
                  'executed': sum(value > 0 for value in new_module['s'].values()), 'total': len(new_module['s'])}}
    (ARTIFACT / 'checks.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({key: value for key, value in report.items() if key != 'sourceHashes'}, indent=2))

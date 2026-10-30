"""Release the quote-only zero packing display fix over the current live image."""
import json
import os
from pathlib import Path
import re
import runpy
import subprocess
import sys

sys.dont_write_bytecode = True
server = Path(__file__).resolve().parents[1]
base = runpy.run_path(str(server / 'tools/operator-shared-pack-balance-release.py'))
scope = base['capture'].__globals__
release = server / 'deployments/quote-packing-zero-20261026'
image = 'mbbs-operator-app:quote-packing-zero-20261026'
files = ['src/field-sales/company-pdf.js', 'src/special-stock-documents.js']
scope.update(RELEASE=release, IMAGE=image, ROLLBACK=image + '-rollback', FILES=files)
core = scope['core']
core.RELEASE = release
tests = ['test/field-sales/quote-packing-display.test.js', 'test/field-sales/company-pdf.test.js',
         'test/mbt/unit/special-quote-packing.test.js', 'test/mbt/unit/special-quote-pallet.test.js',
         'test/mbt/unit/special-quote-breakdown.test.js', 'test/mbt/unit/special-quote-discount-summary.test.js',
         'test/mbt/unit/special-quote-requester.test.js']


def capture():
    # These files were identical to production before the narrowly scoped edit.
    for name in files:
        original = subprocess.check_output(['git', 'show', 'HEAD:server/' + name], cwd=server.parent)
        live = core.docker('exec', core.APP, 'cat', '/app/' + name)
        assert original == live, 'Review concurrent live changes before capture: ' + name
    base['capture']()
    data = core.state()
    data['authorization'] = 'User reported remaining zero values in generated quote packing columns; scoped display fix.'
    core.save('manifest.json', data)


def validate():
    data = base['current']()
    # The unprivileged test container must read the root-owned source capture.
    for name in ['src', 'public']:
        root = release / 'candidate' / name
        for path in [root, *root.rglob('*')]:
            if path.is_dir():
                path.chmod(path.stat().st_mode | 0o555)
            elif path.is_file():
                path.chmod(path.stat().st_mode | 0o444)
    hashes = {name: core.sha((server / name).read_bytes()) for name in tests}
    environment = dict(os.environ, DISPATCH_SOURCE_RUNTIME=str(release / 'candidate'),
                       DISPATCH_SOURCE_SKIP_BUILD='1', DISPATCH_SOURCE_NO_DB='1')
    result = subprocess.run(['bash', 'docker/run-dispatch-source-tests.sh', 'node', '--test',
                             '--test-concurrency=1', *tests], cwd=server.parent, env=environment,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if result.returncode:
        print(result.stdout[-18000:])
        raise RuntimeError('Quote PDF regression checks failed')
    base['current']()
    assert hashes == {name: core.sha((server / name).read_bytes()) for name in tests}
    summary = [line for line in result.stdout.splitlines()
               if re.match(r'^# (tests|pass|fail|cancelled|skipped|duration_ms) ', line)]
    core.save('validation.json', {'passed': True, 'at': core.now(), 'tests': tests,
        'sourceHashes': data['sourceHashes'], 'candidateTreeHash': data['candidateTreeHash'],
        'testHashes': hashes, 'summary': summary, 'cleanupVerified': True,
        'red': 'All four new PDF regression tests failed against the original formatter.'})
    print('\n'.join(summary))
    print('Candidate PDF checks, disposable cleanup and production health passed.')


if __name__ == '__main__':
    os.umask(0o077)
    commands = {name.replace('_', '-'): base[name]
                for name in ['build', 'image_check', 'deploy', 'verify']}
    commands.update(capture=capture, validate=validate)
    commands[sys.argv[1]]()

"""Five plausible regressions, each challenged by examples and properties alone."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / 'test-artifacts/split-group-pickup'
catalog = 'src/dispatch-order-catalog-repository.js'
server = 'src/server.js'
browser = 'public/dispatch.js'
cases = [
    ('catalog ignores Pick-Up', catalog, "source_order.sales_order_type = 'Pick-Up'", 'false'),
    ('catalog hides Delivery instead', catalog, "source_order.sales_order_type = 'Pick-Up'", "source_order.sales_order_type = 'Delivery'"),
    ('legacy ignores pickup header', server, " OR sales_order_type = 'Pick-Up'", ''),
    ('legacy global bypasses pickup exclusion', server,
     '    if (inactiveSplitRefs.has(id)) continue;\n', ''),
]
text = (ROOT / browser).read_text()
suffix = next(line for line in text.splitlines() if 'const splitSuffix = ' in line)
cases.append(('group name drops split suffix', browser, suffix, '    const splitSuffix = "";'))
tests = ['test/dispatch/integration/dispatch-split-pickup-pool.test.js', 'test/dispatch/frontend/dispatch-split-group-name.test.js']
results = []
with tempfile.TemporaryDirectory(prefix='split-group-mutants-') as directory:
    for index, (name, file, old, new) in enumerate(cases):
        original = (ROOT / file).read_text()
        assert old in original
        target = Path(directory) / file
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(original.replace(old, new, 1))
        scopes = {}
        for scope, flags in [('all', []), ('properties', ['--test-name-pattern=PROPERTY'])]:
            result = subprocess.run(['sudo', '-n', 'bash', 'tools/split-group-pickup-test-env.sh', 'run', 'mutant', directory,
                                     'node', '--test', *flags, *tests], cwd=ROOT, capture_output=True, text=True)
            (ART / f'mutant-{index}-{scope}.log').write_text(result.stdout + result.stderr)
            assert result.returncode and re.search(r'AssertionError|Property failed', result.stdout), name + ': not behaviorally killed'
            scopes[scope] = {'killed': True, 'exitCode': result.returncode}
        results.append({'name': name, **scopes})
        target.unlink()
output = {'sourceHashes': {file: hashlib.sha256((ROOT / file).read_bytes()).hexdigest() for file in [catalog, server, browser]}, 'results': results}
(ART / 'mutations.json').write_text(json.dumps(output, indent=2) + '\n')
print(json.dumps(output))

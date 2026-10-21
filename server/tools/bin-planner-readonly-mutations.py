"""Plausible read-only regressions in a disposable source copy; no live edits."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
out = root / 'test-artifacts/bin-planner-readonly/mutations'
out.mkdir(parents=True, exist_ok=True)
source = root / 'public/dispatch.js'
original = source.read_bytes()
unit = 'test/mbt/unit/bin-planning-readonly-ui.test.js'
browser = 'test/mbt/integration/bin-planning-readonly-browser.test.js'
mutants = [
    ('ownership-inverted', 'return Boolean(load) && isMbtPlanningLoad(load) !== Boolean(globalThis.MbbsBinPlanning);',
     'return Boolean(load) && isMbtPlanningLoad(load) === Boolean(globalThis.MbbsBinPlanning);', unit),
    ('saved-start-shifted', 'return { ...timing, startMode: resolvedLoadStartMode(load),',
     'return { ...timing, start: timing.start + 1, startMode: resolvedLoadStartMode(load),', unit),
    ('readonly-delete', 'if (!truck || !load || isPlanningLoadReadOnly(load)) return;',
     'if (!truck || !load) return;', unit),
    ('enabled-controls', 'element.disabled = true;', 'element.disabled = false;', browser),
    ('assigned-truck-hidden', 'String(truck.id) === selected || !globalThis.MbbsBinPlanning ||',
     '!globalThis.MbbsBinPlanning ||', browser),
]
results = []
with tempfile.TemporaryDirectory(prefix='readonly-planner-mutants-') as temp:
    copied = Path(temp)
    for directory in ['src', 'public', 'test', 'migrations', 'tools', 'contracts']:
        shutil.copytree(root / directory, copied / directory)
    for file in root.iterdir():
        if file.is_file() and file.suffix in ['.json', '.js', '.mjs']:
            shutil.copy2(file, copied / file.name)
    target = copied / 'public/dispatch.js'
    for name, old, new, suite in mutants:
        assert original.decode().count(old) == 1, name
        target.write_text(original.decode().replace(old, new))
        if suite == unit:
            command = ['docker', 'run', '--rm', '--network', 'none', '-v', str(copied / 'public') + ':/app/public:ro',
                       '-v', str(copied / 'test') + ':/app/test:ro', '--entrypoint', 'node',
                       'mbbs-bin-planning-test:20260927', '--test', '--test-name-pattern=' + {
                           'ownership-inverted': '^read-only ownership', 'saved-start-shifted': '^read-only truck-switch',
                           'readonly-delete': '^shared mutation entry'}[name], suite]
        else:
            command = ['bash', str(root / 'tools/bin-planning-test.sh'), 'node', '--test', suite]
        with (out / (name + '.log')).open('w') as output:
            result = subprocess.run(command, env=dict(os.environ, BIN_PLANNING_SOURCE_ROOT=str(copied),
                                    BIN_PLANNING_CHECK='readonly-mutant-' + name), stdout=output, stderr=subprocess.STDOUT, timeout=240)
        log = (out / (name + '.log')).read_text()
        killed = result.returncode != 0 and 'not ok' in log and 'SyntaxError' not in log and 'ReferenceError' not in log
        results.append(dict(name=name, killed=killed, exit=result.returncode))
        print(json.dumps(results[-1]), flush=True)
        assert killed, name
        target.write_bytes(original)
assert source.read_bytes() == original
(out / 'results.json').write_text(json.dumps({'source_sha256': hashlib.sha256(original).hexdigest(), 'results': results, 'source_unchanged': True}, indent=2))

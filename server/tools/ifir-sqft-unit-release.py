"""Repair the existing SO reader; preserve the enabled quantity policy and live image."""
import difflib
import importlib.util
import json
from pathlib import Path
import shutil
import sys

SERVER = Path(__file__).resolve().parents[1]
RELEASE = SERVER / 'deployments/ifir-sqft-unit-evidence-20261021'
spec = importlib.util.spec_from_file_location('quantity_release', SERVER / 'tools/ifir-quantity-release.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
base.RELEASE = RELEASE
base.IMAGE = 'mbbs-operator-app:ifir-sqft-unit-evidence-20261021'
base.ROLLBACK = base.IMAGE + '-rollback'
core = base.core
core.RELEASE = RELEASE
current = base.current


def prepare():
    capture = json.loads((RELEASE / 'capture.json').read_text())
    name = 'src/netsuite.js'
    before = (RELEASE / 'workspace-netsuite-before.js').read_text()
    after = (SERVER / name).read_text()
    patch = ''.join(difflib.unified_diff(before.splitlines(True), after.splitlines(True),
                    fromfile='a/' + name, tofile='b/' + name))
    assert patch and 'function salesOrderFulfillmentLineUnit' in patch
    core.apply_patch(RELEASE / 'candidate', patch, 'reader-unit-fix')
    old, new = base.tree(RELEASE / 'before'), base.tree(RELEASE / 'candidate')
    assert sorted(n for n in old if old[n] != new[n]) == [name]
    data = {**capture, 'files': [name], 'beforeTree': old, 'candidateTree': new,
            'candidateTreeHash': core.sha(json.dumps(new, sort_keys=True).encode()),
            'workspace': {name: core.sha((SERVER / name).read_bytes())}}
    core.save('manifest.json', data)
    current(data)
    print(json.dumps({'prepared': True, 'files': data['files'], 'candidateTreeHash': data['candidateTreeHash']}))


def build():
    base.build()
    # Baseline already has the enabled policy; rollback restores that exact configuration.
    rollback = RELEASE / 'compose.rollback.yml'
    rollback.write_text(rollback.read_text().replace('"false"', '"true"'))


def apply():
    # This reader-only fix retains the already validated uploaded RESTlet and client.
    previous = SERVER / 'deployments/ifir-quantity-policy-20261021/account-validation.json'
    evidence = json.loads(previous.read_text())
    assert evidence['passed'] and evidence['transactionsCreated'] == 0
    evidence['retainedForReaderOnlyFix'] = True
    evidence['sourceOperationalRecord'] = str(previous.relative_to(SERVER))
    core.save('account-validation.json', evidence)
    base.apply()
    data = core.state()
    assert core.metadata(core.APP)['configuration'] == data['app']['configuration']
    result = json.loads((RELEASE / 'deployment-result.json').read_text())
    result['environmentPreserved'] = True
    result['onlyEnvironmentChange'] = {}
    core.save('deployment-result.json', result)


if __name__ == '__main__':
    {'prepare': prepare, 'build': build, 'apply': apply}[sys.argv[1]]()

"""Release only the verified Field Sales quote presentation assets."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('field_sales_frontend', SERVER / 'tools/field-sales-visiting-deploy.py')
frontend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(frontend)
core = frontend.core
RELEASE = SERVER / 'test-artifacts/field-sales/quote-ui-deployment-20260919'
CHECKS = SERVER / 'test-artifacts/field-sales/quote-ui'
IMAGE = 'mbbs-operator-app:field-sales-quote-ui-20260919-v1'
ROLLBACK = 'mbbs-operator-app:rollback-field-sales-quote-ui-20260919-v1'
FILES = ['public/field-sales/' + name for name in ['item-autocomplete.js', 'quotes.js', 'styles.css', 'service-worker.js']]
for module in [frontend, frontend.release, core]:
    module.RELEASE, module.IMAGE, module.ROLLBACK, module.FILES = RELEASE, IMAGE, ROLLBACK, FILES
    module.EXISTING = FILES


def source_gate():
    source = json.loads((CHECKS / 'verified-source.json').read_text())
    for name, expected in source.items():
        assert frontend.digest(SERVER / name) == expected, 'Tested source changed: ' + name
    reports = {}
    for name, count in [('trade-browser-results.json', 6), ('browser-results.json', 5)]:
        report = json.loads((CHECKS / name).read_text())
        assert report['passed'] == count and report['errors'] == [], name
        reports[name] = report
    assert not (CHECKS / 'lint.log').read_text().strip(), 'Lint must pass'
    return {'source': source, 'reports': reports}


frontend.source_gate = source_gate


def prepare():
    report = source_gate()
    RELEASE.mkdir(parents=True, exist_ok=False)
    state = {'app': core.metadata(core.APP), 'dependencies': [core.metadata(n) for n in core.DEPENDENCIES]}
    baseline = RELEASE / 'baseline'
    for name in FILES:
        target = baseline / name
        target.parent.mkdir(parents=True, exist_ok=True)
        core.docker('cp', core.APP + ':/app/' + name, str(target))
        original = SERVER / 'test-artifacts/field-sales/item-search-baseline' / Path(name).name
        assert frontend.digest(original) == frontend.digest(target), 'Live source changed: ' + name
        for folder in ['candidate', 'stage']:
            target = RELEASE / folder / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(SERVER / name, target)
    assert core.metadata(core.APP) == state['app'], 'App changed during capture'
    state.update({'before': {name: frontend.digest(baseline / name) for name in FILES},
                  'after': {name: frontend.digest(SERVER / name) for name in FILES},
                  'workspace': {name: frontend.digest(SERVER / name) for name in FILES},
                  'checks': report, 'scope': 'Four frontend assets; item search and per-item subtotal presentation'})
    core.save('manifest.json', state)
    for name, image in [('release', IMAGE), ('rollback', ROLLBACK)]:
        (RELEASE / f'compose.{name}.yml').write_text(f'services:\n  app:\n    image: {image}\n    pull_policy: never\n')
    print(json.dumps({'prepared': True, 'baseImage': state['app']['imageId'], 'files': FILES}), flush=True)


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['prepare', 'build', 'apply', 'verify'])
    action = parser.parse_args().action
    (prepare if action == 'prepare' else getattr(frontend, action))()

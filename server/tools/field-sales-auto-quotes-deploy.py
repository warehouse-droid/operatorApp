"""Scoped releases for the approved Field Sales customer/quote workflow."""
import argparse, hashlib, importlib.util, json, os, shutil, subprocess
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('action', choices=['prepare', 'build', 'apply', 'verify'])
args = parser.parse_args()
args.stage = 'auto-quotes'
spec = importlib.util.spec_from_file_location('memo_release', SERVER / 'tools/field-sales-quote-memo-deploy.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
CHECKS = SERVER / 'test-artifacts/field-sales/auto-quotes'
REPORT = CHECKS / (args.stage + '-checks.json')
report = json.loads(REPORT.read_text())
FILES = sorted(report['source'])
RELEASE = SERVER / ('test-artifacts/field-sales/' + args.stage + '-deployment-20260922')
IMAGE = 'mbbs-operator-app:field-sales-' + args.stage + '-20260922-v1'
ROLLBACK = 'mbbs-operator-app:rollback-field-sales-' + args.stage + '-20260922-v1'
EXISTING = report['existing']
for target in [module, module.release, module.core]:
    target.RELEASE, target.IMAGE, target.ROLLBACK, target.FILES = RELEASE, IMAGE, ROLLBACK, FILES
    target.EXISTING = EXISTING

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def gate():
    current = json.loads(REPORT.read_text())
    assert current['passed'], 'Verification is incomplete'
    for name, sha in current['source'].items():
        assert digest(SERVER / name) == sha, 'Verified source changed: ' + name
    return current

module.source_gate = gate

def prepare():
    checks = gate()
    RELEASE.mkdir(parents=True, exist_ok=False)
    state = {'app': module.core.metadata(module.APP), 'dependencies': [module.core.metadata(n) for n in module.DEPENDENCIES]}
    for name in EXISTING:
        target = RELEASE / 'baseline' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        module.docker('cp', module.APP + ':/app/' + name, str(target))
        assert digest(target) == checks['baseline'][name], 'Live Field Sales file changed: ' + name
    for folder in ['candidate', 'stage']:
        for name in FILES:
            target = RELEASE / folder / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(SERVER / name, target)
    state.update({'before': {n: digest(RELEASE / 'baseline' / n) for n in EXISTING},
                  'after': checks['source'], 'workspace': checks['source'], 'checks': checks,
                  'scope': 'Field Sales ' + args.stage})
    module.save('manifest.json', state)
    for name, image in [('release', IMAGE), ('rollback', ROLLBACK)]:
        (RELEASE / ('compose.' + name + '.yml')).write_text('services:\n  app:\n    image: ' + image + '\n    pull_policy: never\n')
    print(json.dumps({'prepared': True, 'files': len(FILES), 'baseImage': state['app']['imageId']}))

os.umask(0o077)
if args.action == 'prepare': prepare()
else: getattr(module, args.action)()

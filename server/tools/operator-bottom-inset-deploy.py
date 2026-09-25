"""Deploy the Operator bottom clearance over the current split-date release."""
import argparse
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location('operator_ui_deployment', Path(__file__).with_name('consolidation-pagination-deploy.py'))
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)
deployment.core.RELEASE = Path('/home/ubuntu/operatorapp-deploy-backups/operator-bottom-inset-20260916')
deployment.core.BASE_IMAGE = 'sha256:d4b0b2221d2157332aa72af1e376268fc2a0065f3e48ac066a8f8d857b3cc55d'
deployment.core.IMAGE = 'mbbs-operator-app:operator-bottom-inset-20260916-v1'
deployment.core.ROLLBACK = 'mbbs-operator-app:rollback-operator-bottom-inset-20260916'
deployment.BASE_WORKER_IMAGE = 'sha256:fa730d5b7614fad1efd126d3ceb32606919c5d3b74e915aa8aace9479544891e'
# Include unchanged assets used by the health probes and server.js so the
# shared candidate runner mounts the deployed source for the contract tests.
deployment.core.FILES = sorted(['public/operator.css', 'public/operator.html',
    'public/service-worker.js', 'public/operator.js', 'public/i18n.js', 'src/server.js'])
deployment.SOURCE_MANIFEST = deployment.core.SERVER / 'test-artifacts/operator-bottom-inset/changes.json'
deployment.VERSION = '20260916-operator-bottom-inset-v1'

original_gate = deployment.source_gate


def source_gate():
    before, after = original_gate()
    assert sorted(path for path in before if before[path] != after[path]) == [
        'public/operator.css', 'public/operator.html', 'public/service-worker.js']
    return before, after


deployment.source_gate = source_gate

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['prepare', 'apply', 'verify'])
    mode = parser.parse_args().mode
    if mode == 'prepare':
        deployment.prepare()
    elif mode == 'apply':
        deployment.apply()
    else:
        print(json.dumps(deployment.verify()))

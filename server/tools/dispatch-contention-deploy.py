"""Deploy the reviewed-notice frontend delta and retain the additive migration."""
import importlib.util
import json
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('adjustments', Path(__file__).with_name('special-workflow-adjustments-deploy.py'))
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)
release = deployment.release
release.BASE_IMAGE = 'sha256:9389031c73e0e11b3d4456b9697119f257fb715c9f87706ae0bda0110e2d614d'
deployment.WORKER_BASE = release.BASE_IMAGE
release.SERVICES = {'app': 'mbbs-operator-app-app-1', 'webhook-worker': 'mbbs-operator-app-webhook-worker-1'}
release.RELEASE = release.SERVER / 'test-artifacts/dispatch-contention-release-20260926'
release.EVIDENCE = release.SERVER / 'test-artifacts/dispatch-contention'
release.FILES = ['public/dispatch.js', 'public/dispatch.html', 'migrations/234_dispatch_identity_lookup_indexes.sql']
release.IMAGE = 'mbbs-operator-app:dispatch-contention-reviewed-notice-20260926'
release.ROLLBACK = 'mbbs-operator-app:rollback-dispatch-contention-20260926'


def verified_migration(_info):
    migration_spec = importlib.util.spec_from_file_location('indexes', Path(__file__).with_name('dispatch-contention-indexes.py'))
    migration = importlib.util.module_from_spec(migration_spec)
    migration_spec.loader.exec_module(migration)
    migration.main('verify')


release.migrate = verified_migration


if __name__ == '__main__':
    {'prepare': deployment.prepare, 'apply': deployment.apply, 'verify': release.verify}[sys.argv[1]]()

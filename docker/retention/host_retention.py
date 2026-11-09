"""Read-only production preflight and allowlisted artifact retention."""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.request

from retention import apply_actions, canonical, choose_newest, plan_tree

REPO = Path('/home/ubuntu/apps/operatorApp')
DEPLOYMENTS = (REPO / 'server/deployments', Path('/home/ubuntu/operatorapp-deploy-backups'))
ARTIFACTS = REPO / 'server/test-artifacts'
AUDIT = Path('/home/ubuntu/storage-cleanup/retention-audit')
ROOTS = (*DEPLOYMENTS, ARTIFACTS)
PRODUCTION = ('mbbs-operator-app-app-1', 'mbbs-operator-app-db-1',
              'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-ollama-1',
              'mbbs-operator-app-webhook-receiver-1')


def validate_containers(rows):
    lookup = {row['Name'].lstrip('/'): row for row in rows}
    for name in PRODUCTION:
        row = lookup.get(name)
        if not row or not row['State']['Running']:
            raise ValueError(f'Production container absent or stopped: {name}')
        health = row['State'].get('Health', {}).get('Status')
        if name != 'mbbs-operator-app-webhook-worker-1' and health != 'healthy':
            raise ValueError(f'Production container unhealthy: {name}')
    return lookup


def is_operational(path, test_artifact=False):
    name = path.name.lower()
    if name.startswith('.env') or name.startswith('compose.') or name.endswith('.compose.yml'):
        return True
    if test_artifact and name.endswith(('.dump', '.backup')):
        return True
    # Code copied into a historical runtime is not a separate operational audit.
    if {'src', 'public', 'migrations', 'test', 'tools', 'node_modules'} & set(path.parts[:-1]):
        return False
    return bool(path.suffix.lower() in {'.json', '.jsonl', '.csv', '.sql', '.md', '.txt'} and
                re.search(r'audit|reconcil|repair|production|applied|before[.-]|after[.-]|'
                          r'rollback|backup|snapshot|manifest|evidence|verification|result', name))


def docker_read(*args):
    return subprocess.check_output(['docker', *args], timeout=30)


def live_context():
    ids = docker_read('ps', '-aq').decode().split()
    rows = json.loads(docker_read('inspect', *ids)) if ids else []
    lookup = validate_containers(rows)
    with urllib.request.urlopen('http://127.0.0.1:3000/health', timeout=10) as response:
        if response.status != 200:
            raise ValueError('Application health failed')
    protected = set()
    active_tests = False
    for row in rows:
        labels = row.get('Config', {}).get('Labels') or {}
        protected.update(labels.get('com.docker.compose.project.config_files', '').split(','))
        protected.update(m['Source'] for m in row.get('Mounts', []) if m['Type'] == 'bind')
        if row['Name'].lstrip('/') not in PRODUCTION and row['State']['Running']:
            active_tests = True
    protected.discard('')
    identity = {name: {'id': lookup[name]['Id'], 'started': lookup[name]['State']['StartedAt'],
                       'image': lookup[name]['Image']} for name in PRODUCTION}
    return identity, protected, active_tests


def used_paths():
    protected = set()
    for pid in os.listdir('/proc'):
        if not pid.isdecimal() or int(pid) == os.getpid():
            continue
        try:
            links = [Path('/proc') / pid / 'cwd', *(Path('/proc') / pid / 'fd').iterdir()]
        except OSError:
            continue
        for link in links:
            try:
                target = Path(os.readlink(link))
            except OSError:
                continue
            for root in ROOTS:
                if target == root:
                    protected.add(str(root))
                elif root in target.parents:
                    protected.add(str(root / target.relative_to(root).parts[0]))
    return protected


def tracked_files():
    # The root-owned service reads this explicitly authorized, user-owned repo.
    output = subprocess.check_output(['git', '-c', f'safe.directory={REPO}',
                                      '-C', str(REPO), 'ls-files', '-z'], timeout=30)
    return {str(REPO / name.decode()) for name in output.split(b'\0') if name}


def active_runs():
    active = set()
    for marker in (ARTIFACTS / '.runs').glob('run-*/.active-run.json'):
        try:
            lease = json.loads(marker.read_text())
            start = Path(f'/proc/{int(lease["pid"])}/stat').read_text().rpartition(')')[2].split()[19]
            if start == lease['processStart']:
                active.add(str(marker.parent))
        except (OSError, ValueError, KeyError, IndexError):
            continue
    return active


def newest_copies():
    entries = []
    for root in DEPLOYMENTS:
        canonical(root)
        for path in root.iterdir():
            if not path.is_symlink() and (path.is_dir() or path.suffix in {'.tar', '.tgz', '.zip'}):
                entries.append((str(path), path.stat().st_mtime_ns))
    return choose_newest(entries, 5)


def build_plan(min_test_age_hours=2):
    services, protected, active_tests = live_context()
    protected.update(tracked_files())
    protected.update(used_paths())
    protected.update(active_runs())
    kept = newest_copies()
    protected.update(kept)
    actions, skipped = [], []
    for root in ROOTS:
        canonical(root)
        test = root == ARTIFACTS
        if test and active_tests:
            skipped.append({'path': str(root), 'reason': 'a non-production container is running'})
            continue
        children = list(root.iterdir())
        for path in children:
            if path.is_symlink() or not path.is_dir() or str(path) in kept:
                continue
            planned = plan_tree(path, protected, min_test_age_hours * 3600,
                                preserve=lambda p: is_operational(p, test))
            actions.extend(planned)
            if not planned:
                skipped.append({'path': str(path), 'reason': 'protected, recently used, or only audit/configuration records'})
        # Consider loose files without rescanning every child directory.
        folder_protection = protected | {str(p) for p in children if p.is_dir()}
        actions.extend(plan_tree(root, folder_protection,
                                 recent_seconds=0, keep_root=True,
                                 preserve=lambda p: is_operational(p, test) or
                                 (test and p.is_file() and time.time() - p.stat().st_mtime < min_test_age_hours * 3600)))
    return {'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'services': services, 'keptDeployments': kept, 'skipped': skipped,
            'actions': actions, 'plannedBytes': sum(a['bytes'] for a in actions)}


def ensure_current(plan):
    services, protected, active_tests = live_context()
    protected.update(tracked_files())
    protected.update(used_paths())
    protected.update(active_runs())
    protected.update(plan['keptDeployments'])
    ancestors = {str(parent) for value in protected for parent in Path(value).parents}
    if services != plan['services'] or newest_copies() != plan['keptDeployments']:
        raise ValueError('Production/deployment state changed; create a fresh plan')
    for action in plan['actions']:
        path = Path(action['path'])
        if not any(root in path.parents for root in ROOTS):
            raise ValueError('Plan target outside approved roots')
        if active_tests and (path == ARTIFACTS or ARTIFACTS in path.parents):
            raise ValueError('A test container started; retry after tests finish')
        if str(path) in protected or str(path) in ancestors or any(str(p) in protected for p in path.parents):
            raise ValueError(f'Plan overlaps a protected/live path: {path}')


def summary(plan):
    return {'keptDeployments': plan['keptDeployments'], 'deleteActions': len(plan['actions']),
            'plannedGiB': round(plan['plannedBytes'] / 2**30, 2), 'skippedTrees': len(plan['skipped'])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--apply-plan', type=Path)
    parser.add_argument('--min-test-age-hours', type=float, default=2)
    args = parser.parse_args()
    if args.min_test_age_hours < 0:
        parser.error('Negative age is not allowed')
    os.umask(0o077)
    AUDIT.mkdir(parents=True, exist_ok=True)
    with (AUDIT / 'retention.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        plan = json.loads(args.apply_plan.read_text()) if args.apply_plan else build_plan(args.min_test_age_hours)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        manifest = AUDIT / f'{stamp}-plan.json'
        manifest.write_text(json.dumps(plan, indent=2) + '\n')
        print(json.dumps({'manifest': str(manifest), **summary(plan)}), flush=True)
        if args.apply or args.apply_plan:
            ensure_current(plan)
            before = os.statvfs(REPO)
            apply_actions(plan['actions'])
            after = os.statvfs(REPO)
            services, _, _ = live_context()
            if services != plan['services']:
                raise ValueError('Production identities changed during cleanup; investigate')
            result = {**summary(plan), 'completedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                      'freedGiB': round((after.f_bavail - before.f_bavail) * after.f_frsize / 2**30, 2),
                      'productionUnchanged': True, 'health': 'passed', 'manifest': str(manifest)}
            (AUDIT / f'{stamp}-result.json').write_text(json.dumps(result, indent=2) + '\n')
            print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()

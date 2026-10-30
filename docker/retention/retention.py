"""File-only retention primitives. No Docker writes and no third-party modules."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import tempfile
import time


def choose_newest(entries, count=5):
    if not isinstance(count, int) or count < 1:
        raise ValueError('At least one deployment copy must be retained')
    return [path for path, _ in sorted(entries, key=lambda x: (x[1], x[0]), reverse=True)[:count]]


def canonical(path):
    path = Path(os.path.abspath(path))
    if path.resolve(strict=True) != path or path.is_symlink():
        raise ValueError(f'Symlink/noncanonical cleanup path: {path}')
    return path


def identity(info):
    return [info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns]


def scan(path, protected, device, preserve):
    info = path.lstat()
    own = identity(info)
    digest = hashlib.sha256(repr(own).encode())
    latest = info.st_mtime
    if (str(path) in protected or info.st_dev != device or
            stat.S_ISLNK(info.st_mode) or preserve(path)):
        return [], 0, latest, digest.hexdigest(), True
    if stat.S_ISREG(info.st_mode):
        action = dict(path=str(path), identity=own, fingerprint=digest.hexdigest(),
                      bytes=info.st_blocks * 512, directory=False)
        return [action], action['bytes'], latest, digest.hexdigest(), False
    if not stat.S_ISDIR(info.st_mode):
        return [], 0, latest, digest.hexdigest(), True
    actions, total, blocked = [], 0, False
    for child in sorted(path.iterdir()):
        child_actions, size, changed, signature, kept = scan(child, protected, device, preserve)
        digest.update(child.name.encode())
        digest.update(signature.encode())
        actions.extend(child_actions)
        total += size
        latest = max(latest, changed)
        blocked = blocked or kept
    signature = digest.hexdigest()
    if not blocked:
        actions = [dict(path=str(path), identity=own, fingerprint=signature,
                        bytes=total, directory=True)]
    return actions, total, latest, signature, blocked


def plan_tree(root, protected=(), recent_seconds=0, now=None, preserve=lambda _: False,
              keep_root=False):
    root = canonical(root)
    if not root.is_dir():
        raise ValueError('Cleanup root must be a directory')
    info = root.stat()
    protected = {str(Path(os.path.abspath(p))) for p in protected}
    if any(str(p) in protected for p in [root, *root.parents]):
        return []
    actions, _, latest, _, _ = scan(root, protected, info.st_dev, preserve)
    if recent_seconds and (time.time() if now is None else now) - latest < recent_seconds:
        return []
    if keep_root and any(action['path'] == str(root) for action in actions):
        actions = [action for child in sorted(root.iterdir())
                   for action in scan(child, protected, info.st_dev, preserve)[0]]
    for action in actions:
        action['root'] = str(root)
        action['root_identity'] = [info.st_dev, info.st_ino]
        action['root_times'] = [info.st_atime_ns, info.st_mtime_ns]
    return actions


def parent_descriptor(path):
    """Open every parent without following a replaced symbolic link."""
    descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in Path(path).parent.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def verify(action):
    try:
        path = canonical(action['path'])
        root = canonical(action['root'])
        if path != root and root not in path.parents:
            raise ValueError('Deletion escaped the planned root')
        if [root.stat().st_dev, root.stat().st_ino] != action['root_identity']:
            raise ValueError('Cleanup root identity changed')
        info = path.lstat()
        if identity(info) != action['identity']:
            raise ValueError(f'File changed since planning: {path}')
        signature = scan(path, set(), info.st_dev, lambda _: False)[3]
        if signature != action['fingerprint']:
            raise ValueError(f'Tree changed since planning: {path}')
    except OSError as error:
        raise ValueError(f'Plan no longer valid: {action["path"]}') from error


def apply_actions(actions):
    # Validate the entire batch before the first deletion.
    for action in actions:
        verify(action)
    roots = {a['root']: a for a in actions}
    for action in actions:
        verify(action)
        path = Path(action['path'])
        descriptor = parent_descriptor(path)
        try:
            info = os.stat(path.name, dir_fd=descriptor, follow_symlinks=False)
            if identity(info) != action['identity']:
                raise ValueError('Deletion target was replaced')
            if action['directory']:
                shutil.rmtree(path.name, dir_fd=descriptor)
            else:
                os.unlink(path.name, dir_fd=descriptor)
        finally:
            os.close(descriptor)
    # Removing children must not make an old, metadata-only copy look newest.
    for name, action in roots.items():
        path = Path(name)
        if path.exists():
            path = canonical(path)
            if [path.stat().st_dev, path.stat().st_ino] != action['root_identity']:
                raise ValueError('Cleanup root changed before timestamp restoration')
            os.utime(path, ns=tuple(action['root_times']), follow_symlinks=False)


def run_disposable(root, command):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    root = canonical(root)
    if not command:
        raise ValueError('A test command is required')
    artifact = Path(tempfile.mkdtemp(prefix='run-', dir=root))
    process_start = Path(f'/proc/{os.getpid()}/stat').read_text().rpartition(')')[2].split()[19]
    (artifact / '.active-run.json').write_text(json.dumps({
        'pid': os.getpid(), 'processStart': process_start, 'started': time.time()}))
    env = dict(os.environ, MBBS_TEST_ARTIFACT_DIR=str(artifact), TEST_ARTIFACT_DIR=str(artifact))
    child, received, received_at = None, 0, 0

    def forward(number, _frame):
        nonlocal received, received_at
        received, received_at = number, time.monotonic()
        if child is not None and child.poll() is None:
            os.killpg(child.pid, number)

    previous = {s: signal.signal(s, forward) for s in (signal.SIGINT, signal.SIGTERM)}
    try:
        child = subprocess.Popen(command, env=env, start_new_session=True)
        while True:
            try:
                status = child.wait(timeout=.2)
                return 128 + received if received else (status if status >= 0 else 128 - status)
            except subprocess.TimeoutExpired:
                if received and time.monotonic() - received_at > 10:
                    os.killpg(child.pid, signal.SIGKILL)
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)
        descriptor = parent_descriptor(artifact)
        try:
            shutil.rmtree(artifact.name, dir_fd=descriptor)
        finally:
            os.close(descriptor)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='action', required=True)
    run = commands.add_parser('run')
    run.add_argument('--root', default='/home/ubuntu/apps/operatorApp/server/test-artifacts/.runs')
    run.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    raise SystemExit(run_disposable(args.root, command))


if __name__ == '__main__':
    main()

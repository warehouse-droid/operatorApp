"""Reproduce closure checks using disposable, bounded standard Compose services."""
import json
import difflib
from pathlib import Path
import signal
import subprocess
import sys

TASK = Path(__file__).resolve().parent
SERVER = TASK.parents[1]
ROOT = SERVER.parent
OUT = SERVER / 'test-artifacts/conversation-followup-20261016'
PROJECT = 'mbbs-conversation-followup-20261016'
MODE = sys.argv[1] if len(sys.argv) > 1 else 'green'
IMAGE = 'mbbs-operator-app:dispatch-editor-control-browser-test-20261015'
OUT.mkdir(parents=True, exist_ok=True)
labels = {'com.mbbs.lifecycle': 'disposable-test', 'com.mbbs.task': PROJECT}
mounts = [f'{SERVER / folder}:/app/{folder}:ro' for folder in ['src', 'public', 'migrations', 'test', 'tools', 'package.json', '.c8rc.json']]
if MODE in ['release','baseline']:
    mounts = [entry for entry in mounts if not any(entry.endswith(f':/app/{folder}:ro') for folder in ['src', 'public', 'migrations'])]
    mounts += [f'{TASK / ('baseline-runtime' if MODE=='baseline' else 'candidate-runtime') / folder}:/app/{folder}:ro' for folder in ['src', 'public', 'migrations']]
mounts.append(f'{SERVER / "test-artifacts/delivery-enhancements-20261013/toolchain/node_modules"}:/app/node_modules:ro')
service = {'image': IMAGE, 'pull_policy': 'never', 'working_dir': '/app', 'user': '1000:1000', 'labels': labels, 'volumes': mounts, 'environment': {'PLAYWRIGHT_BROWSERS_PATH':'/ms-playwright','XDG_CONFIG_HOME':'/tmp/config','XDG_CACHE_HOME':'/tmp/cache','CONVERSATION_TEST_ARTIFACTS':'test-artifacts/conversation-followup-20261016'}}
config = OUT / 'compose.json'
config.write_text(json.dumps({'services': {'db': {'labels': labels}, 'test': service, 'migrate': service}}, indent=2) + '\n')
changed = {}
for name in json.loads((TASK / 'files.json').read_text()):
    if not name.endswith('.js'): continue
    original = SERVER / 'deployments/conversation-followup-20261016/before' / name if MODE == 'release' else TASK / 'baseline' / name
    target = TASK / 'candidate-runtime' / name if MODE == 'release' else SERVER / name
    before = original.read_text().splitlines() if original.exists() else []
    after = target.read_text().splitlines() if target.exists() else []
    changed[name] = [line + 1 for tag, _i, _j, start, end in difflib.SequenceMatcher(a=before, b=after).get_opcodes()
                     if tag in ['insert', 'replace'] for line in range(start, end)
                     if after[line].strip() and not after[line].lstrip().startswith(('/**', '//', '*'))]
(OUT / 'changed-lines.json').write_text(json.dumps(changed, indent=2) + '\n')
docker = ['sudo', '-n', 'docker']
compose = docker + ['compose', '-p', PROJECT, '--project-directory', str(ROOT),
                    '-f', str(ROOT / 'docker-compose.mbt-test.yml'), '-f', str(config)]


def run(label, args, timeout=240):
    with (OUT / (label + '.log')).open('w') as log:
        result = subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, cwd=ROOT, timeout=timeout)
    print(json.dumps({'stage': label, 'exit': result.returncode}), flush=True)
    if result.returncode:
        print((OUT / (label + '.log')).read_text()[-6000:], flush=True)
    return result.returncode


def interrupted(_signal, _frame):
    raise KeyboardInterrupt('Removing disposable closure tests')


signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
try:
    effective = json.loads(subprocess.check_output(compose + ['--profile', 'tools', 'config', '--format', 'json']))
    for name in ['db', 'test', 'migrate']:
        current = effective['services'][name]
        assert current['cgroup_parent'] == 'mbbs-tests.slice' and current['init'] is True
        assert 0 < int(current['mem_limit']) <= 2 * 1024 ** 3
        assert current['memswap_limit'] == current['mem_limit']
        assert 0 < int(current['pids_limit']) <= 512 and float(current['cpus']) <= 2
        assert all('size=' in entry for entry in current['tmpfs'])
    launch = compose + ['run', '--rm', '--no-deps', '-T', 'test']
    if MODE in ['red-browser','browser-review']:
        result=run(MODE,launch+['node','--test','test/mbt/integration/stock-request-conversation-browser.test.js'],timeout=180)
        assert result!=0 and 'not ok' in (OUT/(MODE+'.log')).read_text()
    elif MODE == 'probe':
        assert run('tooling', launch + ['node', '-e', 'for(const n of ["typescript","eslint","c8","fast-check"]){try{console.log(n,require(n+"/package.json").version)}catch{console.log(n,"missing")}}']) == 0
        print((OUT / 'tooling.log').read_text(), flush=True)
    elif MODE == 'red':
        result = run('red', launch + ['node', '--test', 'test/mbt/unit/stock-request-conversation.test.js'])
        assert result != 0 and 'Not implemented' in (OUT / 'red.log').read_text()
    else:
        assert run('database', compose + ['up', '-d', '--wait', '--no-build', '--pull', 'never', 'db']) == 0
        assert run('migrations', compose + ['run', '--rm', '--no-deps', '-T', 'migrate', 'node', 'src/migrate.js']) == 0
        if MODE == 'red-service':
            result = run(MODE, launch + ['node', '--test', '--test-name-pattern=conversation', 'test/mbt/integration/stock-request-conversation.test.js'])
            assert result != 0 and 'not ok' in (OUT / (MODE + '.log')).read_text()
        else:
            assert run(MODE, launch + ['node', 'tools/conversation-followup-20261016/' + ('check-baseline.mjs' if MODE=='baseline' else 'check.mjs')], timeout=600) == 0
finally:
    down = run(MODE + '-teardown', compose + ['down', '--volumes', '--remove-orphans'])
    residual = subprocess.check_output(docker + ['ps', '-aq', '--filter', 'label=com.mbbs.task=' + PROJECT]).decode().split()
    if residual:
        run(MODE + '-residual-cleanup', docker + ['rm', '-f', '-v', *residual])
        down = run(MODE + '-teardown-retry', compose + ['down', '--volumes', '--remove-orphans'])
    def listing(*args):
        return subprocess.check_output(docker + list(args)).decode().strip()
    cleanup = {'teardownExit': down,
        'dockerPs': listing('ps', '--format', '{{.Names}} {{.Status}}'),
        'dockerPsA': listing('ps', '-a', '--format', '{{.Names}} {{.Status}}'),
        'ownContainers': listing('ps', '-a', '--filter', 'label=com.mbbs.task=' + PROJECT, '--format', '{{.Names}}'),
        'networks': listing('network', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}'),
        'volumes': listing('volume', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}')}
    cleanup['productionHealthy'] = json.loads(subprocess.check_output(['curl', '-fsS', 'http://127.0.0.1:3000/health']))['ok']
    (OUT / (MODE + '-cleanup.json')).write_text(json.dumps(cleanup, indent=2) + '\n')
    assert down == 0 and not cleanup['ownContainers'] and not cleanup['networks'] and not cleanup['volumes']
    assert cleanup['productionHealthy']
    print(json.dumps({'cleanup': 'complete', 'productionHealthy': True}), flush=True)

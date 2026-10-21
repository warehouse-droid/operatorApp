"""Capture nonsecret deployed source and the service fingerprints for a scoped fix."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

SERVER = Path(__file__).resolve().parents[2]
OUT = SERVER / 'test-artifacts/special-so-link-sqft-20261006'
FILES = ['src/special-stock-request-repository.js', 'src/special-stock-pricing-domain.js',
         'public/sales-special-stock-requests.js']

def docker(*args):
    return subprocess.check_output(['sudo', '-n', 'docker', *args])

def metadata(name):
    info = json.loads(docker('inspect', name))[0]
    config = {key: value for key, value in info['Config'].items()
              if key not in ['Image', 'Labels', 'Hostname']}
    config['Env'] = sorted(config.get('Env', []))
    digest = hashlib.sha256(json.dumps({'Config': config, 'HostConfig': info['HostConfig']}, sort_keys=True).encode()).hexdigest()
    labels = info['Config']['Labels']
    return {'image': info['Image'], 'configurationHash': digest,
            'compose': {key: value for key, value in labels.items() if key.startswith('com.docker.compose.')}}

OUT.mkdir(parents=True, exist_ok=True)
runtime = OUT / 'runtime'
runtime.mkdir(exist_ok=True)
for directory in ['src', 'public', 'migrations']:
    if (runtime / directory).exists():
        continue
    subprocess.run(['sudo', '-n', 'docker', 'cp', 'mbbs-operator-app-app-1:/app/' + directory,
                    str(runtime / directory)], check=True)
    subprocess.run(['sudo', '-n', 'chown', '-R', 'ubuntu:ubuntu', str(runtime / directory)], check=True)
for filename in ['package.json', 'package-lock.json', 'netsuite-smart-scm-picking-ticket-restlet.js']:
    (runtime / filename).write_bytes(docker('exec', 'mbbs-operator-app-app-1', 'cat', '/app/' + filename))
for filename in FILES:
    before = runtime / filename
    assert before.read_bytes() == (SERVER / filename).read_bytes(), 'Workspace differs from deployed baseline: ' + filename
    target = OUT / 'baseline' / filename
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(before, target)
state = {name: metadata(name) for name in ['mbbs-operator-app-app-1', 'mbbs-operator-app-webhook-worker-1',
          'mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1']}
(OUT / 'runtime.json').write_text(json.dumps(state, indent=2))
print(json.dumps({'captured': True, 'files': FILES, 'services': {key: value['image'] for key, value in state.items()}}))

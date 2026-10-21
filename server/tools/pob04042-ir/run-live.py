"""Run the saved recovery tool against the running app without installing code."""
import base64
import hashlib
import subprocess
import sys
from pathlib import Path

TASK = Path(__file__).resolve().parent
SERVER = TASK.parents[1]
EVIDENCE = SERVER / 'artifacts/pob04042-ir-20261019'
APP = 'mbbs-operator-app-app-1'
mode = sys.argv[1]
assert mode in ['--preview', '--apply', '--verify']
for name in ['operator-netsuite-posting-adapter.js', 'operator-netsuite-posting-repository.js', 'operator-netsuite-posting-finalizer.js']:
    local = hashlib.sha256((SERVER / 'src' / name).read_bytes()).hexdigest()
    live = subprocess.check_output(['docker', 'exec', APP, 'sha256sum', 'src/' + name], text=True).split()[0]
    assert local == live, 'Live module changed: ' + name

def source(name):
    return (TASK / name).read_text().replace("'../../src/", "'file:///app/src/")

def data_url(text):
    return 'data:text/javascript;base64,' + base64.b64encode(text.encode()).decode()

proof = data_url(source('proof.mjs'))
recovery = data_url(source('recover.mjs').replace("'./proof.mjs'", repr(proof)))
main = source('live.mjs').replace("'./proof.mjs'", repr(proof)).replace("'./recover.mjs'", repr(recovery))
result = subprocess.run(['docker', 'exec', '-i', APP, 'node', '--input-type=module', '-', mode],
                        input=main, text=True, capture_output=True, timeout=90)
(EVIDENCE / (mode[2:] + '.json')).write_text(result.stdout)
(EVIDENCE / (mode[2:] + '.stderr.log')).write_text(result.stderr)
print(result.stdout)
if result.returncode:
    print(result.stderr, file=sys.stderr)
raise SystemExit(result.returncode)

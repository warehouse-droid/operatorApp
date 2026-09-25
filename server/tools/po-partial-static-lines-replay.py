"""Import the candidate in memory and build a receipt draft; never post it."""
import base64
import json
from pathlib import Path
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]


def data_url(source):
    return 'data:text/javascript;base64,' + base64.b64encode(source.encode()).decode()


def script(deployed=False):
    module = 'file:///app/src/operator-netsuite-posting-targets.js'
    if not deployed:
        helper = data_url((SERVER / 'src/operator-po-receipt-availability.js').read_text())
        source = (SERVER / 'src/operator-netsuite-posting-targets.js').read_text()
        source = source.replace('./operator-po-receipt-availability.js', helper)
        for quote in ['"', "'"]:
            source = source.replace('from ' + quote + './', 'from ' + quote + 'file:///app/src/')
        module = data_url(source)
    return (SERVER / 'tools/po-partial-static-lines-live.mjs').read_text().replace('TARGET_MODULE_URL', json.dumps(module))


if __name__ == '__main__':
    deployed = '--deployed' in sys.argv
    result = subprocess.run(['sudo', '-n', 'docker', 'exec', '-i', 'mbbs-operator-app-app-1', 'node', '--input-type=module'],
                            input=script(deployed), text=True, capture_output=True, timeout=180)
    if result.returncode:
        raise SystemExit(result.stderr)
    report = json.loads(result.stdout)
    artifact = SERVER / 'test-artifacts/po-partial-static-lines' / ('deployed-replay.json' if deployed else 'candidate-replay.json')
    artifact.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))

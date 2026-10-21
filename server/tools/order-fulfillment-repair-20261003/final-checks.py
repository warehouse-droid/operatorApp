"""Read-only release checks plus a rollback-only refresh rehearsal."""
import json
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
SERVER = HERE.parents[1]
OUT = Path('/home/ubuntu/operatorapp-investigations/operator-review-navigation-20261003')

def main():
    scan = """import fs from 'node:fs';
import {scanUnifiedDiff} from '/scan.mjs';
const findings=scanUnifiedDiff(fs.readFileSync('/change.patch','utf8'));
console.log(JSON.stringify({findings}));if(findings.length)process.exitCode=1;
"""
    r = subprocess.run(['docker', 'run', '--rm', '--network', 'none',
        '--mount', f'type=bind,src={SERVER}/test/support/scan-diff-secrets.mjs,dst=/scan.mjs,readonly',
        '--mount', f'type=bind,src={HERE}/operator-review.patch,dst=/change.patch,readonly',
        '--entrypoint', 'node', 'mbbs-regular-v2:e2e', '--input-type=module', '-e', scan],
        text=True, capture_output=True, check=True, timeout=60)
    secrets = json.loads(r.stdout)
    r = subprocess.run(['docker', 'exec', '-i', 'mbbs-operator-app-app-1',
        'node', '--input-type=module'], input=(HERE/'sync-verification.mjs').read_text(),
        text=True, capture_output=True, timeout=90)
    (OUT/'sync-verification.stderr').write_text(r.stderr)
    if r.returncode:
        raise RuntimeError(r.stderr[-1500:])
    sync = json.loads(r.stdout)
    (OUT/'sync-verification.json').write_text(json.dumps(sync, indent=2)+'\n')
    (OUT/'secret-scan.json').write_text(json.dumps(secrets, indent=2)+'\n')
    print(json.dumps({'secretScan': secrets, 'deployedRefresh': sync}))

if __name__ == '__main__':
    main()

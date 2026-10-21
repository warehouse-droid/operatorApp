"""Run the native-UOM gauntlet offline using only the cached test toolchain."""
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
BASELINE = ROOT / 'tools/special-unit-identity-20261005/baseline'
OUT = ROOT / 'test-artifacts/special-unit-identity-20261005'
OUT.mkdir(exist_ok=True)
IMAGE = 'sha256:087db416dc024ccf13e0b7ea732853e2e93ce3561937f1e301a540a9aab098c7'
args = ['docker', 'run', '--rm', '--network', 'none', '--memory', '2g', '--cpus', '1',
        '--name', 'mbbs-special-unit-identity-validation-active',
        '--label', 'mbbs.task=special-unit-identity-20261005', '--workdir', '/app',
        '--env', 'MBT_TEST_ISOLATED=1', '--env', 'NETSUITE_DIRECT_ACCESS_ENABLED=false',
        '--env', 'MBBS_ENV_FILE=/nonexistent']
for directory in ['src', 'public', 'test', 'tools', 'migrations']:
    args += ['--mount', f'type=bind,src={ROOT / directory},dst=/app/{directory},readonly']
for file in ['package.json', 'package-lock.json', 'netsuite-smart-scm-picking-ticket-restlet.js']:
    args += ['--mount', f'type=bind,src={ROOT / file},dst=/app/{file},readonly']
args += ['--mount', f'type=bind,src={BASELINE},dst=/baseline,readonly',
         '--mount', f'type=bind,src={OUT},dst=/app/test-artifacts/special-unit-identity-20261005',
         IMAGE, 'node', 'tools/special-unit-identity-20261005/gauntlet.mjs']
result = subprocess.run(args, capture_output=True, text=True)
(OUT / 'runner.log').write_text(result.stdout + result.stderr)
print(json.dumps({'exitCode': result.returncode, 'output': (result.stdout + result.stderr)[-7000:]}))
raise SystemExit(result.returncode)

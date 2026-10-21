"""Reproduce the focused checks using the existing isolated runner."""
from pathlib import Path
import os
import subprocess

server = Path(__file__).resolve().parents[1]
artifacts = str(server / 'test-artifacts/special-operation-progress')
subprocess.run(['sudo', '-n', 'chown', '-R', f'{os.getuid()}:{os.getgid()}', artifacts], check=True)
subprocess.run(['python3', str(server / 'tools/special-operation-progress-diff.py')], check=True)
subprocess.run(['sudo', '-n', 'docker', 'cp', str(server / 'test-artifacts/special-operation-progress'), 'mbbs-special-review-runner:/app/test-artifacts/'], check=True)
result = subprocess.run(['sudo', '-n', 'docker', 'exec', '-e', 'MBT_TEST_ISOLATED=1', '-e', 'PLAYWRIGHT_BROWSERS_PATH=/browsers',
                         '-e', 'DATABASE_URL=postgres://mbt_test:special_review_only@mbbs-special-review-db:5432/mbt_verify',
                         '-w', '/app', 'mbbs-special-review-runner', 'node', 'tools/special-operation-progress-check.mjs'])
subprocess.run(['sudo', '-n', 'docker', 'cp', 'mbbs-special-review-runner:/app/test-artifacts/special-operation-progress/.', str(server / 'test-artifacts/special-operation-progress')], check=True)
subprocess.run(['sudo', '-n', 'chown', '-R', f'{os.getuid()}:{os.getgid()}', artifacts], check=True)
raise SystemExit(result.returncode)

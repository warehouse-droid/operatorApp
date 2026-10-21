"""Reproduce all checks from the recorded candidate in the isolated runner."""
import importlib.util
from pathlib import Path
import sys

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('case_edit_verification', SERVER / 'tools/special-case-edits-run.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
runner.sync()
status = runner.run('reproduced-checks', ['node', 'tools/special-case-edits-check.mjs'])
runner.collect()
sys.exit(status)

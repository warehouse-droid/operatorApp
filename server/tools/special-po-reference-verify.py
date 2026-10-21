"""Reproduce all checks from the recorded candidate in the isolated runner."""
import importlib.util
from pathlib import Path
import sys

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('po_reference_verification', SERVER / 'tools/special-po-reference-run.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
runner.sync()
status = runner.run('reproduced-checks', ['node', 'tools/special-po-reference-check.mjs'])
runner.collect()
sys.exit(status)

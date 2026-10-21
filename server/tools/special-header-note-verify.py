"""Reproduce all checks from the recorded candidate in the isolated runner."""
import importlib.util
from pathlib import Path
import sys

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('header_note_verification', SERVER / 'tools/special-header-note-run.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
runner.sync()
status = runner.run('reproduced-checks', ['node', 'tools/special-header-note-check.mjs'])
runner.collect()
sys.exit(status)

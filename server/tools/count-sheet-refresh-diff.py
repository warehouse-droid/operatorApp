"""Regenerate the auditable changed-line map before running the check entrypoint."""
import difflib
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
result = {}
for file in json.loads((root/'tools/count-sheet-refresh-files.json').read_text()):
    source = (root/file).read_text()
    prior = root/'test/support/count-sheet-refresh-baseline'/file
    before = prior.read_text() if prior.exists() else ''
    lines = [i+1 for tag, _, _, first, last in difflib.SequenceMatcher(None, before.splitlines(), source.splitlines()).get_opcodes()
             if tag in ('replace', 'insert') for i in range(first, last)]
    result[file] = {'sha256': hashlib.sha256(source.encode()).hexdigest(), 'lines': lines}
(root/'test/support/count-sheet-refresh-changed-lines.json').write_text(json.dumps(result, indent=2)+'\n')

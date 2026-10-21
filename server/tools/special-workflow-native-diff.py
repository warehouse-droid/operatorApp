"""Generate only this release's diff against the captured running release."""
from pathlib import Path
import json
import difflib

server = Path(__file__).resolve().parents[1]
output = server/'test-artifacts/special-workflow-review/native-documents'
chunks = []
for file in json.loads((output/'runtime-files.json').read_text()):
    baseline = output/'baseline'/file
    before = baseline.read_text() if baseline.exists() else ''
    after = (server/file).read_text()
    chunks.extend(difflib.unified_diff(before.splitlines(True),after.splitlines(True),fromfile='a/server/'+file,tofile='b/server/'+file,n=0))
(output/'runtime.diff').write_text(''.join(chunks))

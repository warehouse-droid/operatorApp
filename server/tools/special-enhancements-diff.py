from pathlib import Path
import difflib
import json
root=Path(__file__).resolve().parents[1]
out=root/'test-artifacts/special-workflow-review/request-enhancements-20260928'
patch=''
for name in json.loads((out/'runtime-files.json').read_text()):
    baseline=out/'baseline'/name
    patch+=''.join(difflib.unified_diff(baseline.read_text().splitlines(True) if baseline.exists() else [],(root/name).read_text().splitlines(True),fromfile='a/server/'+name,tofile='b/server/'+name,n=0))
(out/'runtime.diff').write_text(patch)

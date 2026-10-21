import hashlib,json,subprocess,tempfile
from pathlib import Path
root=Path(__file__).resolve().parents[1]
out=root/'test-artifacts/regular-waitlist'
sha=lambda data:hashlib.sha256(data).hexdigest()
result={}
for file in json.loads((root/'tools/regular-waitlist-files.json').read_text()):
    source=root/file;before=out/'before'/file
    if not file.endswith('.js'):continue
    with tempfile.NamedTemporaryFile() as blank:
        diff=subprocess.run(['git','diff','--no-index','--unified=0','--',str(before if before.exists() else Path(blank.name)),str(source)],capture_output=True,text=True)
        assert diff.returncode in [0,1],diff.stderr
    result[file]={'sourceHash':sha(source.read_bytes()),'baselineHash':sha(before.read_bytes()) if before.exists() else None,'diff':diff.stdout}
(out/'changed-diffs.json').write_text(json.dumps({'files':result},indent=2))
print(json.dumps({'scopedDiffs':len(result)}))

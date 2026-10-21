"""Freeze a controlled before/after pair; leave unrelated workspace changes equal."""
import hashlib
import json
from pathlib import Path
import shutil

SERVER=Path(__file__).resolve().parents[1]
OUT=SERVER/'test-artifacts/damage-posting-retry-20261001'
FILES=json.loads((SERVER/'tools/damage-posting-retry-files.json').read_text())
final=OUT/'comparison-final'
baseline=OUT/'comparison-baseline'
assert not final.exists() and not baseline.exists(), 'Do not overwrite a frozen test source'
final.mkdir()
for folder in ['src','public','test','tools','migrations','contracts']:
    shutil.copytree(SERVER/folder,final/folder)
for file in list(SERVER.glob('*.json'))+list(SERVER.glob('*.js'))+[SERVER/'Dockerfile']:
    shutil.copy2(file,final/file.name)
shutil.copytree(final,baseline)
for name in FILES:
    old=OUT/'baseline-source'/name
    target=baseline/name
    if old.exists(): shutil.copy2(old,target)
    elif target.exists(): target.unlink()
def hashes(root):
    return {str(file.relative_to(root)):hashlib.sha256(file.read_bytes()).hexdigest()
            for file in root.rglob('*') if file.is_file()}
before,after=hashes(baseline),hashes(final)
diff=sorted(file for file in set(before)|set(after) if before.get(file)!=after.get(file))
assert set(diff)==set(FILES),diff
metadata={'changedFiles':diff,'baselineHashes':before,'finalHashes':after,
          'note':'Same current 759-file MBT suite and unrelated source; only the 14 damage runtime files differ.'}
(OUT/'frozen-comparison.json').write_text(json.dumps(metadata,indent=2)+'\n')
for label in ['baseline','final']:
    for suffix in ['full.log','timeouts.json']:
        file=OUT/(label+'-'+suffix)
        if file.exists(): file.rename(OUT/(label+'-initial-'+suffix))
print(json.dumps({'frozen':True,'changedFiles':diff,'files':len(after)}))

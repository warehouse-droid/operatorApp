"""Capture only this task's diff against its pre-edit snapshot."""
import argparse,difflib,json
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument('--baseline',required=True);args=parser.parse_args()
root=Path(__file__).resolve().parents[1];baseline=Path(args.baseline);patch=[]
for file in json.loads((root/'tools/regular-stock-stocking-files.json').read_text()):
 old=baseline/file
 patch.extend(difflib.unified_diff(old.read_text().splitlines(True) if old.exists() else [],(root/file).read_text().splitlines(True),fromfile='a/server/'+file,tofile='b/server/'+file,n=3))
(root/'test/regular-stock-stocking.changes.patch').write_text(''.join(patch))
print('Captured task-only patch')

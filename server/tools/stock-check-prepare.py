#!/usr/bin/env python3
"""Merge only this task's shared-file changes into captured live application source."""
import hashlib,json,pathlib,shutil,subprocess
root=pathlib.Path(__file__).resolve().parents[1]
release=root/'deployments/stock-check-20261014'
candidate=release/'candidate'
base=root/'test-artifacts/stock-check/workspace-before'
shared=['src/server.js','public/app-sidebar.js','public/scm-menu.html','package.json','package-lock.json','Dockerfile']
pins=json.loads((release/'shared-live-pins.json').read_text())['files'] if (release/'shared-live-pins.json').exists() else []
for filename in shared:
    destination=candidate/filename
    if filename in pins:
        shutil.copy2(release/'availability-shared-live'/filename,destination)
    elif (base/filename).exists():
        result=subprocess.run(['git','merge-file','-p',str(root/filename),str(base/filename),str(release/'before'/filename)],capture_output=True)
        if result.returncode: raise RuntimeError('Resolve source merge before release: '+filename)
        destination.write_bytes(result.stdout)
    else: shutil.copy2(root/filename,destination)
shutil.copytree(root/'src/stock-check',candidate/'src/stock-check',dirs_exist_ok=True)
for filename in ['public/scm-stock-check.html','public/scm-stock-check.js','public/scm-stock-check.css','migrations/288_stock_check_module.sql']:
    shutil.copy2(root/filename,candidate/filename)
hashes={str(p.relative_to(candidate)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(candidate.rglob('*')) if p.is_file()}
(release/'candidate-source.json').write_text(json.dumps(hashes,indent=2)+'\n')
print(json.dumps({'candidate':str(candidate),'files':len(hashes),'sourceHash':hashlib.sha256(json.dumps(hashes,sort_keys=True).encode()).hexdigest()}))

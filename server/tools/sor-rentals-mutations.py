"""Run intentional faults in isolated source mounts, never in the working files."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
root=Path(__file__).resolve().parents[1]
artifact=root/'test-artifacts/sor-rentals'
mutants=[
 ('inventory','src/sor-rental-policy.js','!fee && !inventory && namedRental','!fee && namedRental','test/dispatch/unit/sor-rental-policy.test.js'),
 ('override','src/sor-rental-policy.js','override ?? defaultAutoReturn','defaultAutoReturn','test/dispatch/unit/sor-rental-policy.test.js'),
 ('mixed-content','src/sor-rental-policy.js','item.sorAutoReturn === true && Number','true && Number','test/dispatch/unit/sor-rental-policy.test.js'),
 ('split-identity','src/sor-rental-policy.js','refNumber:`${order.id}-Return`',"refNumber:`${order.id.replace(/-S[0-9]+$/u,'')}-Return`",'test/dispatch/unit/sor-rental-policy.test.js'),
 ('completed-history','src/sor-rental-repository.js',"previous?.status==='completed'",'false','test/dispatch/integration/sor-rental-repository.test.js'),
 ('outstanding-billed-return','src/sor-rental-service.js','if(delivered || source.preserveMissing)','if(false)','test/dispatch/integration/sor-return-lifecycle.test.js'),
 ('metadata-sync','src/sor-rental-service.js','await upsertSorItemMetadata(rows);','await upsertSorItemMetadata([]);','test/dispatch/integration/sor-return-lifecycle.test.js'),
 ('driver-prompt','src/driver-repository.js','if (signatureRefs.length) {','if (false) {','test/dispatch/integration/sor-signature-evidence.test.js')
]
results=[]
for name,file,old,new,test in mutants:
 source=(root/file).read_text();assert source.count(old)==1,(name,'mutant target changed')
 location=artifact/'mutants'/name;target=location/file;target.parent.mkdir(parents=True,exist_ok=True);target.write_text(source.replace(old,new,1))
 env={**os.environ,'SOR_MUTANT_ROOT':str(location),'SOR_TEST_DATABASE':'mbt_test_file_50a188aabbcc_focus'}
 modes=[('focused',['node','--test',test]),('property',['node','--test','--test-name-pattern=property','test/dispatch/unit/sor-rental-policy.test.js'])]
 for mode,command in modes:
  with (artifact/f'mutant-{name}-{mode}.log').open('w') as log:
   result=subprocess.run(['bash','tools/sor-rentals-test-env.sh','run','current',*command],cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT)
  results.append({'mutant':name,'mode':mode,'killed':result.returncode!=0,'exitCode':result.returncode})
 assert hashlib.sha256((root/file).read_bytes()).hexdigest()==hashlib.sha256(source.encode()).hexdigest()
(artifact/'mutations.json').write_text(json.dumps(results,indent=2))
print(json.dumps(results,indent=2))
assert all(row['killed'] for row in results if row['mode']=='focused')

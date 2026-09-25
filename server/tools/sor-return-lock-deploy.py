"""Release the worker lock fix after the SOR gate has been deployed OFF."""
import importlib.util
import json
import os
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('sor_gate_release',ROOT/'tools/sor-feature-gate-deploy.py')
gate=importlib.util.module_from_spec(spec);spec.loader.exec_module(gate)
core=gate.core
gate.BASE='sha256:f7f1c236d3a41bca704769f823f8782aba662bb46d0d619d3214eb8e5e2f985e'
core.RELEASE=Path('/home/ubuntu/operatorapp-deploy-backups/sor-return-lock-20260924-v1')
core.BEFORE=Path('/home/ubuntu/operatorapp-deploy-backups/sor-feature-gate-20260924-v1/candidate')
core.EXISTING=['src/sor-rental-service.js','src/sor-feature-gate.js','src/netsuite.js'];core.ADDED=[];core.FILES=sorted(core.EXISTING)
core.IMAGE='mbbs-operator-app:sor-return-lock-20260924-v1'
core.ROLLBACK='mbbs-operator-app:rollback-sor-return-lock-20260924-v1'

def validate():
 state=core.manifest();core.current(state)
 log=(gate.ART/'final-focused.log').read_text()
 assert '# fail 0' in log and '# pass 0' not in log
 for report in ['gate-browser.json','gate-focused.json']:
  result=json.loads((ROOT/'test-artifacts/sor-rentals'/report).read_text())
  assert result['passed'] and result['sourceHashes']==state['after'],report+' source mismatch'
 assert json.loads((gate.ART/'static.json').read_text())['passed']
 assert json.loads((gate.ART/'mutations.json').read_text())['passed']
 assert 'REGRESSION ASSERTION: SOR/catalog deadlock' in (gate.ART/'browser-lock-red.log').read_text()
 core.save('verified.json',{'passed':True,'imageId':state['candidateImageId'],'sources':state['after']})
 print('SOR lock candidate verified')

if __name__=='__main__':
 os.umask(0o077)
 {'prepare':gate.prepare,'build':core.build,'validate':validate,'apply':gate.apply,'verify':gate.verify}[sys.argv[1]]()

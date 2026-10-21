"""Back up, review, apply and verify the explicitly authorized historical repair."""
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import zipfile

SERVER=Path(__file__).resolve().parents[1]
OUT=SERVER/'test-artifacts/damage-posting-retry-20261001'
RELEASE=SERVER/'deployments/damage-posting-retry-20261001'
APP='mbbs-operator-app-app-1'
os.umask(0o077)
def run(file,args=(),extra=()):
    script=SERVER/'tools'/file
    result=subprocess.run(['sudo','-n','docker','exec','-i','-w','/app',*extra,APP,
                           'node','--input-type=module','-',*args],input=script.read_bytes(),capture_output=True,timeout=120)
    (OUT/(file+'.stderr.log')).write_bytes(result.stderr)
    assert result.returncode==0,result.stderr.decode()[-2500:]
    return result.stdout
def deployed():
    actual=subprocess.check_output(['sudo','-n','docker','inspect','--format','{{.Image}}',APP]).decode().strip()
    assert actual==json.loads((RELEASE/'result.json').read_text())['imageId'],'Live app changed; verify before repairing'
def backup():
    data=run('damage-posting-retry-live-inspect.mjs')
    snapshot=json.loads(data);assert snapshot['stockWrites']==0
    target=OUT/'live-before-recovery.json';target.write_bytes(data);target.chmod(0o600)
    subprocess.run(['sudo','-n','docker','exec','-i',APP,'node','-e',
                    'require("fs").writeFileSync("/tmp/damage-posting-retry-live-before.json",require("fs").readFileSync(0),{mode:0o600})'],input=data,check=True)
    print(json.dumps({'backedUp':True,'reports':len(snapshot['reports']),'stockWrites':0,'sha256':hashlib.sha256(data).hexdigest()}))
def plan():
    deployed()
    result=run('damage-posting-retry-recover.mjs',['--link-september-adjusted'])
    (OUT/'live-plan.json').write_bytes(result)
    print(result.decode().strip())
def apply():
    deployed()
    backup_bytes=(OUT/'live-before-recovery.json').read_bytes()
    sha=hashlib.sha256(backup_bytes).hexdigest()
    result=run('damage-posting-retry-recover.mjs',['--apply','--link-september-adjusted'],
               ['-e','DAMAGE_RETRY_BACKUP_SHA='+sha])
    (OUT/'live-recovery.json').write_bytes(result)
    receipt=json.loads(result)
    (OUT/'live-recovery-authorization.json').write_text(json.dumps({
      'userInstructions':['Resolve all related issues and perform the fix',
                          'Same event — post once in October',
                          'Yes — keep 10 PC and link the original report'],
      'backupSha256':sha,'recoveryScriptSha256':hashlib.sha256((SERVER/'tools/damage-posting-retry-recover.mjs').read_bytes()).hexdigest(),
      'newStockWrites':receipt['stockWrites']},indent=2)+'\n')
    print(json.dumps({'applied':receipt['applied'],'stockWrites':receipt['stockWrites'],
                      'transfer':receipt['transfer'],'reports':receipt['reports']}))
def verify():
    deployed()
    result=run('damage-posting-retry-live-verify.mjs')
    (OUT/'live-verified.json').write_bytes(result)
    receipt=json.loads(result);archives=[]
    for label,month in [('september','2026-09'),('october','2026-10')]:
      data=subprocess.check_output(['sudo','-n','docker','exec',APP,'cat','/tmp/damage-repaired-'+month+'.zip'])
      archive=zipfile.ZipFile(io.BytesIO(data));assert archive.testzip() is None
      expected=receipt[label]['originalImages'];assert len(archive.namelist())==len(expected)
      for name,image in zip(archive.namelist(),expected):
        assert name.startswith(image['name']+'.'),name
        photo=archive.read(name);assert len(photo)==image['bytes']
        assert hashlib.sha256(photo).hexdigest()==image['sha256']
      (OUT/('live-'+month+'.zip')).write_bytes(data)
      archives.append({'month':month,'photos':len(expected),'names':archive.namelist(),'originalBytesMatch':True})
    (OUT/'live-zip-check.json').write_text(json.dumps(archives,indent=2)+'\n')
    print(json.dumps({'verified':True,'stockWrites':0,'reportsUnchanged':receipt['reportsUnchanged'],
                      'october':receipt['october']['lines'],'september':receipt['september']['lines'],
                      'reviewMs':{label:receipt[label]['totalMs'] for label in ['october','september']},'archives':archives}))
if __name__=='__main__':
    {'backup':backup,'plan':plan,'apply':apply,'verify':verify}[sys.argv[1]]()

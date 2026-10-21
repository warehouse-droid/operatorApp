"""Verify the uploaded NetSuite RESTlet through read-only health and PDF actions."""
from pathlib import Path
import re
import subprocess

server = Path(__file__).resolve().parents[1]
command = ['sudo','-n','docker','exec','-i','-w','/app','mbbs-operator-app-app-1']
source = subprocess.check_output(command+['cat','src/netsuite.js']).decode()
source = re.sub(r'from ([\'"])(\./[^\'"]+)\1', lambda m: 'from '+m[1]+'file:///app/src/'+m[2][2:]+m[1], source)
source += """
const {closeDb}=await import('file:///app/src/db.js');
try {
 const health=await probeNetSuiteRestlet({requireSandbox:false});
 const results=[];
 for(const [action,entityId] of [['salesOrderPdf',1017068],['purchaseOrderPdf',1017168]]){
  const result=await configuredRestletJson({action,entityId,includeContent:true});
  const bytes=Buffer.from(result.contentBase64 || '', 'base64');
  if(result.ok!==true || result.action!==action || Number(result.entityId)!==entityId || bytes.subarray(0,5).toString()!=='%PDF-')throw Error('Wrong native PDF identity');
  results.push({action,entityId,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
 }
 console.log(JSON.stringify({version:health.version,capabilities:health.capabilities,readOnly:true,documents:results}));
}finally{await closeDb();}
"""
result = subprocess.check_output(command+['node','--input-type=module','-'], input=source.encode())
(server/'test-artifacts/special-workflow-review/native-documents/restlet-live.json').write_bytes(result)
print(result.decode().strip())

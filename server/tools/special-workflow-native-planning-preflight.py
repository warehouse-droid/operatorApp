"""Read-only benchmark of the compact planning query against production."""
from pathlib import Path
import subprocess

server = Path(__file__).resolve().parents[1]
source = (server / 'src/special-stock-planning.js').read_text().replace("'./db.js'", "'file:///app/src/db.js'")
script = source + """
const {withTransaction,closeDb}=await import('file:///app/src/db.js');
try{await withTransaction(async()=>{
 await query('SET TRANSACTION READ ONLY');
 const start=Date.now(),plans=await readSpecialDispatchPlans();
 console.log(JSON.stringify({readOnly:true,plans:plans.length,bytes:Buffer.byteLength(JSON.stringify(plans)),elapsedMs:Date.now()-start}));
});}finally{await closeDb();}
"""
result = subprocess.check_output(['sudo','-n','docker','exec','-i','-w','/app','mbbs-operator-app-app-1','node','--input-type=module','-'],input=script.encode())
(server / 'test-artifacts/special-workflow-review/native-documents/planning-preflight.json').write_bytes(result)
print(result.decode().strip())

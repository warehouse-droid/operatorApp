"""Read-only live preflight using staged candidate modules, never app hot-patching."""
from pathlib import Path
import json
import re
import subprocess

server = Path(__file__).resolve().parents[1]
directory = '/tmp/special-rest-orders-candidate'
files = ['src/netsuite.js', 'src/special-stock-rest-orders.js',
         'src/special-stock-adjustment-adapter.js', 'public/special-stock-pricing.js']
staged = {}
for file in files:
    def replace(match):
        target = (server / file).parent.joinpath(match[3]).resolve().relative_to(server).as_posix()
        base = directory if target in files else '/app'
        return match[1] + match[2] + 'file://' + base + '/' + target + match[2]
    staged[file] = re.sub(r'((?:from\s+|import\s*\()\s*)([\'"])(\.\.?/[^\'"]+)\2', replace, (server / file).read_text())
script = """const fs=await import('node:fs');const path=await import('node:path');
const directory=DIRECTORY,files=FILES;
for(const [file,source] of Object.entries(files)){const target=directory+'/'+file;fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});fs.writeFileSync(target,source,{mode:0o600});}
fs.writeFileSync(directory+'/package.json','{"type":"module"}',{mode:0o600});
const assert=(await import('node:assert/strict')).default;
const db=await import('file:///app/src/db.js');
const ns=await import('file://'+directory+'/src/netsuite.js');
const {withOperatorNetSuitePriority}=await import('file:///app/src/operator-netsuite-request-pool.js');
try{await withOperatorNetSuitePriority(async()=>{
 const description='Unilock Ltd Endura Coping Lineo Buff 123test';
 const plan=await ns.prepareSpecialAdjustmentPlanInNetSuite({orders:[
  {id:1017068,kind:'sales_order',lines:[{remoteLineId:5028178,itemId:2055,quantity:50,rate:17,unitId:865,description,
   toQuantity:50,toRate:20,nativeDiscountPercent:null,toNativeDiscountPercent:15}]},
  {id:1017168,kind:'purchase_order',lines:[]}]});
 assert.deepEqual(plan.orders[0].target.lines.map(line=>[line.itemId,line.quantity,line.rate]),[[2055,50,'20'],[10716,null,'-150'],[1784,11,'40']]);
 assert.equal(plan.orders[0].target.lines[0].remoteLineId,5028178);
 assert.equal(plan.orders[0].target.lines[2].remoteLineId,null);
 assert.deepEqual(plan.orders[1].target,plan.orders[1].baseline);
 fs.writeFileSync('/tmp/special-rest-orders-preflight.private.json',JSON.stringify(plan),{mode:0o600});
 console.log(JSON.stringify({prepared:true,order:'SOB121380',transport:plan.transport,discountMode:plan.discountMode,
  targetLines:plan.orders[0].target.lines.map(line=>[line.itemId,line.quantity,line.rate]),purchaseOrderUnchanged:true,writes:0}));
});}finally{await db.closeDb();}process.exit(0);
""".replace('DIRECTORY', json.dumps(directory)).replace('FILES', json.dumps(staged))
result = subprocess.run(['sudo', '-n', 'docker', 'exec', '-i', '-w', '/app', 'mbbs-operator-app-app-1', 'node', '--input-type=module', '-'], input=script.encode())
raise SystemExit(result.returncode)

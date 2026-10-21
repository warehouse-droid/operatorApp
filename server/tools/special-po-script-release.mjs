// Publish only the exact active Special PO RESTlet; no financial record writes.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const root=process.cwd();
const {config}=await import(pathToFileURL(`${root}/src/config.js`));
const {getNetSuiteM2mAccessToken}=await import(pathToFileURL(`${root}/src/netsuite-m2m-runtime.js`));
const {probeNetSuiteRestlet}=await import(pathToFileURL(`${root}/src/netsuite.js`));
const {closeDb}=await import(pathToFileURL(`${root}/src/db.js`));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const expected='e61a9d0e3d7c26dee77bf305433daf04f227e9d58132383ac9d08bac574964c0';
try {
  const token=await getNetSuiteM2mAccessToken(),url=config.netsuite.restBaseUrl+'/document/v1/file/179090/content';
  const headers={Authorization:`Bearer ${token}`,Accept:'text/javascript'};
  const read=async()=>{const r=await fetch(url,{headers});assert.equal(r.status,200);return r.text();};
  const before=await read(),health=await probeNetSuiteRestlet({requireSandbox:false});
  assert.equal(health.scriptId,'customscript_mbbs_picking_ticket_restlet');assert.equal(health.deploymentId,'customdeploy1');
  const replacement=readFileSync('/tmp/special-po-native-3.3.0.js','utf8');
  assert.match(replacement,/const VERSION = "3\.3\.0"/);
  if(digest(before)===digest(replacement)) {assert.equal(health.capabilities.createSpecialPurchaseOrder,true);console.log(JSON.stringify({alreadyPublished:true,fileId:179090,version:health.version,sha256:digest(before)}));}
  else {
    assert.equal(digest(before),expected,'Deployed script changed');assert.equal(health.version,'3.2.2');
    if(!process.argv.includes('--apply')) console.log(JSON.stringify({readOnly:true,fileId:179090,before:expected,after:digest(replacement),ready:true}));
    else {
      const update=async content=>{const r=await fetch(url,{method:'PATCH',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/octet-stream',Accept:'application/json'},body:content});assert.equal(r.status,204,await r.text());};
      await update(replacement);
      try {
        assert.equal(digest(await read()),digest(replacement));
        const after=await probeNetSuiteRestlet({requireSandbox:false});
        assert.equal(after.version,'3.3.0');assert.equal(after.capabilities.createSpecialPurchaseOrder,true);
        console.log(JSON.stringify({published:true,fileId:179090,version:after.version,sha256:digest(replacement),nativeCapability:true}));
      }catch(e){await update(before);assert.equal(digest(await read()),expected);throw e;}
    }
  }
}finally{await closeDb();}

// Read-only check of the deployed review and the real IT00571 original photo.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {query,pool} from '/app/src/db.js';
import {reviewControlDamageMonth} from '/app/src/control-damage-review.js';
import {createDamageNetSuite} from '/app/src/inventory-damage-netsuite.js';
import {activeNetSuiteLocationDirectory,inventoryTransferRest,suiteqlAll} from '/app/src/netsuite.js';
import {assertDamagePhotoAccess} from '/app/src/inventory-damage-repository.js';
import {readArchivedPhoto} from '/app/src/photo-archive-repository.js';
import {createPhotoReadToken} from '/app/src/photo-upload.js';
import {withOperatorNetSuitePriority} from '/app/src/operator-netsuite-request-pool.js';

const actor={id:'damage-photos-read-only-check',role:'admin',roles:['admin']};
const reportId='bd4d6c99-5431-4dea-b51a-b0d9c86dc46f';
const timings=[];
const timed=(name,fn)=>async(...args)=>{
  const start=performance.now();try {return await fn(...args);}
  finally {timings.push({name,ms:Math.round(performance.now()-start)});}
};
const remote=createDamageNetSuite({
  rest:async(path,options)=>{
    assert.ok(!options?.method || options.method==='GET','Read-only verification cannot write stock');
    return timed('transfer '+path,inventoryTransferRest)(path,options);
  },directory:timed('yard directory',activeNetSuiteLocationDirectory),
  sql:async(sql)=>timed(sql.includes('transactionline')?'units query':'damage transfer list',suiteqlAll)(sql)
});
try {
  const before=(await query('SELECT * FROM inventory_damage_reports WHERE id=$1',[reportId])).rows[0];
  assert.ok(before);
  const start=performance.now();
  const review=await withOperatorNetSuitePriority(()=>reviewControlDamageMonth(actor,1,'2026-10',{remote}));
  const totalMs=Math.round(performance.now()-start);
  assert.equal(review.syncError,null);
  const transfer=review.transfers.find(row=>row.ref==='IT00571');assert.ok(transfer);
  const line=transfer.lines.find(row=>row.line===1);
  assert.equal(line.reportId,reportId);assert.equal(line.photos.length,1);
  assert.equal(line.itemName,'UNI-PISAS-COP-SAFARI');
  assert.deepEqual((await query('SELECT * FROM inventory_damage_reports WHERE id=$1',[reportId])).rows[0],before);
  assert.ok(!timings.some(row=>row.name==='units query'));

  const context={window:{},TextEncoder,Uint8Array,DataView,Blob};
  vm.runInNewContext(readFileSync('/app/public/damage-photo-download.js','utf8'),context);
  const download=context.window.MBBSDamagePhotoDownload;
  const entries=download.entriesForReview(review),images=[];
  const target=entries.find(entry=>entry.reference===line.photos[0]);assert.ok(target);
  assert.equal(target.name,'IT00571_line-001_UNI-PISAS-COP-SAFARI_photo-01');
  const archive=await download.archive(entries,async(reference)=>{
    await assertDamagePhotoAccess(actor,reference);
    const archived=await readArchivedPhoto(reference);
    let bytes,type;
    if(archived?.available) {bytes=archived.bytes;type=archived.contentType;}
    else {
      assert.ok(!archived?.remoteDeleted,'Original photo unavailable');
      const ticket=createPhotoReadToken({actor,key:reference});
      const response=await fetch(ticket.objectUrl,{headers:{Authorization:`Bearer ${ticket.token}`},signal:AbortSignal.timeout(30000)});
      assert.equal(response.status,200);bytes=Buffer.from(await response.arrayBuffer());type=response.headers.get('content-type');
    }
    assert.ok(bytes.length>0);assert.match(type,/^image\//);
    images.push({type,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
    return new Blob([bytes],{type});
  });
  assert.equal(archive.type,'application/zip');assert.ok(archive.size>images.reduce((sum,image)=>sum+image.bytes,0));
  console.log(JSON.stringify({deployedCode:true,totalMs,timings,transfer:transfer.ref,line:line.line,sku:line.itemName,
    photos:line.photos.length,reportStatus:before.status,stockWrites:0,reportUnchanged:true,
    downloadName:target.name,downloadPhotos:entries.length,originalImages:images,zipBytes:archive.size}));
} finally {await pool.end();}

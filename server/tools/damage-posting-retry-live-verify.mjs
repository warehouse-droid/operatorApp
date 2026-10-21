// Read-only verification of both repaired transfers and every original photo.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {query,pool} from '/app/src/db.js';
import {reviewControlDamageMonth} from '/app/src/control-damage-review.js';
import {createDamageNetSuite} from '/app/src/inventory-damage-netsuite.js';
import {activeNetSuiteLocationDirectory,inventoryTransferRest,suiteqlAll} from '/app/src/netsuite.js';
import {damageRow,assertDamagePhotoAccess} from '/app/src/inventory-damage-repository.js';
import {readArchivedPhoto} from '/app/src/photo-archive-repository.js';
import {createPhotoReadToken} from '/app/src/photo-upload.js';
import {withOperatorNetSuitePriority} from '/app/src/operator-netsuite-request-pool.js';
const actor={id:'damage-retry-read-only-check',role:'admin',roles:['admin']};
const ids=['63794073-25d1-4911-b2e5-c7fc584fdefb','a203380a-4471-4cf4-b57a-4a6413f69227',
  'bd4d6c99-5431-4dea-b51a-b0d9c86dc46f','5f2c9876-8fc8-4ac5-bdc3-9ce8f1e9cce1'];
const remote=createDamageNetSuite({
  rest:async(path,options)=>{assert.ok(!options?.method || options.method==='GET','Verification is read-only');return inventoryTransferRest(path,options);},
  directory:activeNetSuiteLocationDirectory,sql:suiteqlAll
});
const before=await Promise.all(ids.map(damageRow));
const imageResults=new Map();
const context={window:{},TextEncoder,Uint8Array,DataView,Blob};
vm.runInNewContext(readFileSync('/app/public/damage-photo-download.js','utf8'),context);
const download=context.window.MBBSDamagePhotoDownload;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
try {
  const result={stockWrites:0,reportsUnchanged:true};
  for(const [label,month,ref] of [['september','2026-09','IT00551'],['october','2026-10','IT00571']]) {
    const start=performance.now();
    const review=await withOperatorNetSuitePriority(()=>reviewControlDamageMonth(actor,1,month,{remote}));
    const totalMs=Math.round(performance.now()-start);assert.equal(review.syncError,null);
    const transfer=review.transfers.find(row=>row.ref===ref);assert.ok(transfer);
    assert.ok(!review.reports.some(row=>ids.includes(row.id) && row.status==='attention'));
    if(label==='september') {
      const pisa=transfer.lines.find(row=>row.reportId===ids[0]);assert.equal(pisa.line,3);assert.equal(pisa.quantity,10);assert.equal(pisa.reasonId,7);assert.equal(pisa.photos.length,1);
      assert.equal(Number(pisa.original.quantity),9);assert.equal(Number(pisa.original.reason_id),6);
      const ucara=review.reports.find(row=>row.id===ids[1]);assert.equal(ucara.status,'superseded');assert.equal(ucara.safe_to_retry,false);assert.equal(ucara.superseded_by,ids[3]);assert.equal(ucara.photos.length,1);
      assert.equal(transfer.lines.filter(row=>row.itemName==='UNI-UCARA-COR-SM-DC').length,0);
    } else {
      const pisa=transfer.lines.filter(row=>row.itemName==='UNI-PISAS-COP-SAFARI');assert.equal(pisa.length,1);assert.equal(pisa[0].reportId,ids[2]);assert.equal(pisa[0].quantity,18);assert.equal(pisa[0].photos.length,1);
      const ucara=transfer.lines.filter(row=>row.itemName==='UNI-UCARA-COR-SM-DC');assert.equal(ucara.length,1);assert.equal(ucara[0].reportId,ids[3]);assert.equal(ucara[0].quantity,27.09);assert.equal(ucara[0].unit,'SQFT');assert.equal(ucara[0].photos.length,1);
      assert.equal(ucara[0].line,before.find(row=>row.id===ids[3]).transfer_line);
      assert.equal(transfer.lines.length,2);
    }
    const entries=download.entriesForReview(review);
    if(label==='october') {
      const key=String(transfer.lines.find(row=>row.reportId===ids[3]).line).padStart(3,'0');
      assert.deepEqual(Array.from(entries,entry=>entry.name).sort(),[
        'IT00571_line-001_UNI-PISAS-COP-SAFARI_photo-01',`IT00571_line-${key}_UNI-UCARA-COR-SM-DC_photo-01`].sort());
    }
    const images=[];
    const archive=await download.archive(entries,async(reference)=>{
      await assertDamagePhotoAccess(actor,reference);
      const archived=await readArchivedPhoto(reference);let bytes,type;
      if(archived?.available){bytes=archived.bytes;type=archived.contentType;}
      else {
        assert.ok(!archived?.remoteDeleted);
        const ticket=createPhotoReadToken({actor,key:reference});
        const response=await fetch(ticket.objectUrl,{headers:{Authorization:`Bearer ${ticket.token}`},signal:AbortSignal.timeout(30000)});
        assert.equal(response.status,200);bytes=Buffer.from(await response.arrayBuffer());type=response.headers.get('content-type');
      }
      assert.ok(bytes.length);assert.match(type,/^image\//);
      const details={name:entries.find(entry=>entry.reference===reference).name,type,bytes:bytes.length,sha256:sha(bytes)};
      images.push(details);imageResults.set(reference,details);return new Blob([bytes],{type});
    });
    assert.equal(archive.type,'application/zip');
    writeFileSync(`/tmp/damage-repaired-${month}.zip`,Buffer.from(await archive.arrayBuffer()),{mode:0o600});
    result[label]={totalMs,ref,lines:transfer.lines.map(row=>({line:row.line,sku:row.itemName,quantity:row.quantity,unit:row.unit,photoCount:row.photos.length})),
      downloadPhotos:entries.length,originalImages:images,zipBytes:archive.size};
  }
  assert.deepEqual(await Promise.all(ids.map(damageRow)),before);
  const original=JSON.parse(readFileSync('/tmp/damage-posting-retry-live-before.json'));
  for(const row of before) {
    const saved=original.reports.find(report=>report.id===row.id);assert.deepEqual(row.photos,saved.photos);
    assert.equal(String(row.quantity),String(saved.quantity));assert.equal(String(row.reason_id),String(saved.reason_id));
    assert.ok(row.photos.every(reference=>imageResults.has(reference)));
  }
  console.log(JSON.stringify(result,null,2));
} finally {await pool.end();}

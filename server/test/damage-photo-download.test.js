import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import fc from 'fast-check';

const window={};
vm.runInNewContext(readFileSync(new URL('../public/damage-photo-download.js',import.meta.url),'utf8'),{window,Blob,TextEncoder,Uint8Array,DataView,Map,Set},
  {filename:new URL('../public/damage-photo-download.js',import.meta.url).pathname});
const download=window.MBBSDamagePhotoDownload;
const picture=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=','base64');
function review() {return {transfers:[{ref:'IT00571',lines:[
  {line:1,itemName:'UNI-PISAS-COP-SAFARI',photos:['r2://photo-1.jpg','r2://photo-2.jpg']},
  {line:8,itemName:'Second SKU',photos:['r2://photo-3.png']},
  {line:11,itemName:'No photo',photos:[]}]}],reports:[
  {id:'linked',item_name:'duplicate evidence',photos:['r2://photo-1.jpg']},
  {id:'removed-report',transfer_ref:'IT00571',transfer_line:4,status:'removed',item_name:'Removed SKU',photos:['r2://photo-4.jpg']},
  {id:'unmatched',transfer_ref:'IT00571',status:'attention',item_name:'Unmatched SKU',photos:['r2://photo-5.jpg']} ]};}
const scope={location:'3445',month:'2026-10'};
test('Z1/Z2: photos are named Brand_location_month_Damage_SKU and repeated references appear once',()=>{
  const entries=download.entriesForReview(review(),scope);
  assert.equal(entries.length,5);assert.equal(new Set(entries.map(row=>row.reference)).size,5);
  assert.deepEqual(Array.from(entries,row=>row.name),[
    'UNI_3445_Oct_Damage_UNI-PISAS-COP-SAFARI_photo-01','UNI_3445_Oct_Damage_UNI-PISAS-COP-SAFARI_photo-02',
    'Other_3445_Oct_Damage_Second SKU_photo-01','Other_3445_Oct_Damage_Removed SKU_photo-01','Other_3445_Oct_Damage_Unmatched SKU_photo-01']);
});
test('Z2: requested examples, with photo numbers continuing per SKU across lines and reports',()=>{
  const entries=download.entriesForReview({transfers:[{ref:'IT00600',lines:[
    {line:1,itemName:'BVS-DMD-2430',photos:['r2://a']},{line:2,itemName:'UNI-WIN70S-RDM-DUSK',photos:['r2://b','r2://c']},
    {line:3,itemName:'BVS-DMD-2430',photos:['r2://d']}]}],
    reports:[{id:'x',status:'attention',item_name:'BVS-DMD-2430',photos:['r2://e']}]},scope);
  assert.deepEqual(Array.from(entries,row=>row.name),['BVS_3445_Oct_Damage_BVS-DMD-2430_photo-01',
    'UNI_3445_Oct_Damage_UNI-WIN70S-RDM-DUSK_photo-01','UNI_3445_Oct_Damage_UNI-WIN70S-RDM-DUSK_photo-02',
    'BVS_3445_Oct_Damage_BVS-DMD-2430_photo-02','BVS_3445_Oct_Damage_BVS-DMD-2430_photo-03']);
  for(const [month,label] of [['2026-01','Jan'],['2026-09','Sep'],['2026-12','Dec']]) {
    assert.equal(download.entriesForReview({transfers:[{lines:[{itemName:'BVS-DMD-2430',photos:['r2://a']}]}]},{location:'2967',month})[0].name,
      `BVS_2967_${label}_Damage_BVS-DMD-2430_photo-01`);
  }
});
test('Z2 property: hostile SKU/ref text never makes paths or filename collisions',()=>{
  fc.assert(fc.property(fc.string({maxLength:200}),fc.string({maxLength:200}),(itemName,ref)=>{
    const entries=download.entriesForReview({transfers:[{ref,lines:[{line:1,itemName,photos:['r2://a','r2://b']}]}],reports:[]},{location:ref,month:ref});
    assert.equal(entries.length,2);assert.equal(new Set(entries.map(row=>row.name)).size,2);
    for(const entry of entries) {assert.doesNotMatch(entry.name,/[<>:"/\\|?*\x00-\x1f\x7f]/);assert.ok(entry.name.length<400);}
  }),{numRuns:200});
});
test('Z2: colliding sanitized or case-only different SKUs receive distinct names',()=>{
  const entries=download.entriesForReview({transfers:[{ref:'IT/1',lines:[{line:1,itemName:'A-B/C',photos:['r2://a']}]},
    {ref:'IT\\1',lines:[{line:1,itemName:'A-B\\C',photos:['r2://b']},{line:2,itemName:'a-b/c',photos:['r2://c']}]}],reports:[]},scope);
  assert.equal(entries.length,3);assert.equal(new Set(entries.map(row=>row.name.toLowerCase())).size,3);
});
test('Z3/Z4: archive fetches original image bytes, preserves formats and reports progress',async()=>{
  const calls=[],progress=[];
  const blob=await download.archive(download.entriesForReview(review(),scope),async reference=>{calls.push(reference);return new Blob([picture],{type:reference.endsWith('.png')?'image/png':'image/jpeg'});},(done,total)=>progress.push([done,total]));
  assert.equal(blob.type,'application/zip');assert.equal(calls.length,5);
  assert.deepEqual(progress,[[0,5],[1,5],[2,5],[3,5],[4,5],[5,5]]);
  const bytes=Buffer.from(await blob.arrayBuffer());assert.equal(bytes.readUInt32LE(0),0x04034b50);
  assert.equal(bytes.readUInt32LE(bytes.length-22),0x06054b50);assert.equal(bytes.readUInt16LE(bytes.length-12),5);
  assert.ok(bytes.includes(Buffer.from('UNI_3445_Oct_Damage_UNI-PISAS-COP-SAFARI_photo-01.jpg')));
  assert.ok(bytes.includes(Buffer.from('Other_3445_Oct_Damage_Second SKU_photo-01.png')));
  mkdirSync('test-artifacts/damage-photos-20261001',{recursive:true});
  writeFileSync('test-artifacts/damage-photos-20261001/unit-photos.zip',bytes);
});
test('Z3: missing, empty, non-image and unsupported-format photos fail the whole archive',async()=>{
  const entries=[{reference:'r2://a',name:'IT00571_line-001_SKU_photo-01'}];
  await assert.rejects(download.archive(entries,async()=>{throw new Error('Photo denied');}),/Photo denied/);
  for(const blob of [new Blob([],{type:'image/jpeg'}),new Blob(['error'],{type:'text/html'}),new Blob(['unknown'],{type:'image/unrecognized'})]) {
    await assert.rejects(download.archive(entries,async()=>blob),/image|photo|format/i);
  }
});
test('Z3 retry: a transient photo failure is retried and the complete ZIP is still produced',async()=>{
  const entries=[{reference:'r2://a',name:'IT00571_line-001_SKU_photo-01'},{reference:'r2://b',name:'IT00571_line-001_SKU_photo-02'}];
  const calls=[],waits=[];
  const blob=await download.archive(entries,async reference=>{
    calls.push(reference);
    if(reference==='r2://b' && calls.filter(value=>value===reference).length<3) {throw Object.assign(new Error('Photo storage is temporarily unreachable. Please try again.'),{status:502,retryable:true});}
    return new Blob([picture],{type:'image/png'});
  },()=>{},{wait:async ms=>{waits.push(ms);}});
  assert.deepEqual(calls,['r2://a','r2://b','r2://b','r2://b']);assert.deepEqual(waits,[1000,3000]);
  const bytes=Buffer.from(await blob.arrayBuffer());assert.equal(bytes.readUInt16LE(bytes.length-12),2);
});
test('Z3 retry: persistent transient failures and permanent failures still produce no ZIP',async()=>{
  const entries=[{reference:'r2://a',name:'IT00571_line-001_SKU_photo-01'}];
  let calls=0;
  await assert.rejects(download.archive(entries,async()=>{calls++;throw Object.assign(new Error('Network error while downloading photos.'),{retryable:true});},()=>{},{wait:async()=>{}}),/Network error/);
  assert.equal(calls,3);
  calls=0;
  await assert.rejects(download.archive(entries,async()=>{calls++;throw Object.assign(new Error('Missing original photo'),{status:404,retryable:false});},()=>{},{wait:async()=>{}}),/Missing original photo/);
  assert.equal(calls,1);
});
test('Z6: compressed transform output is named by its own image type; invalid output keeps the original',async()=>{
  const entries=[{reference:'r2://a',name:'BVS_3445_Oct_Damage_BVS-DMD-2430_photo-01'},{reference:'r2://b',name:'BVS_3445_Oct_Damage_BVS-DMD-2430_photo-02'}];
  const smaller=new Blob([new Uint8Array([1,2,3])],{type:'image/jpeg'});
  const blob=await download.archive(entries,async()=>new Blob([picture],{type:'image/png'}),()=>{},
    {transform:async source=>{assert.equal(source.type,'image/png');return smaller;}});
  const bytes=Buffer.from(await blob.arrayBuffer());
  assert.ok(bytes.includes(Buffer.from('BVS_3445_Oct_Damage_BVS-DMD-2430_photo-01.jpg')));assert.ok(!bytes.includes(Buffer.from('.png')));
  for(const bad of [null,new Blob([],{type:'image/jpeg'}),new Blob(['x'],{type:'text/html'})]) {
    const kept=Buffer.from(await (await download.archive(entries.slice(0,1),async()=>new Blob([picture],{type:'image/png'}),()=>{},{transform:async()=>bad})).arrayBuffer());
    assert.ok(kept.includes(Buffer.from('BVS_3445_Oct_Damage_BVS-DMD-2430_photo-01.png')));assert.ok(kept.includes(picture));
  }
  await assert.rejects(download.archive(entries,async()=>new Blob(['x'],{type:'text/html'}),()=>{},{transform:async()=>smaller}),/unsupported photo/);
  const source=new Blob([picture],{type:'image/png'});
  assert.equal(await download.compressPhoto(source),source);
});
test('Z4: ZIP supports Unicode names and exact bytes, and rejects duplicate entry paths',async()=>{
  const files=[{name:'IT00571_line-001_损坏砖_photo-01.webp',bytes:new Uint8Array([0,1,2,3,255])}];
  const bytes=Buffer.from(await download.zip(files).arrayBuffer());
  assert.ok(bytes.includes(Buffer.from(files[0].name)));
  assert.equal(bytes.readUInt16LE(6),0x800);
  writeFileSync('test-artifacts/damage-photos-20261001/unicode.zip',bytes);
  assert.throws(()=>download.zip([...files,...files]),/duplicate/i);
  assert.throws(()=>download.zip([{name:'../wrong.jpg',bytes:picture}]),/name|path/i);
});
test('Z4: ZIP32 count and UTF-8 filename limits fail before creating an invalid archive',()=>{
  assert.throws(()=>download.zip(Array(65536).fill({name:'photo.jpg',bytes:picture})),/Too many photos/);
  assert.throws(()=>download.zip([{name:'x'.repeat(65536),bytes:picture}]),/too large/);
});

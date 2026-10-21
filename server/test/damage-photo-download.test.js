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
test('Z1/Z2: all photos have saved transfer/line names and repeated references appear once',()=>{
  const entries=download.entriesForReview(review());
  assert.equal(entries.length,5);assert.equal(new Set(entries.map(row=>row.reference)).size,5);
  assert.equal(entries[0].name,'IT00571_line-001_UNI-PISAS-COP-SAFARI_photo-01');
  assert.equal(entries[1].name,'IT00571_line-001_UNI-PISAS-COP-SAFARI_photo-02');
  assert.equal(entries[2].name,'IT00571_line-008_Second SKU_photo-01');
  assert.match(entries[3].name,/removed-line-004.*removed-report/);
  assert.match(entries[4].name,/report-unmatched/);assert.doesNotMatch(entries[4].name,/line-/);
});
test('Z2 property: hostile SKU/ref text never makes paths or filename collisions',()=>{
  fc.assert(fc.property(fc.string({maxLength:200}),fc.string({maxLength:200}),(itemName,ref)=>{
    const entries=download.entriesForReview({transfers:[{ref,lines:[{line:1,itemName,photos:['r2://a','r2://b']}]}],reports:[]});
    assert.equal(entries.length,2);assert.equal(new Set(entries.map(row=>row.name)).size,2);
    for(const entry of entries) {assert.doesNotMatch(entry.name,/[<>:"/\\|?*\x00-\x1f\x7f]/);assert.ok(entry.name.length<400);}
  }),{numRuns:200});
});
test('Z2: colliding sanitized names receive distinct names',()=>{
  const entries=download.entriesForReview({transfers:[{ref:'IT/1',lines:[{line:1,itemName:'A/B',photos:['r2://a']}]},
    {ref:'IT\\1',lines:[{line:1,itemName:'A\\B',photos:['r2://b']}]}],reports:[]});
  assert.equal(entries.length,2);assert.equal(new Set(entries.map(row=>row.name)).size,2);
});
test('Z3/Z4: archive fetches original image bytes, preserves formats and reports progress',async()=>{
  const calls=[],progress=[];
  const blob=await download.archive(download.entriesForReview(review()),async reference=>{calls.push(reference);return new Blob([picture],{type:reference.endsWith('.png')?'image/png':'image/jpeg'});},(done,total)=>progress.push([done,total]));
  assert.equal(blob.type,'application/zip');assert.equal(calls.length,5);
  assert.deepEqual(progress,[[0,5],[1,5],[2,5],[3,5],[4,5],[5,5]]);
  const bytes=Buffer.from(await blob.arrayBuffer());assert.equal(bytes.readUInt32LE(0),0x04034b50);
  assert.equal(bytes.readUInt32LE(bytes.length-22),0x06054b50);assert.equal(bytes.readUInt16LE(bytes.length-12),5);
  assert.ok(bytes.includes(Buffer.from('IT00571_line-001_UNI-PISAS-COP-SAFARI_photo-01.jpg')));
  assert.ok(bytes.includes(Buffer.from('IT00571_line-008_Second SKU_photo-01.png')));
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

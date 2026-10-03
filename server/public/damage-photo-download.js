(function(root) {
  'use strict';
  const encoder=new TextEncoder();
  const extensions={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif','image/avif':'avif',
    'image/heic':'heic','image/heif':'heif','image/bmp':'bmp','image/tiff':'tif','image/svg+xml':'svg'};
  function safeName(value,fallback='SKU') {
    return String(value || '').normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g,'_')
      .replace(/^\.+|[. ]+$/g,'').trim().slice(0,120) || fallback;
  }
  function entriesForReview(review) {
    const entries=[],references=new Set(),names=new Set();
    function add(photos,prefix) {
      for(const [index,reference] of (photos || []).entries()) {
        if(!reference || references.has(reference)) {continue;}
        references.add(reference);
        const base=`${prefix}_photo-${String(index+1).padStart(2,'0')}`;
        let name=base,suffix=2;
        while(names.has(name)) {name=`${base}_${suffix++}`;}
        names.add(name);entries.push({reference,name});
      }
    }
    for(const transfer of review.transfers || []) {
      for(const line of transfer.lines || []) {
        add(line.photos,`${safeName(transfer.ref,'Damage')}_line-${String(line.line).padStart(3,'0')}_${safeName(line.itemName)}`);
      }
    }
    for(const report of review.reports || []) {
      const removed=report.status==='removed' && Number(report.transfer_line)>0?`removed-line-${String(report.transfer_line).padStart(3,'0')}_`:'';
      add(report.photos,`${safeName(report.transfer_ref,'Damage')}_${removed}report-${safeName(report.id,'unknown')}_${safeName(report.item_name)}`);
    }
    return entries;
  }
  const crcTable=Array.from({length:256},(_,index)=>{
    let crc=index;for(let bit=0;bit<8;bit++) {crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return crc>>>0;
  });
  function crc32(bytes) {
    let crc=0xffffffff;
    for(const byte of bytes) {crc=(crc>>>8)^crcTable[(crc^byte)&0xff];}
    return (crc^0xffffffff)>>>0;
  }
  function header(size,signature) {
    const bytes=new Uint8Array(size),view=new DataView(bytes.buffer);
    view.setUint32(0,signature,true);return {bytes,view};
  }
  function zip(files) {
    if(files.length>65535) {throw new Error('Too many photos for one ZIP.');}
    const parts=[],central=[],names=new Set();let offset=0,centralSize=0;
    for(const file of files) {
      if(!file.name || /[/\\\u0000-\u001f]/.test(file.name) || file.name.startsWith('.')) {throw new Error('Invalid ZIP filename or path.');}
      if(names.has(file.name)) {throw new Error('Duplicate ZIP filename.');}names.add(file.name);
      const name=encoder.encode(file.name),data=file.bytes,crc=crc32(data);
      if(name.length>65535 || data.byteLength>0xffffffff || offset+30+name.length+data.byteLength>0xffffffff) {throw new Error('Photos are too large for one ZIP.');}
      const local=header(30,0x04034b50),entry=header(46,0x02014b50);
      local.view.setUint16(4,20,true);local.view.setUint16(6,0x800,true);local.view.setUint16(12,0x21,true);
      local.view.setUint32(14,crc,true);local.view.setUint32(18,data.byteLength,true);local.view.setUint32(22,data.byteLength,true);
      local.view.setUint16(26,name.length,true);
      entry.view.setUint16(4,20,true);entry.view.setUint16(6,20,true);entry.view.setUint16(8,0x800,true);entry.view.setUint16(14,0x21,true);
      entry.view.setUint32(16,crc,true);entry.view.setUint32(20,data.byteLength,true);entry.view.setUint32(24,data.byteLength,true);
      entry.view.setUint16(28,name.length,true);entry.view.setUint32(42,offset,true);
      parts.push(local.bytes,name,data);central.push(entry.bytes,name);
      offset+=30+name.length+data.byteLength;centralSize+=46+name.length;
    }
    const end=header(22,0x06054b50);end.view.setUint16(8,files.length,true);end.view.setUint16(10,files.length,true);
    end.view.setUint32(12,centralSize,true);end.view.setUint32(16,offset,true);
    return new Blob([...parts,...central,end.bytes],{type:'application/zip'});
  }
  async function archive(entries,readPhoto,progress=()=>{}) {
    const files=[];progress(0,entries.length);
    for(const entry of entries) {
      const blob=await readPhoto(entry.reference),type=String(blob.type).split(';')[0].trim().toLowerCase();
      const extension=extensions[type];
      if(!blob.size || !extension) {throw new Error(`Invalid or unsupported photo image: ${entry.name}`);}
      files.push({name:`${entry.name}.${extension}`,bytes:new Uint8Array(await blob.arrayBuffer())});
      progress(files.length,entries.length);
    }
    return zip(files);
  }
  root.MBBSDamagePhotoDownload={entriesForReview,zip,archive,safeName};
})(window);

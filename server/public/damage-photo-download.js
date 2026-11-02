(function(root) {
  'use strict';
  const encoder=new TextEncoder();
  const extensions={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif','image/avif':'avif',
    'image/heic':'heic','image/heif':'heif','image/bmp':'bmp','image/tiff':'tif','image/svg+xml':'svg'};
  function safeName(value,fallback='SKU') {
    return String(value || '').normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g,'_')
      .replace(/^\.+|[. ]+$/g,'').trim().slice(0,120) || fallback;
  }
  const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function monthName(month) {
    const match=/^\d{4}-(0[1-9]|1[0-2])$/.exec(String(month || ''));
    return match?months[Number(match[1])-1]:safeName(month,'Month');
  }
  // The brand is the SKU prefix before the first hyphen (BVS-DMD-2430 -> BVS).
  function brandOf(sku) {
    const text=String(sku || '').trim(),hyphen=text.indexOf('-');
    return safeName(hyphen>0?text.slice(0,hyphen):'','Other');
  }
  // Brand_location_month_Damage_SKU_photo-NN, numbered per SKU across every line and report of the month.
  function entriesForReview(review,{location='',month=''}={}) {
    const entries=[],references=new Set(),counts=new Map(),place=safeName(location,'Location'),period=monthName(month);
    function add(photos,sku) {
      const prefix=`${brandOf(sku)}_${place}_${period}_Damage_${safeName(sku)}`,key=prefix.toLowerCase();
      for(const reference of photos || []) {
        if(!reference || references.has(reference)) {continue;}
        references.add(reference);
        const number=(counts.get(key) || 0)+1;counts.set(key,number);
        entries.push({reference,name:`${prefix}_photo-${String(number).padStart(2,'0')}`});
      }
    }
    for(const transfer of review.transfers || []) {
      for(const line of transfer.lines || []) {add(line.photos,line.itemName);}
    }
    for(const report of review.reports || []) {add(report.photos,report.item_name);}
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
  // Retry only failures the reader marks transient; missing or denied photos still fail at once.
  async function readWithRetry(readPhoto,reference,attempts,wait) {
    for(let attempt=1;;attempt++) {
      try {return await readPhoto(reference);}
      catch(error) {
        if(!error?.retryable || attempt>=attempts) {throw error;}
        await wait(1000*3**(attempt-1));
      }
    }
  }
  const extensionOf=blob=>extensions[String(blob?.type).split(';')[0].trim().toLowerCase()];
  // Compressed download: longest side at most 1600 px, JPEG quality 0.8, EXIF orientation applied.
  // Photos the browser cannot decode (e.g. HEIC outside Safari) or that would not shrink keep their original bytes.
  async function compressPhoto(blob,{maxEdge=1600,quality=0.8}={}) {
    let bitmap;
    try {
      bitmap=await createImageBitmap(blob,{imageOrientation:'from-image'});
      const scale=Math.min(1,maxEdge/Math.max(bitmap.width,bitmap.height,1));
      const width=Math.max(1,Math.round(bitmap.width*scale)),height=Math.max(1,Math.round(bitmap.height*scale));
      const canvas=typeof OffscreenCanvas==='function'?new OffscreenCanvas(width,height):Object.assign(document.createElement('canvas'),{width,height});
      const context=canvas.getContext('2d');
      context.fillStyle='#fff';context.fillRect(0,0,width,height);context.drawImage(bitmap,0,0,width,height);
      const output=canvas.convertToBlob?await canvas.convertToBlob({type:'image/jpeg',quality}):await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',quality));
      return output?.size && output.size<blob.size?output:blob;
    } catch {return blob;}
    finally {bitmap?.close?.();}
  }
  async function archive(entries,readPhoto,progress=()=>{},{attempts=3,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),transform=null}={}) {
    const files=[];progress(0,entries.length);
    for(const entry of entries) {
      const original=await readWithRetry(readPhoto,entry.reference,attempts,wait);
      if(!original.size || !extensionOf(original)) {throw new Error(`Invalid or unsupported photo image: ${entry.name}`);}
      const converted=transform?await transform(original):original,blob=converted?.size && extensionOf(converted)?converted:original;
      files.push({name:`${entry.name}.${extensionOf(blob)}`,bytes:new Uint8Array(await blob.arrayBuffer())});
      progress(files.length,entries.length);
    }
    return zip(files);
  }
  root.MBBSDamagePhotoDownload={entriesForReview,zip,archive,compressPhoto,safeName};
})(window);

import { inflateSync } from 'node:zlib';
// Decode PDFKit's actual content streams and embedded ToUnicode maps, not source
// strings: this catches missing Chinese glyphs and wrong values in emitted PDFs.
export function pdfText(pdf,contentIds) {
 const objects=new Map([...pdf.toString('latin1').matchAll(/(\d+) 0 obj\s*([\s\S]*?)endobj/g)].map(m=>[m[1],m[2]]));
 const stream=id=>{const obj=objects.get(String(id))||'',m=obj.match(/stream\r?\n([\s\S]*?)\r?\nendstream/);if(!m){return '';}return (/FlateDecode/.test(obj)?inflateSync(Buffer.from(m[1],'latin1')):Buffer.from(m[1],'latin1')).toString('utf8');};
 const unicode=hex=>{const b=Buffer.from(hex.replace(/\s/g,''),'hex');return b.swap16().toString('utf16le');};
 const maps=new Map(),fonts=new Map();
 for(const [id,obj] of objects){const ref=obj.match(/\/ToUnicode (\d+) 0 R/);if(!ref){continue;}const cmap=stream(ref[1]),map=new Map();
  for(const m of cmap.matchAll(/<(\w+)>\s*<(\w+)>\s*\[([^\]]+)\]/g)){let code=parseInt(m[1],16);for(const h of m[3].matchAll(/<([\da-f\s]+)>/gi)){map.set(code++,unicode(h[1]));}}
  for(const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)){for(const m of block[1].matchAll(/<(\w+)>\s*<(\w+)>/g)){map.set(parseInt(m[1],16),unicode(m[2]));}}
  maps.set(id,map);
 }
 for(const obj of objects.values()){for(const m of obj.matchAll(/\/(F\d+) (\d+) 0 R/g)){fonts.set(m[1],maps.get(m[2]));}}
 const output=[];
 for(const id of objects.keys()){if(contentIds&&!contentIds.includes(id)){continue;}const s=stream(id);if(!s.includes('Tf')){continue;}let font=null;
  for(const m of s.matchAll(/\/(F\d+) [\d.]+ Tf|\[([^\]]*)\] TJ|<([\da-f]+)> Tj/gi)){
   if(m[1]){font=fonts.get(m[1]);continue;}
   for(const h of (m[2]||`<${m[3]}>`).matchAll(/<([\da-f]+)>/gi)){
    output.push(font?Array.from({length:h[1].length/4},(_,i)=>font.get(parseInt(h[1].slice(i*4,i*4+4),16))||'').join(''):Buffer.from(h[1],'hex').toString('latin1'));
   }
  }
 }
 return output.join('');
}

export function pdfPages(pdf){
 return [...pdf.toString('latin1').matchAll(/\d+ 0 obj\s*([\s\S]*?)endobj/g)].filter(m=>/\/Type \/Page\b/.test(m[1])).map(m=>pdfText(pdf,[m[1].match(/\/Contents (\d+) 0 R/)[1]]));
}

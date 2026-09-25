// Keep offline identities stable across browsers that lack randomUUID (including
// browsers where that method is restricted to a secure context).
export function newId(source=globalThis.crypto) {
  if(typeof source?.randomUUID==='function'){return source.randomUUID();}
  if(typeof source?.getRandomValues!=='function'){
    throw new Error('This browser cannot create secure random IDs. Open the app over HTTPS in an updated browser; your saved work is retained.');
  }
  const bytes=source.getRandomValues(new Uint8Array(16));
  bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

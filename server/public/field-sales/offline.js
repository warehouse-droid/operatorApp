import { newId } from './identity.js';
// Per-operator IndexedDB. Requests and photos are removed only after acknowledgement.
export async function openWorkspace(operatorId) {
  const name=`mbbs-field-sales-v1-${operatorId}`;
  const db=await new Promise((resolve,reject)=>{
    const r=indexedDB.open(name,1);
    r.onupgradeneeded=()=>{r.result.createObjectStore('records',{keyPath:'key'});const q=r.result.createObjectStore('outbox',{keyPath:'seq',autoIncrement:true});q.createIndex('id','id',{unique:true});};
    r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
  });
  const result=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  function transaction(stores,action) {
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(stores,'readwrite');let value;
      tx.oncomplete=()=>resolve(value);tx.onabort=()=>reject(tx.error||new Error('Device storage is unavailable.'));tx.onerror=()=>{};
      Promise.resolve(action(tx)).then(v=>{value=v;}).catch(e=>{tx.abort();reject(e);});
    });
  }
  async function get(key){return (await result(db.transaction('records').objectStore('records').get(key)))?.value;}
  async function put(key,value){return transaction(['records'],tx=>tx.objectStore('records').put({key,value}));}
  async function pending(){return result(db.transaction('outbox').objectStore('outbox').getAll());}
  async function records(prefix){return (await result(db.transaction('records').objectStore('records').getAll())).filter(r=>r.key.startsWith(prefix)).map(r=>r.value);}
  async function enqueue(command,updates=[],related=[]) {
    await transaction(['records','outbox'],tx=>{
      tx.objectStore('outbox').add({...command,createdAt:new Date().toISOString()});
      for(const entry of related){tx.objectStore('outbox').add({...entry,createdAt:new Date().toISOString()});}
      for(const [key,value] of updates){tx.objectStore('records').put({key,value});}
    });
  }
  async function sync(send) {
    const work=async()=>{
      for(const entry of await pending()) {
        if(entry.error){break;}
        try {
          const response=await send(entry);
          await transaction(['records','outbox'],async tx=>{
            const queue=tx.objectStore('outbox'),remaining=await result(queue.getAll());
            const rows=[...['jobsite','route','quote','customer','customerType'].filter(key=>response[key]).map(key=>[key,response[key]]),...(response.quotes||[]).map(row=>['quote',row])];
            for(const [key,row] of rows){
              const later=remaining.some(e=>e.seq>entry.seq&&(e.payload?.id===row.id&&e.kind===`${key}.save`||key==='quote'&&e.kind==='quote.saveGroup'&&e.payload.quotes.some(q=>q.id===row.id)||key==='route'&&e.kind==='visit.record'&&e.payload.routeId===row.id||key==='customer'&&e.kind==='customer.link'&&e.payload.customerId===row.id));
              tx.objectStore('records').put({key:`server:${key}:${row.id}`,value:row});
              if(!later){tx.objectStore('records').put({key:`${key}:${row.id}`,value:row});}
            }
            queue.delete(entry.seq);
          });
        } catch(error) {
          if(error.status&&error.status!==401&&error.status!==503&&error.status<500){await transaction(['outbox'],tx=>tx.objectStore('outbox').put({...entry,error:error.message,status:error.status}));}
          throw error;
        }
      }
    };
    if(navigator.locks){return navigator.locks.request(name,work);}
    return work();
  }
  async function retry(seq) {await transaction(['outbox'],async tx=>{const q=tx.objectStore('outbox'),entry=await result(q.get(seq));if(entry){delete entry.error;delete entry.status;q.put(entry);}});}
  async function rebase(seq,revision) {
    // Explicit conflict resolution changes command IDs, retaining the old payload
    // in the local review archive. Dependent revisions move together.
    await transaction(['records','outbox'],async tx=>{
      const q=tx.objectStore('outbox'),all=await result(q.getAll()),first=all.find(e=>e.seq===seq);
      if(!first){throw new Error('Pending edit no longer exists.');}
      const delta=revision-Number(first.payload.revision||0);
      tx.objectStore('records').put({key:`review:${first.id}`,value:first});
      for(const e of all.filter(candidate=>candidate.seq>=seq&&candidate.kind===first.kind&&candidate.payload?.id===first.payload.id)) {
        e.id=newId();e.payload.revision=Number(e.payload.revision||0)+delta;delete e.error;delete e.status;q.put(e);
      }
    });
  }
  async function replaceFailed(command,updates,source={kind:command.kind,id:command.payload.id}) {
    await transaction(['records','outbox'],async tx=>{
      const q=tx.objectStore('outbox'),all=await result(q.getAll()),matches=all.filter(e=>e.kind===source.kind&&e.payload?.id===source.id);
      if(!matches[0]?.error){throw new Error('This pending record is not awaiting review. Sync and review its current state first.');}
      for(const old of matches){tx.objectStore('records').put({key:`review:${old.id}`,value:old});q.delete(old.seq);}
      if(source.id!==command.payload.id){tx.objectStore('records').delete(`editquote:${source.id}`);}
      q.put({...command,seq:matches[0].seq,createdAt:new Date().toISOString()});
      for(const [key,value] of updates){tx.objectStore('records').put({key,value});}
    });
  }
  async function splitLegacy(source,entry,drafts){
    await transaction(['records','outbox'],async tx=>{
      const recordStore=tx.objectStore('records'),queue=tx.objectStore('outbox');
      recordStore.put({key:`review:legacy:${source.id}`,value:source});
      for(const draft of drafts){recordStore.put({key:`editquote:${draft.id}`,value:draft});}
      recordStore.delete(`editquote:${source.id}`);
      if(entry){for(const old of await result(queue.getAll())){if(old.kind==='quote.save'&&old.payload?.id===source.id){recordStore.put({key:`review:${old.id}`,value:old});queue.delete(old.seq);}}recordStore.delete(`quote:${source.id}`);}
    });
  }
  return {get,put,records,pending,enqueue,sync,retry,rebase,replaceFailed,splitLegacy,close:()=>db.close()};
}

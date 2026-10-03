(function(root) {
  'use strict';
  function create() {
    let opening,queue=Promise.resolve();
    function database() {
      if(!opening) {opening=new Promise((resolve,reject)=>{
        if(!root.indexedDB) {reject(new Error('Device draft storage is unavailable.'));return;}
        const request=root.indexedDB.open('mbbs-damage-drafts',1);
        request.onupgradeneeded=()=>request.result.createObjectStore('drafts');
        request.onsuccess=()=>resolve(request.result);
        request.onerror=()=>reject(request.error);
        request.onblocked=()=>reject(new Error('Device draft storage is busy.'));
      });}
      return opening;
    }
    function operation(key,mode,action) {
      const next=queue.catch(()=>{}).then(async()=>{
        const db=await database();
        return new Promise((resolve,reject)=>{
          const transaction=db.transaction('drafts',mode),request=action(transaction.objectStore('drafts'),key);
          transaction.oncomplete=()=>resolve(request.result ?? null);
          transaction.onerror=()=>reject(transaction.error || request.error);
          transaction.onabort=()=>reject(transaction.error || new Error('Device draft save was interrupted.'));
        });
      });
      queue=next;return next;
    }
    return {
      load:key=>operation(key,'readonly',(store,id)=>store.get(id)),
      save:(key,draft)=>{const snapshot=structuredClone(draft);return operation(key,'readwrite',(store,id)=>store.put(snapshot,id));},
      clear:key=>operation(key,'readwrite',(store,id)=>store.delete(id))
    };
  }
  root.MBBSDamageDraftCache={create};
})(window);

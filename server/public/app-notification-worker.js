self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil((async()=>{
    const target=new URL(event.notification.data?.url || '/',self.location.origin);
    if(target.origin!==self.location.origin || !['http:','https:'].includes(target.protocol)) {return;}
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const exact=windows.find(client=>client.url===target.href);
    if(exact) {return exact.focus();}
    return self.clients.openWindow(target.href);
  })());
});

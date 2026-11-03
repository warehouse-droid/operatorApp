const REPAIR_CACHE='mbbs-repair-shell-20261030-i18n';
self.addEventListener('install',event=>event.waitUntil(caches.open(REPAIR_CACHE).then(cache=>cache.addAll(['/repair/offline.html','/i18n.js?v=20261030-repair-language','/i18n.css?v=20261030-repair-language','/repair/i18n.js?v=20261030-repair-language','/repair/messages.js?v=20261030-repair-language','/repair/i18n.css?v=20261030-repair-language'])).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const name of await caches.keys())if(name.startsWith('mbbs-repair-shell-')&&name!==REPAIR_CACHE)await caches.delete(name);await self.clients.claim();})()));
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url);
 if(event.request.method==='GET'&&url.origin===self.location.origin&&['/i18n.js','/i18n.css','/repair/i18n.js','/repair/messages.js','/repair/i18n.css'].includes(url.pathname)){event.respondWith(fetch(event.request).catch(()=>caches.open(REPAIR_CACHE).then(cache=>cache.match(event.request))));return;}
 if(event.request.method!=='GET'||event.request.mode!=='navigate'||url.origin!==self.location.origin||url.pathname!=='/repair/workshop')return;
 event.respondWith(fetch(event.request).catch(()=>caches.open(REPAIR_CACHE).then(cache=>cache.match('/repair/offline.html'))));
});
self.addEventListener('push',event=>{let data;try{data=event.data.json();}catch{return;}if(data.type!=='repair')return;event.waitUntil(self.registration.showNotification(data.title||'Repair update',{body:data.body||'Open Repair to view the update.',tag:'repair-update',data:{url:data.url||'/repair/'}}));});
self.addEventListener('notificationclick',event=>{event.notification.close();const target=new URL(event.notification.data?.url||'/repair/',self.location.origin);if(target.origin!==self.location.origin||!target.pathname.startsWith('/repair'))return;event.waitUntil(self.clients.openWindow(target.href));});

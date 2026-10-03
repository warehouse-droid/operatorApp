const CACHE='mbbs-field-sales-shell-v15';
const SHELL=['/field-sales/netsuite-customer-picker.js','/field-sales/customer-search.js','/field-sales/quote-drafts.js','/field-sales/customers.js','/field-sales/identity.js','/field-sales/','/field-sales/index.html','/field-sales/app.js','/field-sales/ui.js','/field-sales/planner.js','/field-sales/planner-data.js','/field-sales/lead-policy.js','/field-sales/pricing.js','/field-sales/item-autocomplete.js','/field-sales/quotes.js','/field-sales/visiting.js','/field-sales/settings.js','/field-sales/offline.js','/field-sales/domain.js','/field-sales/styles.css','/field-sales/icon.svg','/field-sales/manifest.webmanifest'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL))));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const key of await caches.keys()){if(key.startsWith('mbbs-field-sales-shell-')&&key!==CACHE){await caches.delete(key);}}await self.clients.claim();})()));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==self.location.origin||!url.pathname.startsWith('/field-sales/')){return;}
  event.respondWith(fetch(event.request).then(response=>{if(response.ok&&SHELL.includes(url.pathname)){const copy=response.clone();event.waitUntil(caches.open(CACHE).then(cache=>cache.put(event.request,copy)).catch(()=>{}));}return response;}).catch(async()=>await caches.match(event.request)||(event.request.mode==='navigate'?await caches.match('/field-sales/'):Response.error())));
});

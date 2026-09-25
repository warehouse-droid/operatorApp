import assert from 'node:assert/strict';
import {readFileSync,existsSync,writeFileSync} from 'node:fs';
import vm from 'node:vm';
const handlers=new Map(),requests=[],imports=[];
let cacheName='',mode='';
const context={URL,Request,Response,console,setTimeout,clearTimeout,
 importScripts:(...urls)=>imports.push(...urls),
 self:{location:{origin:'https://sor-cache.invalid'},addEventListener:(name,fn)=>handlers.set(name,fn),skipWaiting(){}},
 caches:{open:async name=>{cacheName=name;return {addAll:async values=>{requests.push(...values);},put:async(_key,value)=>{mode=await value.text();}};}}};
vm.runInNewContext(readFileSync('public/driver-service-worker.js','utf8'),context,{filename:'/app/public/driver-service-worker.js'});
let installed;handlers.get('install')({waitUntil:promise=>{installed=promise;}});await installed;
assert.equal(cacheName,'mbbs-driver-shell-v43');assert.equal(mode,'false');
for(const asset of ['sor-signature.js','sor-driver-signature.js','sor-rentals.css','driver.js','driver-offline-db.js']){
 assert.ok(requests.some(request=>new URL(request.url).pathname==='/'+asset && new URL(request.url).search==='?v=20260924-sor-v1'),asset);
 assert.ok(existsSync('public/'+asset));
}
assert.ok(requests.every(request=>request.cache==='reload'));
assert.ok(imports.includes('/driver-offline-db.js?v=20260924-sor-v1'));
writeFileSync('test-artifacts/sor-rentals/cache-result.json',JSON.stringify({passed:true,generation:43,preCachedAssets:requests.length,atomicShellInstall:true}));
console.log('SOR PWA cache install passed.');

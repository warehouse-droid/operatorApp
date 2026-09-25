import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
test('Service worker upgrades shell including UUID/customer modules, preserves unrelated caches and serves offline pages',async()=>{
 const events={},removed=[],added=[],old='mbbs-field-sales-shell-v8',other='unrelated-app-cache';let claimed=false,deletedDatabase=false;
 const context={URL,Response,fetch:async()=>{throw new Error('Offline');},indexedDB:{deleteDatabase:()=>{deletedDatabase=true;}},self:{location:{origin:'https://example.test'},clients:{claim:async()=>{claimed=true;}},addEventListener:(name,fn)=>{events[name]=fn;}},caches:{keys:async()=>[old,other],delete:async name=>{removed.push(name);},open:async()=>({addAll:async paths=>added.push(...paths)}),match:async request=>typeof request==='string'?new Response('Cached app'):undefined}};
 const file=new URL('../../public/field-sales/service-worker.js',import.meta.url);vm.runInNewContext(readFileSync(file,'utf8'),context,{filename:file.pathname});
 let pending;events.install({waitUntil:p=>{pending=p;}});await pending;assert.ok(added.includes('/field-sales/identity.js'));assert.ok(added.includes('/field-sales/customers.js'));
 events.activate({waitUntil:p=>{pending=p;}});await pending;assert.deepEqual(removed,[old]);assert.equal(claimed,true);assert.equal(deletedDatabase,false);
 events.fetch({request:{url:'https://example.test/field-sales/',method:'GET',mode:'navigate'},respondWith:p=>{pending=p;}});assert.equal(await (await pending).text(),'Cached app');
 let intercepted=false;events.fetch({request:{url:'https://example.test/api/field-sales/customer-records',method:'GET'},respondWith:()=>{intercepted=true;}});assert.equal(intercepted,false);
});

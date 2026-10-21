import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import vm from 'node:vm';
import {app} from '../src/server.js';
import {closeDb} from '../src/db.js';
test('D5: the refreshed offline shell installs the draft cache before the matching operator client',async()=>{
  const events=new Map(),installed=[],deleted=[];
  const context={self:{location:{origin:'https://damage.test'},addEventListener:(name,handler)=>events.set(name,handler),skipWaiting:()=>{},clients:{claim:async()=>{}}},
    caches:{open:async()=>({addAll:async requests=>installed.push(...requests.map(request=>new URL(request.url).pathname+new URL(request.url).search))}),
      keys:async()=>['mbbs-yard-operator-old','mbbs-driver-retained'],delete:async name=>deleted.push(name)},URL,Request};
  vm.runInNewContext(readFileSync('public/service-worker.js','utf8'),context,{filename:resolve('public/service-worker.js')});
  let pending;events.get('install')({waitUntil:promise=>{pending=promise;}});await pending;
  const html=readFileSync('public/operator.html','utf8'),scripts=[...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match=>match[1]);
  const helper=scripts.find(path=>path.startsWith('/damage-draft-cache.js')),client=scripts.find(path=>path.startsWith('/operator-inventory.js'));
  assert.ok(helper && client);assert.ok(scripts.indexOf(helper)<scripts.indexOf(client));
  assert.ok(installed.includes(helper));assert.ok(installed.includes(client));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  try {
    for(const path of installed) {
      const response=await fetch(`http://127.0.0.1:${server.address().port}`+path);
      assert.equal(response.status,200,path);await response.arrayBuffer();
    }
  } finally {await new Promise(resolve=>server.close(resolve));await closeDb();}
  events.get('activate')({waitUntil:promise=>{pending=promise;}});await pending;
  assert.deepEqual(deleted,['mbbs-yard-operator-old']);
});

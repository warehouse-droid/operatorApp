// cloudflared reuses idle connections to the app for up to 90 s. Node closed them after 5 s, so a
// request sent on a connection the app was closing failed as "Unable to reach the origin service:
// EOF" (a 502), about 10 times a day outside releases, including NetSuite order webhooks.
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {spawn} from 'node:child_process';

const CLOUDFLARED_IDLE_REUSE_MS=90_000;
const SERVER_URL=new URL('../../src/server.js',import.meta.url).href;
const CONFIG_URL=new URL('../../src/config.js',import.meta.url).href;

test('the keep-alive helper keeps idle connections longer than cloudflared reuses them',async()=>{
  const {applyOriginKeepAlive}=await import(new URL('../../src/http-keep-alive.js',import.meta.url).href);
  const server=http.createServer();
  assert.equal(applyOriginKeepAlive(server),server);
  assert.ok(server.keepAliveTimeout>CLOUDFLARED_IDLE_REUSE_MS,`keepAliveTimeout ${server.keepAliveTimeout}`);
});

test('the real application keeps an idle connection open past the old 5 s limit',async()=>{
  const source=`
    import http from 'node:http';
    import {startServer} from ${JSON.stringify(SERVER_URL)};
    import {config} from ${JSON.stringify(CONFIG_URL)};
    config.port=0;
    config.netsuite.directAccessEnabled=false;
    const server=await startServer();
    if(!server.listening) await new Promise(resolve=>server.once('listening',resolve));
    const agent=new http.Agent({keepAlive:true,maxSockets:1});
    const get=()=>new Promise((resolve,reject)=>{
      const request=http.get({host:'127.0.0.1',port:server.address().port,path:'/health',agent},response=>{
        response.resume();
        response.on('end',()=>resolve({status:response.statusCode,reused:request.reusedSocket}));
      });
      request.on('error',reject);
    });
    const first=await get();
    await new Promise(resolve=>setTimeout(resolve,7000));
    const second=await get();
    console.log('KEEP_ALIVE_RESULT '+JSON.stringify({keepAliveTimeout:server.keepAliveTimeout,first,second}));
    process.exit(0);
  `;
  const child=spawn(process.execPath,['--input-type=module','-e',source],{env:process.env});
  let output='';child.stdout.on('data',data=>{output+=data;});child.stderr.on('data',data=>{output+=data;});
  const timer=setTimeout(()=>child.kill('SIGTERM'),60_000);
  try {
    const exit=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>resolve(code));});
    assert.equal(exit,0,output.slice(-6000));
    const line=output.split('\n').find(text=>text.startsWith('KEEP_ALIVE_RESULT '));
    assert.ok(line,output.slice(-6000));
    const result=JSON.parse(line.slice('KEEP_ALIVE_RESULT '.length));
    assert.equal(result.first.status,200);
    assert.equal(result.second.status,200);
    assert.ok(result.keepAliveTimeout>CLOUDFLARED_IDLE_REUSE_MS,`keepAliveTimeout ${result.keepAliveTimeout}`);
    assert.equal(result.second.reused,true,'the app closed the idle connection before the second request');
  } finally {clearTimeout(timer);if(child.exitCode===null)child.kill('SIGTERM');}
});

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";

test("BIN driver upgrade installs the current driver bundle into a fresh offline shell",async()=>{
  const handlers=new Map(),opened=[],requests=[],writes=[];
  let pending;
  const cache={addAll:async values=>requests.push(...values),put:async(key,value)=>writes.push([key,value])};
  const context={
    URL,Request,Response,console,importScripts:()=>{},
    caches:{open:async name=>{opened.push(name);return cache;}},
    self:{location:{origin:"https://workflow.test"},addEventListener:(name,handler)=>handlers.set(name,handler),skipWaiting:()=>{}}
  };
  const file=resolve("public/driver-service-worker.js");
  vm.runInNewContext(readFileSync(file,"utf8"),context,{filename:file});
  handlers.get("install")({waitUntil:value=>{pending=value;}});
  await pending;
  assert.notEqual(opened[0],"mbbs-driver-shell-v47");
  const script=readFileSync("public/driver.html","utf8").match(/src="(\/driver\.js\?[^"]+)"/)[1];
  const driverRequests=requests.filter(request=>new URL(request.url).pathname==="/driver.js");
  assert.equal(driverRequests.length,1);
  assert.equal(driverRequests[0].url,new URL(script,context.self.location.origin).href);
  assert.equal(driverRequests[0].cache,"reload");
  assert.equal(await writes.find(([key])=>key==="/__mbbs_driver_offline_mode__")[1].text(),"false");
});

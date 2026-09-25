import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { mkdirSync,writeFileSync,readFileSync } from 'node:fs';
import { chromium,expect } from '@playwright/test';
import { httpFixture } from '../test/field-sales/http-fixture.js';
import { closeDb } from '../src/db.js';

const folder=process.env.FIELD_SALES_ARTIFACT_DIR||'/tmp/field-sales-map';mkdirSync(folder,{recursive:true});
const f=await httpFixture(),browser=await chromium.launch({args:['--no-sandbox']}),results=[],errors=[],coverage=[];
const prefix=`Map selection ${randomUUID()}`,sites=[];
const near=[-79.61,43.69,-79.55,43.73],far=[-79.52,43.69,-79.48,43.73],wide=[-79.65,43.65,-79.45,43.8];
for(let i=0;i<59;i++) {
  sites.push((await f.repo.command(f.actors.field_sales.operator,{id:randomUUID(),kind:'jobsite.save',payload:{id:randomUUID(),name:`${prefix} ${i}`,address:`${9000+i} Map Test Road`,ward:i<55?'01':'02',district:'Etobicoke-York',latitude:i===58?null:43.70+i*.0001,longitude:i<55?-79.58:i===58?null:-79.50}})).jobsite);
}
async function session(maps=true) {
  const context=await browser.newContext({viewport:{width:1600,height:1050},serviceWorkers:'block'}),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.coverage.startJSCoverage({resetOnNavigation:false});
  if(maps) {
    await page.route('**/api/field-sales/map-session',r=>r.fulfill({json:{available:true,googleMapsApiKey:'boundary-only'}}));
    await page.addInitScript(({initial})=>{
      class Point {constructor(lat,lng){this.y=lat;this.x=lng;}lat(){return this.y;}lng(){return this.x;}}
      class Bounds {constructor(area=initial){this.area=area;}getSouthWest(){return new Point(this.area[1],this.area[0]);}getNorthEast(){return new Point(this.area[3],this.area[2]);}extend(){}}
      const state=window.__testMaps={instances:[],markers:[],move(area,zoom=13){const m=this.instances.at(-1);m.bounds=new Bounds(area);m.zoom=zoom;m.emit('idle');}};
      class Map {
        constructor(el,options){this.el=el;this.zoom=options.zoom;this.bounds=new Bounds();this.listeners={};this.controls={TOP_CENTER:[]};state.instances.push(this);setTimeout(()=>this.emit('idle'),20);}
        getDiv(){return this.el;}getBounds(){return this.bounds;}getZoom(){return this.zoom;}getCenter(){return new Point((this.bounds.area[1]+this.bounds.area[3])/2,(this.bounds.area[0]+this.bounds.area[2])/2);}
        addListener(name,fn){(this.listeners[name]??=[]).push(fn);return {remove:()=>{this.listeners[name]=this.listeners[name].filter(callback=>callback!==fn);}};}
        emit(name){for(const fn of this.listeners[name]||[]){fn();}}setCenter(){}setZoom(z){this.zoom=z;this.emit('idle');}fitBounds(b){this.bounds=b;this.emit('idle');}
      }
      class Marker {constructor(options){Object.assign(this,options);state.markers.push(this);}setMap(m){this.map=m;}addListener(){}getPosition(){return this.position;}}
      window.google={maps:{Map,Marker,LatLngBounds:Bounds,Polyline:class {setMap(){}},SymbolPath:{CIRCLE:'circle'},ControlPosition:{TOP_CENTER:'TOP_CENTER'},event:{clearInstanceListeners:m=>{m.listeners={};}}}};
    },{initial:near});
  }
  await page.goto(f.base+'/field-sales/');await page.locator('#login [name=username]').fill(f.actors.field_sales.username);await page.locator('#login [name=password]').fill(f.actors.field_sales.password);await page.locator('#login button').click();
  await page.locator('#filters').waitFor();await page.locator('#filters [name=source]').selectOption('manual');await page.locator('#filters [name=search]').fill(prefix);await page.locator('#filters button.primary').click();
  return {context,page};
}
async function scenario(name,fn,maps=true) {
  const {context,page}=await session(maps);
  try{await fn(page);results.push({name,passed:true});console.log('PASS',name);await page.screenshot({path:`${folder}/${name}.png`,fullPage:true});}
  catch(e){results.push({name,passed:false,error:String(e.stack)});console.log('FAIL',name,e.message);await page.screenshot({path:`${folder}/${name}-failure.png`,fullPage:true});}
  finally{coverage.push(...(await page.coverage.stopJSCoverage()).filter(entry=>/field-sales\/(planner|planner-data)\.js$/.test(new URL(entry.url).pathname)));await context.close();}
}
const count=(page,n)=>expect(page.locator('#prospect-count')).toHaveText(`${n} potential jobsites`);
const move=(page,bounds,zoom=13)=>page.evaluate(value=>window.__testMaps.move(value.bounds,value.zoom),{bounds,zoom});
const saved=page=>page.waitForFunction(()=>document.querySelector('#sync')?.textContent==='All changes saved');
async function chooseRoute(page,r=f.route){if(!await page.locator(`#route-select option[value="${r.id}"]`).count()){await page.locator('[data-page=routes]').click();await page.locator(`[data-plan="${r.id}"]`).click();}else {await page.locator('#route-select').selectOption(r.id);}await page.locator('#route-edit').waitFor();}
try {
  await scenario('ward-names',async page=>{
    const labels=await page.locator('#filters [name=ward] option').allTextContents();assert.equal(labels.length,26);assert.equal(labels[1],'01 · Etobicoke North');assert.equal(labels[25],'25 · Scarborough-Rouge Park');
    await expect(page.locator('.lead-meta').first()).toContainText('Etobicoke North');await page.locator('[data-site]').first().click();await expect(page.locator('.detail-layout')).toContainText('Etobicoke North');await page.locator('#site-edit').click();await expect(page.locator('#site-form select[name=ward]')).toHaveValue('01');
  });
  await scenario('viewport-and-paging',async page=>{
    await count(page,55);await expect(page.locator('.lead')).toHaveCount(50);await chooseRoute(page);await page.locator('#route-edit [name=name]').fill('Unsaved afternoon plan');
    await page.locator('#next').click();await expect(page.locator('.lead')).toHaveCount(5);await expect(page.locator('.page-counter')).toContainText('51–55 of 55');
    await move(page,far);await count(page,3);await expect(page.locator('.page-counter')).toContainText('1–3 of 3');await expect(page.locator('.lead-meta').first()).toContainText('Etobicoke Centre');
    await move(page,wide,10);await count(page,58);await expect(page.locator('#route-edit [name=name]')).toHaveValue('Unsaved afternoon plan');
    await page.locator('#filters [name=ward]').selectOption('02');await page.locator('#filters button.primary').click();await count(page,3);
    await move(page,near,15);await count(page,0);await expect(page.locator('#select-all')).toBeDisabled();await expect(page.locator('.lead')).toHaveCount(0);
    await page.locator('#reset-filters').click();await page.locator('#filters [name=source]').selectOption('manual');await page.locator('#filters [name=search]').fill(prefix);await page.locator('#filters button.primary').click();await count(page,55);
    assert.equal(await page.evaluate(()=>window.__testMaps.instances.length),1);await expect(page.locator('#route-edit [name=name]')).toHaveValue('Unsaved afternoon plan');
  });
  await scenario('select-across-pages',async page=>{
    const r=(await f.repo.command(f.actors.field_sales.operator,{id:randomUUID(),kind:'route.save',payload:{id:randomUUID(),name:'Bulk preservation',date:'2026-09-19',period:'afternoon',stops:[{id:randomUUID(),jobsiteId:sites[0].id}]}})).route;
    await f.repo.command(f.actors.field_sales.operator,{id:randomUUID(),kind:'visit.record',payload:{id:randomUUID(),jobsiteId:sites[0].id,routeId:r.id,stopId:r.data.stops[0].id,outcome:'Contact unavailable',observedStage:'Unknown',occurredAt:new Date().toISOString()}});
    const before=await f.repo.getRoute(r.id);await count(page,55);await chooseRoute(page,r);await page.locator('#route-edit [name=name]').fill('Keep these route edits');
    await page.locator('#select-all').click();await expect(page.locator('#selection-count')).toHaveText('55 selected');await page.locator('#next').click();await expect(page.locator('[data-select-site]:checked')).toHaveCount(5);
    await page.locator('#add-selected').click();await expect(page.locator('#selection-count')).toHaveText('0 selected');await saved(page);let actual=await f.repo.getRoute(r.id);assert.equal(actual.name,'Keep these route edits');assert.equal(actual.data.stops.length,55);assert.deepEqual(actual.data.stops[0],before.data.stops[0]);assert.deepEqual(new Set(actual.data.stops.map(s=>s.jobsiteId)),new Set(sites.slice(0,55).map(s=>s.id)));
    await expect(page.locator('#selection-count')).toHaveText('0 selected');await page.locator('#select-all').click();await page.locator('#add-selected').click();await expect(page.locator('#notice')).toContainText('already on this route');actual=await f.repo.getRoute(r.id);assert.equal(actual.data.stops.length,55);
    await move(page,far);await count(page,3);await expect(page.locator('#selection-count')).toHaveText('0 selected');await page.locator('[data-select-site]').first().check();await expect(page.locator('#selection-count')).toHaveText('1 selected');await page.locator('#add-selected').click();await expect(page.locator('#selection-count')).toHaveText('0 selected');await saved(page);assert.equal((await f.repo.getRoute(r.id)).data.stops.length,56);
  });
  await scenario('late-and-failed-responses',async page=>{
    await count(page,55);let release,started;const waiting=new Promise(r=>{started=r;}),gate=new Promise(r=>{release=r;});
    await page.route('**/api/field-sales/jobsites?*',async r=>{if(new URL(r.request().url()).searchParams.get('bounds')===far.join(',')){const response=await r.fetch();started();await gate;await r.fulfill({response});}else {await r.continue();}});
    await move(page,far);await waiting;await move(page,wide);await count(page,58);release();await page.waitForResponse(r=>r.url().includes('jobsites?')&&new URL(r.url()).searchParams.get('bounds')===far.join(','));await page.waitForTimeout(200);await count(page,58);
    await page.unroute('**/api/field-sales/jobsites?*');await page.route('**/api/field-sales/jobsites?*',r=>r.fulfill({status:503,json:{error:'Boundary unavailable'}}));await move(page,[-79.519,43.69,-79.481,43.73]);await expect(page.locator('#prospect-results')).toContainText('Unable to load');await expect(page.locator('.lead')).toHaveCount(0);await expect(page.locator('#select-all')).toBeDisabled();
    await page.unroute('**/api/field-sales/jobsites?*');await move(page,near);await count(page,55);
  });
  await scenario('bulk-limit-and-failure',async page=>{
    const r=(await f.repo.command(f.actors.field_sales.operator,{id:randomUUID(),kind:'route.save',payload:{id:randomUUID(),name:'Full afternoon',date:'2026-09-19',period:'afternoon',stops:Array.from({length:249},()=>({id:randomUUID(),jobsiteId:f.site.id}))}})).route;
    await count(page,55);await chooseRoute(page,r);await page.locator('#select-all').click();await expect(page.locator('#selection-count')).toHaveText('55 selected');await page.locator('#add-selected').click();await expect(page.locator('#notice')).toContainText('250');assert.equal((await f.repo.getRoute(r.id)).revision,r.revision);
    await move(page,far);await count(page,3);await page.route('**/api/field-sales/jobsites?*',request=>new URL(request.request().url()).searchParams.get('limit')==='200'?request.fulfill({status:503,json:{error:'Selection unavailable'}}):request.continue());await page.locator('#select-all').click();await expect(page.locator('#notice')).toContainText('Selection unavailable');await expect(page.locator('#selection-count')).toHaveText('0 selected');assert.equal((await f.repo.getRoute(r.id)).revision,r.revision);
  });
  await scenario('unavailable-map',async page=>{await count(page,59);await expect(page.locator('#map')).toContainText('Map unavailable');await page.locator('#filters [name=ward]').selectOption('01');await page.locator('#filters button.primary').click();await count(page,55);},false);
  // More than one API page, using real source rows and the existing 200-row endpoint limit.
  for(let i=0;i<201;i++){await f.repo.command(f.actors.field_sales.operator,{id:randomUUID(),kind:'jobsite.save',payload:{id:randomUUID(),name:`${prefix} extra ${i}`,address:`${10000+i} Map Test Road`,ward:'02',latitude:43.705,longitude:-79.50}});}
  await scenario('large-and-cancelled-selection',async page=>{
    await count(page,55);await move(page,wide);await count(page,259);await page.locator('#select-all').click();await expect(page.locator('#notice')).toContainText('250');await expect(page.locator('#selection-count')).toHaveText('0 selected');
    await move(page,far);await count(page,204);await page.locator('#select-all').click();await expect(page.locator('#selection-count')).toHaveText('204 selected');await page.locator('#clear-selection').click();
    await page.route('**/api/field-sales/jobsites?*',async request=>{if(new URL(request.request().url()).searchParams.get('limit')==='200'){const response=await request.fetch(),data=await response.json();await request.fulfill({json:{...data,items:data.items.slice(1)}});}else {await request.continue();}});
    await page.locator('#select-all').click();await expect(page.locator('#notice')).toContainText('list changed');await expect(page.locator('#selection-count')).toHaveText('0 selected');await page.unroute('**/api/field-sales/jobsites?*');
    let release,started;const waiting=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
    await page.route('**/api/field-sales/jobsites?*',async request=>{if(new URL(request.request().url()).searchParams.get('limit')==='200'){const response=await request.fetch();started();await gate;await request.fulfill({response});}else {await request.continue();}});
    await page.locator('#select-all').click();await waiting;await move(page,near);release();await count(page,55);await expect(page.locator('#selection-count')).toHaveText('0 selected');await expect(page.locator('#add-selected')).toBeDisabled();
  });
}finally {
  const files=['planner.js','planner-data.js','styles.css','service-worker.js'],source=Object.fromEntries(files.map(name=>{try{return [name,createHash('sha256').update(readFileSync(new URL(`../public/field-sales/${name}`,import.meta.url))).digest('hex')];}catch{return [name,null];}}));
  writeFileSync(`${folder}/planner-browser-coverage.json`,JSON.stringify(coverage));
  const report={passed:results.filter(r=>r.passed).length,failed:results.filter(r=>!r.passed).length,results,errors,source};writeFileSync(`${folder}/map-browser-results.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));await browser.close();await f.close();await closeDb();
}
assert.equal(results.filter(r=>!r.passed).length,0);assert.deepEqual(errors,[]);

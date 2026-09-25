import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { estimateSalesRoute } from '../../src/field-sales/routes.js';
import { quotePdf } from '../../src/field-sales/pdf.js';
import { calculateQuote } from '../../public/field-sales/domain.js';

function pdfText(pdf) {
  return [...pdf.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)].map(m=>{
    let content;try{content=inflateSync(Buffer.from(m[1],'latin1')).toString();}catch{content=m[1];}
    return [...content.matchAll(/<([0-9a-f]+)>/gi)].map(s=>Buffer.from(s[1],'hex').toString('latin1')).join('');
  }).join('\n');
}

test('R1 long routes preserve all legs and count each visit duration once',async()=>{
  const calls=[],stops=Array.from({length:25},(_,i)=>({id:String(i),address:`${i} Test Road`,latitude:43.7+i/1000,longitude:-79.5,stayMinutes:15,status:'planned'}));
  const gateway={estimateRoute:async p=>{calls.push(p);return {source:'google_routes_v2',driveMinutes:(p.stops.length-1)*10,legMinutes:p.stops.slice(1).map(()=>10),distanceMeters:1000,routePath:[]};}};
  const result=await estimateSalesRoute({stops,start:'2026-09-18T17:00:00Z'},gateway,{id:'rep'});
  assert.equal(calls.length,3);assert.ok(calls.every(c=>c.stops.length<=12));
  assert.equal(result.driveMinutes,240);assert.equal(result.stayMinutes,375);assert.equal(result.totalMinutes,615);
  assert.equal(result.arrivals.length,25);assert.equal(result.arrivals[1].at,'2026-09-18T17:25:00.000Z');
});
test('R2 map failure never presents guessed driving time as an actual road estimate',async()=>{
  const result=await estimateSalesRoute({stops:[{address:'1 Test',stayMinutes:15},{address:'2 Test',stayMinutes:15}],start:'2026-09-18T17:00:00Z'},{estimateRoute:async()=>({source:'fallback',driveMinutes:0,legMinutes:[0]})},{id:'rep'});
  assert.equal(result.available,false);assert.equal(result.totalMinutes,null);assert.equal(result.stayMinutes,30);
});
test('PDF1 combined/company downloads render exact immutable snapshot and distinguish drafts',async()=>{
  const s={...calculateQuote({lines:[{company:'MBBS',id:'1',itemId:'1',description:'Block',quantity:'3',unitRate:'19.99'},{company:'MBT',id:'2',itemId:'2',description:'Bin',quantity:'2',unitRate:'100'}]},{MBBS:{taxBps:1300},MBT:{taxBps:1300}}),customerName:'Builder',jobsite:{address:'90 Belfield Road'},companyProfiles:{MBBS:{name:'MBBS'},MBT:{name:'MBT'}}};
  const q={number:'FS-000001',snapshot:s,selected_revision:1,posting:[]};
  const pdf=await quotePdf(q);assert.equal(pdf.subarray(0,5).toString(),'%PDF-');
  const combinedText=pdfText(pdf);assert.match(combinedText,/293\.77/);assert.match(combinedText,/DRAFT/);assert.match(combinedText,/Revision 1/);assert.match(combinedText,/Builder/);assert.match(combinedText,/90 Belfield Road/);
  const company=await quotePdf(q,'MBBS'),companyText=pdfText(company);assert.match(companyText,/67\.77/);assert.doesNotMatch(companyText,/MBT|293\.77|226\.00/);
  await assert.rejects(quotePdf(q,'OTHER'),/company/i);
});
test('R8 route origin, destination and completed stops produce correct arrival times',async()=>{
  const requests=[],gateway={estimateRoute:async p=>{requests.push(p);return {source:'google_routes_v2',driveMinutes:21,legMinutes:[5,7,9],routePath:[{lat:43.7,lng:-79.5}]};}};
  const stops=[{id:'done',status:'completed'},{id:'skip',status:'skipped'},{id:'a',address:'1 Route Rd'},{id:'b',latitude:43.7,longitude:-79.5,stayMinutes:10}];
  const result=await estimateSalesRoute({stops,origin:{address:'Depot'},end:{address:'Office'},start:'2026-09-18T17:00:00Z',allowTolls:true},gateway,{id:'rep'});
  assert.equal(requests[0].stops.length,4);assert.equal(requests[0].allowTolls,true);assert.equal(result.stayMinutes,25);assert.equal(result.totalMinutes,46);assert.equal(result.finish,'2026-09-18T17:46:00.000Z');assert.deepEqual(result.arrivals,[{stopId:'a',at:'2026-09-18T17:05:00.000Z'},{stopId:'b',at:'2026-09-18T17:27:00.000Z'}]);
  for(const data of [{stops:null},{stops:[{address:'a',stayMinutes:-1}]},{stops:[{}]},{stops:[],start:'not a time'}]){await assert.rejects(estimateSalesRoute({...data,start:data.start||'2026-09-18T17:00:00Z'},gateway,{id:'rep'}));}
  const empty=await estimateSalesRoute({stops:[],start:'2026-09-18T17:00:00Z'},gateway,{id:'rep'});assert.equal(empty.totalMinutes,0);assert.deepEqual(empty.arrivals,[]);
});
test('PDF2 published multipage documents retain company terms, expiry and all line descriptions',async()=>{
  const policies={MBT:{taxBps:1300}},lines=Array.from({length:40},(_,i)=>({id:String(i),company:'MBT',itemId:'1',sku:`BIN-${i}`,description:`Service visit ${i}`,quantity:'2',unitRate:'100',unit:'BIN'}));
  const snapshot={...calculateQuote({lines},policies),customerName:'Construction Inc.',contact:'Superintendent',email:'site@example.test',jobsite:{address:'90 Belfield Road'},validUntil:'2026-10-18',note:'Call before arriving',companyProfiles:{MBT:{name:'MBT Services',address:'Toronto',terms:'Payment on agreed terms'}}};
  const quote={number:'FS-000002',snapshot,selected_revision:2,posting:[{company:'MBT',state:'done'}]};
  const pdf=await quotePdf(quote),contents=pdfText(pdf);assert.match(contents,/Published to NetSuite/);assert.doesNotMatch(contents,/DRAFT/);assert.match(contents,/9,040\.00/);assert.match(contents,/Payment on agreed terms/);assert.match(contents,/2026-10-18/);assert.match(contents,/Service visit 39/);assert.match(contents,/Call before arriving/);assert.ok((pdf.toString('latin1').match(/\/Type \/Page\b/g)||[]).length>1);
  await assert.rejects(quotePdf(quote,'MBBS'),e=>e.status===404);
});
test('PDF3 unit rates retain entered decimal precision while amounts remain cents',async()=>{
  const snapshot={...calculateQuote({lines:[{company:'MBBS',itemId:'1',description:'Fractional rate',quantity:'3',unitRate:'27.125'}]},{MBBS:{taxBps:1300}}),customerName:'Builder',jobsite:{address:'Site'}};
  const contents=pdfText(await quotePdf({number:'FS-3',snapshot,selected_revision:1,posting:[]}));assert.match(contents,/27\.125/);assert.match(contents,/81\.38/);assert.match(contents,/91\.96/);
});

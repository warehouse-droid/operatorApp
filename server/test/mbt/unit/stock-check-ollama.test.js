import test from 'node:test';
import assert from 'node:assert/strict';
import {createOllamaMatcher} from '../../../src/stock-check/ollama-matching.js';
const product={id:1,revision:1,sku:'URBAN-60',name:'Urban Rectangle 6cm Dark Charcoal',colour:'DARK CHARCOAL',size:'190mm x 380mm x 60mm / 7 1/2" x 15" x 2 3/8"',pickupLocation:'Ayr',pickupNeedsReview:false};
const line={lineId:1,productName:'UrbanTM Rectangle',color:'Dark Charcoal',size:'6cm 7.5X15',detailSpec:'104.91 sqft/plt'};
const reply=(sku=product.sku,confidence=.98,extra={})=>({matches:[{lineId:1,sku,confidence,reason:'Same family, colour and dimensions.',...extra}]});
function matcher(output=reply(),options={}) {
  const calls=[];
  const engine=createOllamaMatcher({settings:()=>({baseUrl:'http://fixture-ollama',model:'fixture-model'}),
    fetchImpl:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>({response:JSON.stringify(output)})};},...options});
  return {engine,calls};
}
test('Ollama resolves a known exact variant and receives only product descriptors and catalogue choices',async()=>{
  const {engine,calls}=matcher();
  const result=await engine.match([{...line,customerName:'PRIVATE CUSTOMER',scmInternalNote:'PRIVATE NOTE',quantity:999,password:'PRIVATE PASSWORD'}],[product]);
  assert.equal(result[0].product.id,1);assert.equal(result[0].aiMatch.status,'matched');assert.equal(calls.length,1);
  assert.equal(calls[0].url,'http://fixture-ollama/api/generate');assert.equal(calls[0].body.format,'json');
  const prompt=calls[0].body.prompt;for(const value of ['PRIVATE CUSTOMER','PRIVATE NOTE','PRIVATE PASSWORD','999']) {assert.equal(prompt.includes(value),false);}
  assert.ok(prompt.includes(product.sku));assert.ok(prompt.includes(line.productName));
});
test('invented SKUs, low confidence, wrong colour/thickness/size and duplicate results cannot auto-select',async()=>{
  const wrong=[{...product,colour:'FOSSIL'},{...product,name:'Urban Rectangle 8cm Dark Charcoal',size:'190mm x 380mm x 80mm'},
    {...product,name:'Urban 6cm 9x9 Dark Charcoal',size:'225mm x 225mm x 60mm'}];
  for(const output of [reply('INVENTED-SKU'),reply(product.sku,.6),{matches:[...reply().matches,...reply().matches]}]) {
    const {engine}=matcher(output);assert.equal((await engine.match([line],[product]))[0].product,null);
  }
  for(const candidate of wrong) {const {engine}=matcher();assert.equal((await engine.match([line],[candidate]))[0].product,null);}
});
test('side-specific coping and indistinguishable duplicate catalogue variants require review',async()=>{
  const coping={...product,name:'SienaStone Smooth CE Cop Safari-L',colour:'SAFARI',size:'1200mm x 180mm x 383mm'};
  const {engine}=matcher();assert.equal((await engine.match([{...line,productName:'Closed-end coping 383 Right',color:'Safari',size:''}],[coping]))[0].product,null);
  const other=matcher();assert.equal((await other.engine.match([line],[product,{...product,id:2,sku:'URBAN-60-OTHER'}]))[0].product,null);
});
test('outage and malformed responses fall back to manual review, while duplicate inference is cached and catalogue changes invalidate it',async()=>{
  for(const fetchImpl of [async()=>{throw Error('Offline');},async()=>({ok:false}),async()=>({ok:true,json:async()=>({response:'not JSON'})})]) {
    const {engine}=matcher(reply(),{fetchImpl});assert.equal((await engine.match([line],[product]))[0].product,null);
  }
  const {engine,calls}=matcher();await Promise.all([engine.match([line],[product]),engine.match([line],[product])]);assert.equal(calls.length,1);
  await engine.match([line],[product]);assert.equal(calls.length,1);
  await engine.match([line],[{...product,revision:2}]);assert.equal(calls.length,2);
});
test('a confident model cannot substitute another product family, finish or unit role',async()=>{
  for(const [description,candidate] of [
    [line,{...product,name:'Trevia Rectangle 6cm Dark Charcoal'}],
    [{...line,productName:'Urban EcoTerra Rectangle'},{...product,name:'Urban EasyClean Rectangle 6cm Dark Charcoal'}],
    [{...line,productName:'Endura Coping Chamfered'},{...product,name:'Endura Coping 24x14 Bullnose Dark Charcoal'}],
    [{...line,productName:'SienaStone Smooth Corner',size:''},{...product,name:'SienaStone Smooth Wall Dark Charcoal'}]
  ]) {const {engine}=matcher();assert.equal((await engine.match([description],[candidate]))[0].product,null);}
});
test('timeouts, busy requests and large batches return manual review without retaining unbounded work',async()=>{
  const fetchImpl=async(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('Aborted')),{once:true}));
  const {engine}=matcher(reply(),{fetchImpl,timeoutMs:15});
  const pending=engine.match([line],[product]);
  const busy=await engine.match([{...line,lineId:2}],[product]);assert.equal(busy[0].product,null);assert.match(busy[0].aiMatch.reason,/another request/u);
  assert.equal((await pending)[0].product,null);
  assert.equal((await engine.match(Array.from({length:31},(_value,index)=>({...line,lineId:index+1})),[product])).every(row=>!row.product),true);
});
test('compact choices stay bound to their line and candidate list, with invalid or duplicate rows left for review',async()=>{
  const {engine}=matcher({matches:[[1,1,.99]]});assert.equal((await engine.match([line],[product]))[0].product.id,1);
  for(const matches of [[[1,0,1]],[[1,999,1]],[[1,1,.5]],[[1,1,.99],[1,1,.99]],[[99,1,1]],[[1,1.1,1]],[[1,1,'1']]]) {
    const fixture=matcher({matches});assert.equal((await fixture.engine.match([line],[product]))[0].product,null);
  }
});
test('plain coping never silently becomes closed-end or a side-specific unit',async()=>{
  const input={...line,productName:'SienaStone Smooth Coping',size:''};
  for(const name of ['SienaStone Smooth CE Cop Dark Charcoal-L','SienaStone Smooth CE Cop Dark Charcoal-R','SienaStone Smooth Closed-End Coping Dark Charcoal']) {
    const {engine}=matcher();assert.equal((await engine.match([input],[{...product,name}]))[0].product,null);
  }
});
test('charges never match products and an unspecified coping edge cannot be guessed between catalogue finishes',async()=>{
  const delivery={...line,productName:'DELIVERY CHARGE',color:'',size:''};
  const fixture=matcher();assert.equal((await fixture.engine.match([delivery],[product]))[0].product,null);
  const input={...line,productName:'Endura Coping',size:'24x14'},cham={...product,name:'Endura Coping 24x14 Cham Dark Charcoal',size:'600mm x 355mm x 60mm'},
    bullnose={...cham,id:2,sku:'ENDURA-BULLNOSE',name:'Endura Coping 24x14 Bullnose Dark Charcoal'};
  const other=matcher();assert.equal((await other.engine.match([input],[cham,bullnose]))[0].product,null);
});
test('a two-line Beacon Hill request sends only the stated colour and finish and sends each description once',async()=>{
  const material=(id,thickness,colour,finish)=>({...product,id,sku:'BEACON-'+id,name:'Beacon Hill '+finish+' '+thickness+'cm '+colour,
    colour,finish:finish.toUpperCase(),shape:'RANDOM',size:'Random'});
  const products=[material(10,8,'Fossil','Smooth'),material(11,8,'Fossil','Textured'),material(12,8,'Granite Fusion','Smooth'),
    material(20,6,'Fossil','Smooth'),material(21,6,'Platinum','Smooth')];
  const lines=[80,60].map((thickness,index)=>{const description='Beacon Hill '+thickness+'mm S Rdm Fossil 81.6sqft/plt, 11.66sqft/lyr, 7lyrs/plt';
    return {lineId:index+1,productName:description,detailSpec:description,color:'',size:'',itemCode:null};});
  const before=JSON.stringify(lines),fixture=matcher({matches:[[1,1,.98],[2,1,.98]]});
  const result=await fixture.engine.match(lines,products),prompt=fixture.calls[0].body.prompt,
    data=JSON.parse(prompt.split('/no_think\n')[1]);
  assert.deepEqual(data.lines.map(row=>row.candidates.map(candidate=>candidate.sku)),[['BEACON-10'],['BEACON-20']]);
  assert.deepEqual(result.map(row=>row.product?.id),[10,20]);
  for(const input of lines) {assert.equal(prompt.split(input.productName).length-1,1);}
  assert.equal(data.lines.every(row=>!Object.hasOwn(row.line,'detailSpec')&&!Object.hasOwn(row.line,'itemCode')),true);
  assert.equal(JSON.stringify(lines),before);
  assert.deepEqual(fixture.calls[0].body.options,{temperature:0,num_ctx:8192,num_predict:180,num_thread:2,num_batch:128});
});
test('description constraints preserve complete colour phrases, conflicting-colour review and T finish semantics',async()=>{
  const fossil={...product,sku:'BEACON-1',name:'Beacon Hill Smooth 8cm Fossil',colour:'FOSSIL',size:'Random',finish:'SMOOTH'},
    blend={...fossil,id:2,sku:'BEACON-2',name:'Beacon Hill Smooth 8cm Fossil Blend',colour:'FOSSIL BLEND'},
    textured={...fossil,id:3,sku:'BEACON-3',name:'Beacon Hill Flagstone 8cm Fossil',finish:'TEXTURED'};
  for(const [description,expected] of [['Beacon Hill 80mm S Rdm Fossil Blend',[blend.sku]],['Beacon Hill 80mm T Rdm Fossil',[textured.sku]]]) {
    const fixture=matcher({matches:[[1,1,.99]]});
    await fixture.engine.match([{...line,productName:description,color:'',size:''}],[fossil,blend,textured]);
    const data=JSON.parse(fixture.calls[0].body.prompt.split('/no_think\n')[1]);
    assert.deepEqual(data.lines[0].candidates.map(candidate=>candidate.sku),expected);
  }
  const fixture=matcher();
  const result=await fixture.engine.match([{...line,productName:'Beacon Hill 80mm S Rdm Fossil / Fossil Blend',color:'',size:''}],[fossil,blend,textured]);
  assert.equal(result[0].product,null);assert.equal(fixture.calls.length,0);
});

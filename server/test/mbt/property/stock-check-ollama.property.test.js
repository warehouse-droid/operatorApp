import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {createOllamaMatcher,compatibleVariant} from '../../../src/stock-check/ollama-matching.js';
const product={id:1,revision:1,sku:'TEST-ONLY',name:'Urban Rectangle 6cm Dark Charcoal',colour:'Dark Charcoal',size:'190mm x 380mm x 60mm / 7 1/2" x 15" x 2 3/8"',pickupLocation:'Ayr',pickupNeedsReview:false};
const line={lineId:1,productName:'UrbanTM Rectangle',color:'Dark Charcoal',size:'6cm 7.5x15'};
test('property: arbitrary model SKUs cannot select a different catalogue identity',async()=>{
  await fc.assert(fc.asyncProperty(fc.string({minLength:1,maxLength:80}).filter(value=>value!==product.sku),async sku=>{
    const matcher=createOllamaMatcher({settings:()=>({baseUrl:'http://fixture',model:'fixture'}),fetchImpl:async()=>({ok:true,json:async()=>({response:JSON.stringify({matches:[{lineId:1,sku,confidence:1}]})})})});
    assert.equal((await matcher.match([line],[product]))[0].product,null);
  }),{seed:20261015,numRuns:100});
});
test('property: colour conflicts and a change from 60mm to another standard thickness cannot be overridden',()=>{
  fc.assert(fc.property(fc.constantFrom('Fossil','Safari','Sterling','Winter Marvel'),fc.constantFrom(70,80,100),(color,thickness)=>{
    assert.equal(compatibleVariant({...line,color},product),false);
    assert.equal(compatibleVariant(line,{...product,name:'Urban Rectangle '+thickness+'mm Dark Charcoal',size:'190mm x 380mm x '+thickness+'mm'}),false);
    assert.equal(compatibleVariant(line,product),true);
  }),{seed:20261015,numRuns:100});
});
test('property: candidate order cannot change a description-constrained colour, thickness and finish',async()=>{
  await fc.assert(fc.asyncProperty(fc.constantFrom(60,80),fc.constantFrom('Fossil','Oat Beige'),fc.boolean(),async(thickness,colour,reverse)=>{
    const desired={...product,name:'Beacon Hill Smooth '+thickness/10+'cm '+colour,colour,size:'Random',shape:'RANDOM',finish:'SMOOTH'},
      other={...desired,id:2,sku:'OTHER-COLOUR',name:desired.name.replace(colour,'Platinum'),colour:'Platinum'},
      textured={...desired,id:3,sku:'OTHER-FINISH',name:desired.name.replace('Smooth','Flagstone'),finish:'TEXTURED'};
    const candidates=reverse?[textured,other,desired]:[desired,other,textured];
    const matcher=createOllamaMatcher({settings:()=>({baseUrl:'http://fixture',model:'fixture'}),fetchImpl:async()=>({ok:true,json:async()=>({response:JSON.stringify({matches:[[1,1,.99]]})})})});
    const result=await matcher.match([{lineId:1,productName:'Beacon Hill '+thickness+'mm S Rdm '+colour}],candidates);
    assert.equal(result[0].product?.id,1);
  }),{seed:20261015,numRuns:100});
});

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

function pauseUi(active) {
  let click;
  const context=vm.createContext({
    URLSearchParams,setTimeout,clearTimeout,
    smartState:{busy:"",data:{planningExclusions:{items:[],blanketItems:[]}}},
    smartScmApp:{addEventListener:(name,handler)=>{if(name==="click")click=handler;}},
    document:{getElementById:()=>null,querySelector:()=>null},
    smartCanWrite:()=>true,smartEscape:v=>String(v??""),smartNumber:v=>String(v),smartDate:()=>"",
    smartRender(){},smartApi:async(_url,options)=>options?.method==="POST"
      ?{active,deactivationNote:"Automatically resumed by Blanket PO coverage: POB03737"}
      :{items:[],blanketItems:[]},
    smartWork:async(_label,task,success)=>{const result=await task();context.smartState.notice=success;return result;}
  });
  const file=new URL("../../../public/scm-smart-exclusions.js",import.meta.url);
  vm.runInContext(fs.readFileSync(file,"utf8"),context,{filename:file.pathname});
  return {context,click};
}

test("pause panel explains that usable Blanket coverage automatically resumes all item holds",()=>{
  const {context}=pauseUi(false);
  const html=vm.runInContext("smartPlanningExclusionState.open=true; smartPlanningExclusionPanel()",context);
  assert.match(html,/Blanket coverage automatically resumes.*holds/i);
});

test("a hold automatically resumed by the server displays its actual outcome",async()=>{
  const {context,click}=pauseUi(false);
  await click({target:{closest:()=>({dataset:{smartAction:"add-planning-exclusion",itemId:"2764"}})}});
  assert.match(context.smartState.notice,/automatically resumed.*Blanket/i);
  assert.doesNotMatch(context.smartState.notice,/paused for new vendor POs/);
});

test("an uncovered item still reports a normal vendor PO pause",async()=>{
  const {context,click}=pauseUi(true);
  await click({target:{closest:()=>({dataset:{smartAction:"add-planning-exclusion",itemId:"2764"}})}});
  assert.match(context.smartState.notice,/paused for new vendor POs/);
});

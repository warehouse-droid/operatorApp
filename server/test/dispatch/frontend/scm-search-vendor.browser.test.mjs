import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { before, after, test } from "node:test";
import { chromium, expect } from "@playwright/test";

let browser, server, baseUrl;
const requests=[];
const row={orderKind:"PO",orderRef:"PO-VENDOR-UI",status:"Queued",method:"Vendor",pickupPoint:"Vendor Yard",dropoffPoint:"2967",brand:"Vendor",updatedAt:"2026-09-10T12:00:00.000Z"};
before(async()=>{
  server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,"http://localhost");
    if(url.pathname.endsWith(".js")||url.pathname.endsWith(".css")){
      res.setHeader("Content-Type",url.pathname.endsWith(".js")?"text/javascript":"text/css");
      res.end(await readFile(new URL(`../../../public${url.pathname}`,import.meta.url)));return;
    }
    if(url.pathname.startsWith("/api/")){
      let body="";for await(const chunk of req)body+=chunk;
      requests.push({method:req.method,path:url.pathname,query:Object.fromEntries(url.searchParams),body:body?JSON.parse(body):null});
      res.setHeader("Content-Type","application/json");
      if(req.method==="POST")res.end(JSON.stringify({result:{completed:true}}));
      else if(url.pathname.includes("presets"))res.end(JSON.stringify(["SCM Working","Completed"].map(name=>({name}))));
      else if(url.pathname.endsWith("/schedule"))res.end(JSON.stringify({rows:url.searchParams.get("search")?[{...row,orderRef:"POB03781",status:"Queued",calculatedStatus:"Completed"}]:[row,{...row,orderRef:"PO-MBT-UI",method:"MBT"}]}));
      else res.end(JSON.stringify({persisted:false,showDetails:false}));
      return;
    }
    res.setHeader("Content-Type","text/html");
    res.end(`<!doctype html><html><body><main id="scmScheduleApp"></main><script>
      function requireDispatchLogin({onReady}) {window.ready=onReady({id:'scm-browser',role:'scm'});}
      </script><script src="/scm-schedule.js"></script></body></html>`);
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  baseUrl=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,args:["--no-sandbox"]});
});
after(async()=>{await browser?.close();await new Promise(resolve=>server?.close(resolve));});
async function pageFor(t){
  const page=await browser.newPage();t.after(()=>page.close());
  const errors=[];page.on("pageerror",error=>errors.push(error.message));
  t.after(()=>assert.deepEqual(errors,[]));
  await page.goto(`${baseUrl}/scm/POTOschedule`);await page.evaluate(()=>window.ready);
  return page;
}
test("SCM search includes Completed despite a Queued status selection",async t=>{
  const page=await pageFor(t);
  await page.evaluate(()=>{scmScheduleFilters.status=["Queued"];});
  await page.locator('[data-filter="search"]').fill("POB03781");
  await expect(page.locator('[data-row-ref="POB03781"]')).toHaveCount(1);
  await expect(page.locator('[data-row-ref="POB03781"] [data-column-key="status"]')).toContainText("Completed");
  const latest=requests.filter(r=>r.path==="/api/scm/schedule").at(-1);
  assert.equal(latest.query.search,"POB03781");
  assert.equal(latest.query.status,undefined);
  assert.equal(await page.evaluate(()=>scmScheduleRowMatchesCurrentFilters(scmScheduleRows[0])),true);
  await page.locator('[data-filter="search"]').fill("");
  await expect(page.locator('[data-row-ref="PO-VENDOR-UI"]')).toHaveCount(1);
  assert.equal(requests.filter(r=>r.path==="/api/scm/schedule").at(-1).query.status,"Queued");
});
test("Vendor Complete button sends a local completion with current revision",async t=>{
  const page=await pageFor(t);
  const button=page.locator('[data-row-ref="PO-VENDOR-UI"] [data-action="complete-vendor"]');
  await expect(button).toHaveText("Complete");
  await expect(page.locator('[data-row-ref="PO-MBT-UI"] [data-action="complete-vendor"]')).toHaveCount(0);
  await button.click();
  await expect(page.locator("#scmScheduleApp")).toContainText("PO-VENDOR-UI was marked Completed");
  const request=requests.findLast(r=>r.method==="POST");
  assert.equal(request.path,"/api/scm/schedule/PO-VENDOR-UI/complete-vendor");
  assert.deepEqual(request.body,{orderKind:"PO",expectedUpdatedAt:row.updatedAt});
});

test("Vendor completion controls follow view, role, method, and completion state",async t=>{
  const page=await pageFor(t);
  const visibility=await page.evaluate(()=>{
    const base=scmScheduleRows[0];
    const variants=[{method:"MBT"},{status:"Cancelled"},{reconciliationStatus:"review"},
      {dispatchCompletionEvidenceType:"scm_vendor"},{scmSplitLocked:true},{orderKind:"SO"}];
    const denied=variants.map(patch=>scmScheduleCanCompleteVendor({...base,...patch}));
    scmScheduleFilters.view="completed";denied.push(scmScheduleCanCompleteVendor(base));
    scmScheduleFilters.view="scm working";scmScheduleOperator={id:"outsider",role:"dispatcher"};
    denied.push(scmScheduleCanCompleteVendor(base));
    return denied;
  });
  assert.deepEqual(visibility,Array(8).fill(false));
});

test("a rejected Vendor completion shows its error and re-enables the button",async t=>{
  const page=await pageFor(t);
  await page.route("**/api/scm/schedule/*/complete-vendor",route=>route.fulfill({status:409,contentType:"application/json",body:JSON.stringify({error:"Order changed; refresh"})}));
  const button=page.locator('[data-row-ref="PO-VENDOR-UI"] [data-action="complete-vendor"]');
  await button.click();
  await expect(page.locator("#scmScheduleApp")).toContainText("Completion failed");
  await expect(button).toBeEnabled();
});

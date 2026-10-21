import {readFile,writeFile} from 'node:fs/promises';
import http from 'node:http';
import {chromium} from '@playwright/test';

const root='test-artifacts/dispatch-all-history-20261002/packing-slip';
const stage=process.argv.includes('--baseline') ? 'before' : 'after';
const script=await readFile(process.env.SCM_PACKING_SLIP_CLIENT || `${root}/scm-schedule-${stage}.js`,'utf8');
const baseRow={orderKind:'PO',orderRef:'PO-UI-1',status:'Queued',method:'MBT',pickupPoint:'Vendor A',
  pickupOptions:['Vendor A'],dropoffPoint:'3445',dropoffOptions:['3445'],party:'Fixture vendor',brand:'Fixture',
  content:'Fixture pavers',packingSlipRef:'PACK-1',weightLbs:1000};
const rows=[baseRow,{...baseRow,orderRef:'PO-UI-2',packingSlipRef:'PACK-2',isScmSplit:true,scmSplitLocked:true},
  {...baseRow,orderRef:'PO-UI-3',packingSlipRef:'PACK-3',status:'Reconcile Review'},
  {...baseRow,orderRef:'PO-UI-4',packingSlipRef:'PACK-4',isBlanket:true}];
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/scm-schedule.js'){res.setHeader('Content-Type','text/javascript');res.end(script);return;}
  if(url.pathname.startsWith('/api/')){
    res.setHeader('Content-Type','application/json');
    if(url.pathname.includes('presets')){res.end(JSON.stringify(['SCM Working','Dispatch','Yard Manager','Completed','Blanket'].map(name=>({name}))));return;}
    if(url.pathname.endsWith('/schedule')){res.end(JSON.stringify({rows:url.searchParams.get('view')==='completed' ? rows.map(row=>({...row,status:'Completed'})) : rows}));return;}
    res.end(JSON.stringify({persisted:false,showDetails:false}));return;
  }
  res.setHeader('Content-Type','text/html');
  res.end(`<!doctype html><html><body><main id="scmScheduleApp"></main><script>
    function requireDispatchLogin({onReady}){window.scheduleReady=onReady(window.location.pathname.startsWith('/sales/') ? {id:'sales',role:'sales'} : {id:'admin',role:'admin'});}
    </script><script src="/scm-schedule.js"></script></body></html>`);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const report={stage,views:[],browserErrors:[],passed:false};
try {
  for(const [surface,path,views] of [['scm','/scm/POTOschedule',['scm working','dispatch','yard manager','completed','blanket']],
    ['dispatch','/dispatch/po-to-schedule',['dispatch','completed']],['sales','/sales/schedule',['yard manager']]]) {
    const context=await browser.newContext();const page=await context.newPage();
    page.on('pageerror',error=>report.browserErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}${path}`);await page.evaluate(()=>window.scheduleReady);
    for(const view of views) {
      const control=page.locator('[data-filter="view"]');
      if(await control.evaluate(element=>element.tagName==='SELECT')) {await control.selectOption(view);}
      await page.evaluate(async selected=>{scmScheduleFilters.view=selected;await loadScmSchedule();},view);
      await page.waitForFunction(selected=>!scmScheduleLoading && scmScheduleFilters.view===selected
        && document.querySelectorAll('.scm-sheet-row [data-column-key="packing"]').length>0,view);
      const packing=page.locator('.scm-sheet-row [data-column-key="packing"]');
      report.views.push({surface,view,...await packing.evaluateAll(cells=>({cells:cells.length,
        links:cells.reduce((sum,cell)=>sum+cell.querySelectorAll('button,a').length,0),
        inputs:cells.reduce((sum,cell)=>sum+cell.querySelectorAll('input').length,0),text:cells.map(cell=>cell.textContent)}))});
    }
    await context.close();
  }
  report.passed=!report.browserErrors.length && report.views.every(row=>row.cells>0
    && (row.surface==='scm' && row.view==='scm working' ? row.links===1 && row.inputs===2 : row.links===0 && row.inputs===0));
} finally {
  await browser.close();await new Promise(resolve=>server.close(resolve));
  await writeFile(process.env.SCM_PACKING_SLIP_REPORT || `${root}/views-${stage}.json`,JSON.stringify(report,null,2)+'\n');
}
console.log(JSON.stringify(report));process.exitCode=report.passed ? 0 : 1;

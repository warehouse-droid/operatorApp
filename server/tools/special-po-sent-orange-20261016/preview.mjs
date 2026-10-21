import {readFile,writeFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';
import {specialPlanningStatus} from '../../public/special-stock-case-status.js';

const html=await readFile('public/scm-stock-requests.html','utf8');
const paths=[...html.matchAll(/<link rel="stylesheet" href="([^"?]+)/g)].map(match=>'public'+match[1]);
const styles=(await Promise.all(paths.map(path=>readFile(path,'utf8')))).join('\n');
const source=await readFile('public/scm-special-stock-requests.js','utf8');
const action=source.match(/return '(<form data-special-po-sent-form>[^']+)';/)[1];
const detail={id:1,salesOrderId:11,salesOrderRef:'SO-12345',purchaseOrderId:12,purchaseOrderRef:'PO-12345',
  purchaseOrderStatus:'Purchase Order : Pending Receipt',purchaseOrderApproved:true};
const options={showOrderPreviews:true,purchaseOrderActions:action};
const planned={...detail,dispatchPlanning:{anyPlanned:true,purchaseOrder:{planned:true,plans:[]}}};
const browser=await chromium.launch({headless:true,channel:'chromium',args:['--no-sandbox']});
const observations=[];
try {
  for(const width of [1100,390]) {
    const page=await browser.newPage({viewport:{width,height:800}});
    await page.route('**/*',route=>route.abort());
    await page.setContent(`<style>${styles}</style><main class="special-stock-page" style="max-width:1000px;margin:0 auto;padding:16px"><section class="stock-request-panel stock-request-detail"><h2>Special Order</h2>${specialPlanningStatus(detail,false,options)}${specialPlanningStatus(planned,false,options)}</section></main>`);
    const buttons=page.locator('[data-special-po-sent-form] button');
    const colors=()=>buttons.evaluateAll(nodes=>nodes.map(button=>{
      const style=getComputedStyle(button);
      return {text:style.color,background:style.backgroundColor,border:style.borderColor};
    }));
    const normal=await colors();
    await page.screenshot({path:`test-artifacts/button-${width}.png`,fullPage:true});
    await buttons.first().hover();
    const hover=await colors();
    await buttons.last().hover();
    const plannedHover=await colors();
    observations.push({width,normal,hover,plannedHover});
    await page.close();
  }
}finally{await browser.close();}
await writeFile('test-artifacts/preview.json',JSON.stringify({observations},null,2));
console.log(JSON.stringify({observations}));

import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {chromium} from 'playwright';
const source=readFileSync('public/mbt-gates.js','utf8');
const render=source.slice(source.indexOf('function renderAttentionCommands('),source.indexOf('function renderGates('));
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try {
 const page=await browser.newPage();await page.setContent('<main id="queue"></main>');
 await page.evaluate(()=>Object.assign(window,{saving:false,attentionLoadError:'',attentionCommands:[],operatorNetSuiteAttention:document.querySelector('#queue'),
  transferPostingJobs:[{id:'a',order_ref:'TOB01190',transaction_type:'IF',status:'waiting_driver',driver_order_refs:['SOA09690'],driver_dispatch_refs:['SOA09690'],lines:[]},
   {id:'b',order_ref:'TOB01191',transaction_type:'IF',status:'waiting_driver',driver_order_refs:['SOA09694','SOA09702'],driver_dispatch_refs:['GOA-9694-9702'],lines:[]},
   {id:'c',order_ref:'TO-NORMAL',transaction_type:'IR',status:'waiting_driver',lines:[]}]}));
 await page.addScriptTag({content:render+'\nrenderAttentionCommands();'});
 const cards=page.locator('article');assert.equal(await cards.count(),3);
 assert.match(await cards.nth(0).textContent(),/Waiting for.*SOA09690.*delivery/i);
 for(const ref of ['SOA09694','SOA09702','GOA-9694-9702'])assert.ok((await cards.nth(1).textContent()).includes(ref));
 assert.match(await cards.nth(2).textContent(),/TO-NORMAL/);
 await page.evaluate(()=>{transferPostingJobs[0].driver_order_refs=['<img src=x onerror=alert(1)>'];renderAttentionCommands();});
 assert.equal(await page.locator('img').count(),0);
 await page.evaluate(()=>{transferPostingJobs[0].driver_order_refs=['SOA09690'];renderAttentionCommands();});
 await page.screenshot({path:'test-artifacts/to-linked-so-20261004/queue.png',fullPage:true});
 writeFileSync('test-artifacts/to-linked-so-20261004/browser.json',JSON.stringify({passed:true,checks:7})+'\n');
 console.log('7 browser checks passed');
}finally{await browser.close();}

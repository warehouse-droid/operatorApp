import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import {once} from 'node:events';
import {chromium} from 'playwright';
import {app} from '../../../src/server.js';
import {query,closeDb} from '../../../src/db.js';
import {createOperator,loginOperator} from '../../../src/auth-repository.js';
import {createBossRepository} from '../../../src/boss-approval-repository.js';
let server,browser,base,repo;const people=[],requests={};let admin;
const directory='test-artifacts/boss-search-history-20261003/browser';
before(async()=>{
 assert.equal(process.env.MBT_TEST_ISOLATED,'1');await fs.mkdir(directory,{recursive:true});
 await query('TRUNCATE boss_approval_notifications,boss_approval_events,boss_approval_commands,boss_approval_requests,boss_approval_sources RESTART IDENTITY');
 await query('UPDATE boss_approval_principals SET operator_id=NULL,owner_id=NULL');await query('UPDATE boss_approval_settings SET enabled=false,revision=1');repo=createBossRepository();
 for(const [i,key] of ['tony_tan','jason_pu','alex_huang'].entries()){
  const username='history-browser-'+crypto.randomUUID();await createOperator({username,role:'boss',password:'test-password',email:key+'@example.test'});
  const session=await loginOperator(username,'test-password');people.push({...session.operator,token:session.token,key,ownerId:String(i+1)});
 }
 await repo.configure({revision:1,enabled:true,principals:people.map(p=>({key:p.key,operatorId:p.id,ownerId:p.ownerId}))},people[0].id);
 for(const [id,status,name,owner] of [[969001,'pending','Trace A Pending',null],[969002,'approved','Trace B Approved', '2'],[969003,'rejected','Trace A Rejected', '2'],[969004,'pending','Trace Hidden', '2']]){
  const s={orderId:id,tranid:'SO'+id,status:'A',customerId:77,customerName:name,ownerId:owner,creditLimit:'200000',balance:'14723.64',unbilledOrders:'37021.83',currency:'CAD',orderVersion:'v1',orderTotal:'54.10',refreshedAt:'2026-10-03T01:02:03.000Z'};
  await repo.observe({orderType:'sales_order',netsuiteOrderId:id,tranid:s.tranid,status:'A'});const r=await repo.applySource(await repo.claimSource(),s);requests[id]=r;
  if(status==='rejected'){
   // A legacy local rejection is a fixture, not a new native-close command.
   await query("UPDATE boss_approval_requests SET status='rejected',completed_at=now(),actor_id=$2,actor_name='Jason Pu' WHERE id=$1",[r.id,people[1].id]);
   await query("INSERT INTO boss_approval_events(request_id,kind,actor_id,actor_name,snapshot) VALUES($1,'rejected',$2,'Jason Pu',$3)",[r.id,people[1].id,r.snapshot]);
  }
  if(status==='approved'){
   await repo.claimDecision(people[1],{requestId:r.id,expectedRevision:r.revision,commandId:crypto.randomUUID(),action:'accept'});
   await repo.finishCommand(await repo.claimCommand(),{outcome:'approved',snapshot:{...s,status:'B',creditLimit:'1'}});
   await repo.applySource(await repo.claimSource(),{...s,status:'B',creditLimit:'1',balance:'1000',unbilledOrders:'500'});
  }
 }
 const user=await createOperator({username:'history-admin-'+crypto.randomUUID(),password:'test-password',role:'admin'});admin=await loginOperator(user.username,'test-password');
 server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,args:['--no-sandbox']});
});
after(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await closeDb();});
async function open(person=people[0],width=390){
 const context=await browser.newContext({viewport:{width,height:844},serviceWorkers:'block'});
 await context.addInitScript(({token})=>localStorage.setItem('mbbs.staff.token',token),{token:person.token});
 const page=await context.newPage();await page.coverage.startJSCoverage({resetOnNavigation:false});return {page,context};
}
async function close(page,context,name){await fs.writeFile(`${directory}/${name}-coverage.json`,JSON.stringify(await page.coverage.stopJSCoverage()));await context.close();}
async function search(page,text){await page.getByRole('searchbox').fill(text);await page.getByRole('button',{name:'Search',exact:true}).click();}
test('global search from both tabs shows grey approved cards with fixed approval figures and audit context',async()=>{
 for(const width of [320,390,430]){
  const {page,context}=await open(people[0],width);await page.goto(base+'/boss');await page.getByText('Trace A Pending',{exact:true}).waitFor();
  await search(page,'Trace');await page.getByText('Trace B Approved',{exact:true}).waitFor({timeout:4000});
  assert.equal(await page.getByText('Search results across Pending and History',{exact:true}).count(),1);assert.equal(await page.locator('.boss-card').count(),3);assert.equal(await page.getByText('Trace Hidden',{exact:true}).count(),0);assert.equal(await page.getByText('Recorded without closing in NetSuite.',{exact:true}).count(),1);
  const approved=page.locator(`[data-request="${requests[969002].id}"]`);
  assert.equal(await approved.evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(229, 231, 235)');
  assert.equal(await approved.getByText('Saved approval figures',{exact:true}).count(),1);
  for(const amount of ['200,000.00','-51,745.47','148,254.53','14,723.64','37,021.83']){assert.equal(await approved.getByText(amount,{exact:true}).count(),1);}
  assert.equal(await approved.getByRole('button',{name:'Accept',exact:true}).count(),0);assert.equal(await approved.getByRole('button',{name:'Reject',exact:true}).count(),0);
  assert.match(await approved.textContent(),/Jason Pu/);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await approved.getByRole('button',{name:'View approval history'}).click();await page.getByRole('dialog').getByText('Saved approval figures',{exact:true}).waitFor();
  assert.equal(await page.getByRole('dialog').getByText('148,254.53',{exact:true}).count(),1);await page.getByRole('button',{name:'Close',exact:true}).click();
  await page.getByRole('tab',{name:'History',exact:true}).click();await fs.writeFile(`${directory}/filter-${width}.html`,await page.locator('#historyFilter').evaluate(el=>el.outerHTML));await page.locator('#historyFilter').selectOption('approved');await page.getByText('Trace B Approved',{exact:true}).waitFor();
  await search(page,'Trace');await page.getByText('Trace A Pending',{exact:true}).waitFor();assert.equal(await page.locator('.boss-card').count(),3);
  await page.screenshot({path:`${directory}/search-approved-${width}.png`,fullPage:true});
  await page.getByRole('button',{name:'Clear search',exact:true}).click();await page.locator('#historyFilter').waitFor();assert.equal(await page.getByText('Trace A Pending',{exact:true}).count(),0);
  await close(page,context,'global-'+width);
 }
});
test('a newer search wins if a previous request is slow, and refresh preserves a typed draft',async()=>{
 const {page,context}=await open();await page.goto(base+'/boss');await page.getByText('Trace A Pending',{exact:true}).waitFor();
 let release;const hold=new Promise(resolve=>{release=resolve;});let reached;const started=new Promise(resolve=>{reached=resolve;});
 await page.route('**/api/boss/requests?**',async route=>{
  if(new URL(route.request().url()).searchParams.get('search')==='Trace A'){reached();await hold;}
  await route.continue();
 });
 await search(page,'Trace A');await started;await search(page,'Trace B');release();
 await page.getByText('Trace B Approved',{exact:true}).waitFor({timeout:4000});assert.equal(await page.getByText('Trace A Pending',{exact:true}).count(),0);
 await page.getByRole('searchbox').fill('Unsubmitted draft');await page.getByRole('searchbox').focus();
 await page.evaluate(()=>{window.savedSearchNode=document.querySelector('[name=search]');document.dispatchEvent(new Event('visibilitychange'));});
 await page.waitForFunction(()=>document.querySelector('[name=search]')!==window.savedSearchNode);
 assert.equal(await page.getByRole('searchbox').inputValue(),'Unsubmitted draft');assert.equal(await page.getByRole('searchbox').evaluate(el=>el===document.activeElement),true);
 await close(page,context,'latest-query');
});
test('Admin audit can filter a completed approval and displays its saved snapshot safely',async()=>{
 const evil='Trace <img src=x onerror="window.auditInjected=true">';
 await query("UPDATE boss_approval_events SET snapshot=jsonb_set(snapshot,'{customerName}',to_jsonb($1::text)) WHERE request_id=$2 AND kind='approved'",[evil,requests[969002].id]);
 const {page,context}=await open(admin,1280);await page.goto(base+'/admin/audit');
 await page.locator('[data-audit-filter=tranid]').fill('SO969002');await page.locator('[data-action=apply-audit-filters]').click();
 await page.locator('[data-audit-filter=action] option[value="boss.approval.approved"]').waitFor({state:'attached',timeout:4000});
 await page.locator('[data-audit-filter=action]').selectOption('boss.approval.approved');await page.locator('[data-action=apply-audit-filters]').click();
 const row=page.locator('tr').filter({has:page.locator('strong').filter({hasText:/^boss\.approval\.approved$/})});await row.waitFor();
 assert.match(await row.textContent(),/148254.53/);assert.match(await row.textContent(),/Jason Pu/);assert.match(await row.textContent(),/37021.83/);
 assert.equal(await row.locator('img').count(),0);assert.equal(await page.evaluate(()=>window.auditInjected),undefined);assert.equal(JSON.parse(await row.locator('pre').textContent()).snapshot.customerName,evil);
 await page.screenshot({path:`${directory}/admin-audit.png`,fullPage:true});await close(page,context,'audit');
});

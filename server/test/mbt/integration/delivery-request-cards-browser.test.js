/* global document, getComputedStyle */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import {chromium} from '@playwright/test';
import {cargoFunctions} from '../../support/sales-order-cargo-fixture.mjs';

const empty=()=>'';
const dependencies={
  shortageQty:()=>0,hasUsableDispatchAddress:()=>true,transitBlockMessage:empty,
  orderAssignment:()=>({}),isOrderPlannedOutsideCurrentPlan:()=>false,
  isScmReconciliationBlocked:()=>false,isReviewOnlyOrder:()=>false,packedUnitText:empty,
  orderExecutionStatus:()=> 'pending',orderPlannedElsewhereText:empty,poSourceReferenceText:empty,
  selectedOrderIds:new Set(),escapeHtml:value=>String(value || ''),movementText:()=> 'Delivery',
  orderPickupText:()=> '3445',orderUnitText:()=> '10 pallets',orderFootprintPallets:()=>10,
  formatLbs:()=> '1000 lbs',orderWeightLbs:()=>1000,isSalesOrderReattempt:()=>false,
  reviewOnlyText:empty,canConsolidatePick:()=>false,scmReconciliationBlockText:empty,displayDate:value=>value
};
const {renderOrderCard}=cargoFunctions('../../public/dispatch.js',[
  'renderOrderCard','isDispatchPlanningRestricted','dispatchPlanningRestrictionText'
],dependencies);
test('linkage: secured planning cards show yellow, green and explicit Secured without changing restrictions',async()=>{
  const order={id:'SOB122368',customer:'Delivery customer',type:'SO',pallets:10,
    deliveryApprovalPriority:true,expectedDeliveryDate:'2026-10-10',windowStart:'08:00',windowEnd:'09:00'};
  const secured=renderOrderCard(order),ordinary=renderOrderCard({...order,id:'SO-ORDINARY',deliveryApprovalPriority:false});
  assert.match(secured,/<span[^>]*>Secured<\/span>/);
  assert.match(secured,/08:00-09:00/);assert.match(secured,/draggable="true"/);
  assert.doesNotMatch(ordinary,/>Secured</);
  const restricted=renderOrderCard({...order,id:'SO-RESTRICTED',dispatchPlanningRestricted:true});
  assert.match(restricted,/draggable="false"/);assert.match(restricted,/Planning restricted/);
  const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  try {
    const page=await browser.newPage({viewport:{width:800,height:700}});
    await page.setContent(`<main style="width:340px;display:grid;gap:16px">${secured}${ordinary}${restricted}</main>`);
    await page.addStyleTag({content:await fs.readFile(new URL('../../../public/dispatch.css',import.meta.url),'utf8')});
    const styles=await page.evaluate(()=>{
      const card=document.querySelector('[data-order="SOB122368"]');
      return {background:getComputedStyle(card).backgroundColor,text:getComputedStyle(card).color,
        span:getComputedStyle(card.querySelector('.order-compact-line')).color};
    });
    assert.deepEqual(styles,{background:'rgb(254, 249, 195)',text:'rgb(22, 101, 52)',span:'rgb(22, 101, 52)'});
    await page.screenshot({path:'test-artifacts/delivery-requests-ui/secured-planning-cards.png',fullPage:true});
  } finally {await browser.close();}
});

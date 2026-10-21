import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import {projectDirectTransferResidual} from "../../../src/dispatch-to-route-projection.js";

const source=await readFile(new URL("../../../public/dispatch.js",import.meta.url),"utf8");
// These browser declarations are evaluated unchanged; unrelated DOM startup is omitted.
function declaration(name) {
  const start=source.indexOf(`function ${name}(`);
  assert.ok(start>=0,name);
  const next=source.indexOf("\nfunction ",start+1);
  return source.slice(start,next<0?source.length:next);
}
const names=["poRouteProjectionForOrder","routeItemsForOrder","routeDropoffsForOrder","orderWeightLbs",
  "dropoffForStop","dropItemsForStop","routeDropQuantity","groupPickupSourceItems", "tooltipItemsForOrder",
  "isOperationalDispatchItem","isMbbsSpecialLinkLine","itemHasQuantity"];
const browser=vm.runInNewContext(`${names.map(declaration).join("\n")}\n({${names.join(",")}})`);

test("Dispatch shows the same exact TO remainder at pickup and drop despite stale stop totals",()=>{
  const order=projectDirectTransferResidual({id:"TO-UI",type:"TO",items:[{itemId:42,quantity:20,pallets:2,toPlt:10,toPcs:1,lineWeight:40}]},
    {mode:"direct_to_customer",status:"active",salesOrderRef:"SO-UI",lines:[{itemId:42,allocatedQuantity:19}]});
  assert.equal(browser.poRouteProjectionForOrder(order),order.toRouteProjection);
  assert.equal(browser.tooltipItemsForOrder(order,{pickupLocation:"2967"})[0].pieces,1);
  assert.equal(browser.tooltipItemsForOrder(order,{stop:{type:"drop"}})[0].pieces,1);
  assert.equal(browser.routeDropQuantity(order,{dropPieces:20},"pieces"),1);
  assert.equal(browser.routeDropQuantity(order,{dropPallets:2},"pallets"),0);
  assert.equal(browser.orderWeightLbs(order),2);
  assert.equal(order.items[0].quantity,20);
});

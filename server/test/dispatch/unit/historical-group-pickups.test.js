import assert from "node:assert/strict";
import test from "node:test";
import { dispatchRequiredPickupVisitLocations,materializeDispatchPickupVisits } from "../../../src/dispatch-pickup-visits.js";

function groupedPlan() {
  const items = [{itemId: 1,pallets: 1,quantity: 1}];
  const grouped = {id: "GO-HISTORY",type: "SO",sourceYard: "3445",pickupLocations: ["3445"],items,
    childOrders: ["SO-A","SO-B"],childOrderDetails: [
      {id: "SO-A",type: "SO",sourceYard: "3445",pickupLocations: ["3445"],items},
      {id: "SO-B",type: "SO",sourceYard: "12441",pickupLocations: ["12441"],items,
        transitCo: {id: "CO-SO-B",fromYard: "3445",toYard: "12441",status: "pending_load"}}]};
  return {orders: [grouped],trucks: [{id: "truck",loads: [{id: "load",pickupVisitSchemaVersion: 1,stops: [
    {id: "pick-a",type: "pick",location: "3445",orderRefs: [grouped.id]},
    {id: "pick-b",type: "pick",location: "12441",orderRefs: [grouped.id]},
    {id: "drop",type: "drop",orderId: grouped.id}]}]}]};
}

test("group pickup validation includes the effective transit pickup of each child",() => {
  const plan = groupedPlan();
  assert.deepEqual(materializeDispatchPickupVisits(plan,{allowLegacyPassthrough: true}).conflicts,[]);
  assert.deepEqual(dispatchRequiredPickupVisitLocations(plan.orders[0],plan).sort(),["12441","3445"]);
});

test("removing a grouped child's transit pickup is still rejected",() => {
  const plan = groupedPlan();
  plan.trucks[0].loads[0].stops.splice(1,1);
  assert.ok(materializeDispatchPickupVisits(plan,{allowLegacyPassthrough: true}).conflicts
    .some(conflict => conflict.code === "DISPATCH_PICKUP_ORDER_MISSING" && conflict.location === "12441"));
});

test("group child pickup support still rejects a yard belonging to no child",() => {
  const plan = groupedPlan();
  plan.trucks[0].loads[0].stops[1].location = "2967";
  assert.ok(materializeDispatchPickupVisits(plan,{allowLegacyPassthrough: true}).conflicts
    .some(conflict => conflict.code === "DISPATCH_PICKUP_ORDER_WRONG_YARD"));
});

test("a whole-group transit CO and a CO manifest retain their own pickup authority",() => {
  const plan = groupedPlan();
  const group = plan.orders[0];
  group.sourceYard = "150"; group.pickupLocations = ["150"];
  group.transitCo = {id: "CO-GROUP",fromYard: "3445",toYard: "150",status: "pending_load"};
  assert.deepEqual(dispatchRequiredPickupVisitLocations(group,plan),["150"]);
  const co = {...group,id: "CO-GROUP",type: "CO",sourceTable: "local_co_orders",transitCo: null};
  assert.deepEqual(dispatchRequiredPickupVisitLocations(co,plan),["150"]);
});

test("a cancelled parent PO allocation cannot be revived by a stale vendor pickup on a child",() => {
  const plan = groupedPlan();
  const group = plan.orders[0];
  group.sourceYard = "2967"; group.pickupLocations = ["2967"]; group.poPickupManifest = [];
  group.childOrders = ["SO-A"];
  group.childOrderDetails = [{id: "SO-A",type: "SO",sourceYard: "2967",pickupLocations: ["2967","Old Vendor"],
    poPickupManifest: [{location: "Old Vendor",items: group.items}],items: group.items}];
  assert.deepEqual(dispatchRequiredPickupVisitLocations(group,plan),["2967"]);
});

import { readFileSync } from "node:fs";

const vendors = [
  ["Ayr Yard - Unilock", "2977 Cedar Creek Rd RR#1, Ayr, ON N0B 1E0"],
  ["141 Shearson Crescent, Cambridge, ON N1T 1J3", "141 Shearson Crescent, Cambridge, ON N1T 1J3"],
  ["UNILOCK Georgetown", "287 Armstrong Ave, Georgetown, ON L7G 4X6"]
];
const refs = ["SN1400163", "P/U#87272150", "SN1400295"];
const orders = refs.map((id, index) => ({
  id, type: "PO", customer: "Isolated vendor replay", sourceYard: vendors[index][0],
  sourceAddress: vendors[index][1], pickupLocations: [vendors[index][0]],
  destinationYard: index === 2 ? "2967" : "3445", destinationLocationId: index === 2 ? 28 : 1,
  address: `${index === 2 ? "2967" : "3445"} Kennedy Road, Toronto, ON`,
  pallets: index === 0 ? 29 : 1, weight: index === 0 ? 75170 : 2520,
  items: [{ sku: `REPLAY-${index}`, itemName: "Isolated test material", quantity: 1, unit: "PALLET", pallets: 1, itemWeight: 2520 }],
  localDispatchStatus: "planned"
}));
const loadId = "T7-L1789077207961-8f67e84a19845";
const stops = [
  ...refs.map((orderId, index) => ({ id: `replay-pick-${index}`, type: "pick", orderId, loadId, location: vendors[index][0] })),
  ...[2, 0, 1].map((index) => ({
    id: `replay-drop-${index}`, type: "drop", orderId: refs[index], loadId,
    location: vendors[index][0], dropLocation: orders[index].destinationYard,
    dropAddress: orders[index].address, destinationLocationId: orders[index].destinationLocationId
  }))
];

export const ce94489Replay = {
  readOnly: true,
  plan: {
    id: 323, planDate: "2026-09-11", status: "confirmed", revision: 19, orders,
    summary: { driverLaneOrder: ["sety"], ownYardCodes: ["3445", "2967", "12441", "150"] },
    trucks: [{
      id: "T7", plate: "CE94489", base: "3445", driver: "Sety", driverLogin: "sety", license: "AZ", capacityLbs: 83000,
      travelTimePercent: 30, ownYardFixedMinutes: 30, vendorFixedMinutes: 60, deliveryFixedMinutes: 10, minutesPerPallet: 1,
      loads: [{ id: loadId, name: "Load 1", start: "06:30", startMode: "fixed", driverLogin: "sety", driverName: "Sety", truckId: "T7", truckPlate: "CE94489", stops }]
    }]
  },
  vendorYards: vendors.map(([yard, address]) => ({ yard, address, vendor: "Replay vendor", active: true }))
};

export function datedDriverReplay() {
  const file = process.env.DRIVER_REPLAY_PLAN_FILE;
  const replay = file ? JSON.parse(readFileSync(file, "utf8")) : structuredClone(ce94489Replay);
  if (replay.readOnly !== true || replay.plan?.planDate !== "2026-09-11") {
    throw new Error("Expected the read-only 2026-09-11 plan export");
  }
  return replay;
}

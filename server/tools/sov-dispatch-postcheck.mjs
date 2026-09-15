import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { query, closeDb } from "../src/db.js";
import { listDispatchOrders } from "../src/dispatch-repository.js";
import { dispatchRequiredPickupLocations } from "../src/dispatch-load-assignment.js";

const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
try {
  const setup = JSON.parse(await fs.readFile("/app/data/dispatch-setup.json", "utf8"));
  const plans = (await query(`SELECT p.id::text,p.revision,
    md5(s.orders::text) AS orders,md5(s.trucks::text) AS trucks
    FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id
    WHERE s.orders::text ~* 'SOV[0-9]' ORDER BY p.id`)).rows;
  const activity = (await query(`SELECT id::text,job_id,status,load_id,stop_id,md5(to_jsonb(j)::text) AS digest
    FROM driver_job_records j WHERE order_refs::text ~* 'SOV[0-9]' ORDER BY id`)).rows;
  const orders = await listDispatchOrders({ type: "SO", exactOrderRefs: ["SOV02345", "SOV02333"] });
  const projected = orders.map(order => ({ ref: order.id, source: order.sourceYard,
    pickups: dispatchRequiredPickupLocations({}, order), lines: order.items?.length || 0 }));
  const witness = { plans, activity, projected, ownYards: setup.ownYards.map(yard => yard.code) };
  if (args.includes("--expect-195")) {
    assert.deepEqual(setup.ownYards.filter(yard => String(yard.code) === "195").map(yard => [yard.locationId, yard.address]),
      [[4, "195 Milner Ave Unit 5, Scarborough, ON M1S 4P4"]]);
    for (const order of projected) {
      assert.deepEqual(order.pickups, ["195"]);
    }
    assert.equal((await query("SELECT count(*) FROM sales_orders WHERE tranid='SOV02222'")).rows[0].count, "0");
  }
  if (args.includes("--compare")) {
    const before = JSON.parse(await fs.readFile(option("--compare"), "utf8"));
    assert.deepEqual(plans, before.plans, "Saved SOV plans changed during rollout");
    assert.deepEqual(activity, before.activity, "Recorded SOV driver work changed during rollout");
  }
  if (args.includes("--output")) {
    await fs.writeFile(option("--output"), JSON.stringify(witness, null, 2), { flag: "wx", mode: 0o600 });
  }
  process.stdout.write(`${JSON.stringify({ ownYards: witness.ownYards, projected,
    savedPlans: plans.length, recordedJobs: activity.length, compared: args.includes("--compare") })}\n`);
} finally {
  await closeDb();
}

import { closeDb } from "./db.js";
import { rebuildDispatchDeliveryGroups } from "./dispatch-delivery-group-repository.js";

try {
  const result = await rebuildDispatchDeliveryGroups();
  console.log(`Rebuilt delivery groups from ${result.plans} plans: ${result.groups} groups, ${result.members} members.`);
} finally {
  await closeDb();
}

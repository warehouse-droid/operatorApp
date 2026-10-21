import { readFile } from "node:fs/promises";
import { buildExecutedOrderReviews, executedChangeMessage } from "../src/dispatch-executed-order-review.js";

const capture = JSON.parse(await readFile(process.argv[2], "utf8"));
const reviews = buildExecutedOrderReviews(capture);
console.log(JSON.stringify({ revision: capture.previousPlan.revision, reviewCount: reviews.length,
  reviews: reviews.map(review => ({ orderRef: review.orderRef, groupRef: review.groupRef,
    changes: review.changes.map(executedChangeMessage) })) }, null, 2));

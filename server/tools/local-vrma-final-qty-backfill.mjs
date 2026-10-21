// Run from the server root, or pass this file to `node --input-type=module` in /app.
import { pathToFileURL } from "node:url";
import path from "node:path";

const { finalizeLegacyVrmaShortLoads } = await import(pathToFileURL(path.resolve("src/delivery-repository.js")).href);
const { closeDb } = await import(pathToFileURL(path.resolve("src/db.js")).href);
const arguments_ = process.argv.slice(2);
const dryRun = !arguments_.includes("--apply");
const orderRefs = arguments_.filter(value => value !== "--apply");
try {
  if (orderRefs.some(value => value.startsWith("--"))) { throw new Error("Unknown maintenance option."); }
  const orders = await finalizeLegacyVrmaShortLoads({ orderRefs, dryRun });
  console.log(JSON.stringify({ dryRun, orders }, null, 2));
} finally { await closeDb(); }

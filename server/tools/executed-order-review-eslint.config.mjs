import base from "../eslint.mbt.config.js";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("./executed-order-review-files.json", import.meta.url), "utf8"));
const globals = Object.fromEntries([
  "globalThis", "window", "document", "localStorage", "sessionStorage", "navigator", "location", "history", "alert", "confirm",
  "HTMLElement", "HTMLDetailsElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "Element", "Node", "MutationObserver", "requestAnimationFrame",
  "orders", "normalizeOrder", "orderCatalog", "trucks", "fleet", "currentPlanDate", "todayLocalDate", "currentPlan", "dispatchConfig",
  "dispatchSetupLoaded", "dispatchPlannerSnapshotState", "planEditMode", "planEditLeaseToken", "planEditLease", "dispatchSessionId", "localPlanDirty",
  "render", "loadExecutedOrderReviews", "renderDispatchNoticePatch", "saveCurrentPlanNow", "mergeFreshDispatchOperationalOrder"
].map(name => [name, "readonly"]));
export default [{ ...base[1], files: [...manifest.production, ...manifest.tests].filter(file => /\.(js|mjs)$/u.test(file)).concat("tools/executed-order-review*.mjs"),
  languageOptions: { ...base[1].languageOptions, globals: { ...base[1].languageOptions.globals, ...globals } } }];

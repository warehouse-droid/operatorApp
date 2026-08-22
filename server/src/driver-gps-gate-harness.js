import assert from "node:assert/strict";
import fs from "node:fs";

const driverSource = fs.readFileSync(new URL("../public/driver.js", import.meta.url), "utf8");
const serverSource = fs.readFileSync(new URL("./server.js", import.meta.url), "utf8");
const offlineServiceSource = fs.readFileSync(
  new URL("./driver-offline-service.js", import.meta.url),
  "utf8"
);

assert(
  /function locationCheckApproved\(\)[\s\S]{0,220}locationCheck\?\.status === "ok"[\s\S]{0,120}locationCheck\?\.status === "not_checked_offline"[\s\S]{0,120}locationOverrideAccepted/.test(driverSource),
  "GPS approval must require an OK result, a genuine offline marker, or an explicit override."
);
assert(
  !/function locationCheckApproved\(\)[\s\S]{0,160}driverUsesSamsaraWorkflow\(\)/.test(driverSource),
  "The per-driver Samsara write-workflow setting must not bypass the frontend GPS gate."
);
assert(
  /function locationCheckBlocksConfirmation\(\) \{[\s\S]{0,100}return !locationCheckApproved\(\)/.test(driverSource),
  "An in-progress stop reopened without a current GPS result must keep Confirm disabled."
);

const showPhotoHandler = driverSource.match(/if \(action === "show-photo"\) \{([\s\S]*?)\n  \}/)?.[1] || "";
assert(showPhotoHandler, "Show-photo handler must exist.");
assert(
  showPhotoHandler.indexOf("await ensureLocationApprovalBeforeConfirmation()") >= 0
    && showPhotoHandler.indexOf("await ensureLocationApprovalBeforeConfirmation()") < showPhotoHandler.indexOf("photoPromptOpen = true"),
  "GPS approval must run before the photo popup opens."
);

const overrideHandlerStart = driverSource.indexOf('if (action === "override-location")');
const overrideHandlerEnd = driverSource.indexOf('if (action === "start-rest")', overrideHandlerStart);
const overrideHandler = driverSource.slice(overrideHandlerStart, overrideHandlerEnd);
assert(overrideHandlerStart >= 0 && overrideHandlerEnd > overrideHandlerStart, "Location override handler must exist.");
assert(
  overrideHandler.indexOf("ensureAuthoritativeJobBeforeAction(overrideJob)")
    < overrideHandler.indexOf("locationOverrideAccepted = true"),
  "Location override must revalidate the live job before accepting the explicit bypass."
);
assert(
  overrideHandler.indexOf("locationOverrideAccepted = true")
    < overrideHandler.indexOf('photoPromptOpen = true'),
  "The explicit location override must be accepted before the photo screen opens."
);
assert(
  driverSource.includes('data-action="override-location"')
    && driverSource.includes('t("driver.overrideContinue", "Override & Continue")'),
  "A GPS warning must expose an unmistakable Override & Continue action."
);

assert(
  driverSource.includes('data-action="complete-job" data-job-confirm data-gps-gate="complete"')
    && driverSource.includes("canCompleteCurrentJob(job)"),
  "The photo popup completion button must retain the GPS approval gate."
);
const photoModalStart = driverSource.indexOf("function renderPhotoSlots(job)");
const photoModalEnd = driverSource.indexOf("function renderDriverDependencyWarnings(job)", photoModalStart);
const photoModalSource = driverSource.slice(photoModalStart, photoModalEnd);
assert(
  photoModalSource.includes("renderLocationCheck(job)")
    && photoModalSource.includes("driver.locationRequiredBeforeComplete")
    && photoModalSource.includes("driver.requiredPhotosRemaining"),
  "The photo modal must show the GPS actions and every reason Complete Stop is disabled."
);

const completeHandler = driverSource.match(/if \(action === "complete-job" && currentJob\) \{([\s\S]*?)\r?\n  \}\r?\n\}\);/)?.[1] || "";
assert(completeHandler.includes("await ensureLocationApprovalBeforeConfirmation()"), "Final completion must reassert frontend GPS approval.");
assert(
  completeHandler.indexOf("await ensureLocationApprovalBeforeConfirmation()") < completeHandler.indexOf("uploadDriverPhotos"),
  "No stop photos may upload before frontend GPS approval."
);

const completionRoute = serverSource.match(/app\.post\("\/api\/driver\/jobs\/:jobId\/photos"[\s\S]*?\n\}\);/)?.[0] || "";
assert(completionRoute, "Driver photo completion endpoint must exist.");
assert(
  completionRoute.indexOf("checkDriverJobLocation(job)") < completionRoute.indexOf("completeDriverJobOperationalEffects"),
  "The server must keep its GPS check before committing stop completion."
);
const completionEffectsStart = serverSource.indexOf("async function completeDriverJobOperationalEffects");
const completionEffectsEnd = serverSource.indexOf("async function applyDriverOfflineEvent", completionEffectsStart);
const completionEffects = completionEffectsStart >= 0 && completionEffectsEnd > completionEffectsStart
  ? serverSource.slice(completionEffectsStart, completionEffectsEnd)
  : "";
assert(
  completionEffects.includes("recordDriverJobPhotos"),
  "The shared completion function must durably record the required stop photos."
);
assert(
  completionEffects.includes("completeYardDependenciesForTransferDrop"),
  "The shared online/offline completion function must record physical yard-replenishment deliveries."
);

const offlineApplyStart = serverSource.indexOf("async function applyDriverOfflineEvent");
const offlineCompletionBranch = serverSource.indexOf(
  'if (event.eventType === "job_completed")',
  offlineApplyStart
);
const offlineStartBranch = offlineApplyStart >= 0 && offlineCompletionBranch > offlineApplyStart
  ? serverSource.slice(offlineApplyStart, offlineCompletionBranch)
  : "";
assert(
  offlineStartBranch.indexOf("reconcileCompletedYardTransfersForSalesOrderStart")
    < offlineStartBranch.indexOf("getSalesOrderDependencyExecutionBlock"),
  "Offline job start must reconcile an earlier physical TO drop before enforcing the Sales Order dependency gate."
);

const onlineStartRoute = serverSource.match(
  /app\.post\("\/api\/driver\/jobs\/:jobId\/start"[\s\S]*?\n\}\);/
)?.[0] || "";
assert(onlineStartRoute, "Driver start endpoint must exist.");
assert(
  onlineStartRoute.indexOf("reconcileCompletedYardTransfersForSalesOrderStart")
    < onlineStartRoute.indexOf("getSalesOrderDependencyExecutionBlock"),
  "Online job start must reconcile an earlier physical TO drop before enforcing the Sales Order dependency gate."
);
assert(
  offlineServiceSource.includes("routeJobs: currentPlan.jobs || []"),
  "Normal offline application must pass the locked current route into dependency recovery."
);
const reviewResolutionStart = serverSource.indexOf(
  "async function applyDriverOfflineReviewResolution"
);
const reviewResolutionEnd = serverSource.indexOf(
  "function emitAppEvent",
  reviewResolutionStart
);
const reviewResolution = reviewResolutionStart >= 0 && reviewResolutionEnd > reviewResolutionStart
  ? serverSource.slice(reviewResolutionStart, reviewResolutionEnd)
  : "";
assert(
  reviewResolution.includes("routeJobs: currentPlan.jobs || []"),
  "Dispatch Apply Original/reattach must pass the current route into dependency recovery."
);
assert(
  !completionRoute.includes("driverSamsaraWorkflowEnabled(req.driver)")
    && !completionRoute.includes("driverLocationCheckNotRequired(job)"),
  "The per-driver Samsara write-workflow setting must not bypass the server GPS gate."
);

console.log("Driver GPS-before-photo gate harness passed.");

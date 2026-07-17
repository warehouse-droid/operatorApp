import assert from "node:assert/strict";
import fs from "node:fs";

const driverSource = fs.readFileSync(new URL("../public/driver.js", import.meta.url), "utf8");
const serverSource = fs.readFileSync(new URL("./server.js", import.meta.url), "utf8");

assert(
  /function locationCheckApproved\(\)[\s\S]{0,160}locationCheck\?\.status === "ok" \|\| locationOverrideAccepted/.test(driverSource),
  "GPS approval must require an OK result or an explicit override."
);

const showPhotoHandler = driverSource.match(/if \(action === "show-photo"\) \{([\s\S]*?)\n  \}/)?.[1] || "";
assert(showPhotoHandler, "Show-photo handler must exist.");
assert(
  showPhotoHandler.indexOf("await ensureLocationApprovalBeforeConfirmation()") >= 0
    && showPhotoHandler.indexOf("await ensureLocationApprovalBeforeConfirmation()") < showPhotoHandler.indexOf("photoPromptOpen = true"),
  "GPS approval must run before the photo popup opens."
);

assert(
  driverSource.includes('data-action="complete-job" data-job-confirm data-gps-gate="complete"')
    && driverSource.includes("canCompleteCurrentJob(job)"),
  "The photo popup completion button must retain the GPS approval gate."
);

const completeHandler = driverSource.match(/if \(action === "complete-job" && currentJob\) \{([\s\S]*?)\n  \}\n\}\);/)?.[1] || "";
assert(completeHandler.includes("await ensureLocationApprovalBeforeConfirmation()"), "Final completion must reassert frontend GPS approval.");
assert(
  completeHandler.indexOf("await ensureLocationApprovalBeforeConfirmation()") < completeHandler.indexOf("uploadDriverPhotos"),
  "No stop photos may upload before frontend GPS approval."
);

const completionRoute = serverSource.match(/app\.post\("\/api\/driver\/jobs\/:jobId\/photos"[\s\S]*?\n\}\);/)?.[0] || "";
assert(completionRoute, "Driver photo completion endpoint must exist.");
assert(
  completionRoute.indexOf("checkDriverJobLocation(job)") < completionRoute.indexOf("recordDriverJobPhotos"),
  "The server must keep its GPS check before committing stop completion."
);

console.log("Driver GPS-before-photo gate harness passed.");

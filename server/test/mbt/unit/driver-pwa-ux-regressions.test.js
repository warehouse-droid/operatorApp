import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (relativePath) => fs.readFileSync(
  new URL(`../../../${relativePath}`, import.meta.url),
  "utf8"
);

const driverSource = read("public/driver.js");
const driverCss = read("public/driver.css");
const driverHtml = read("public/driver.html");
const workerSource = read("public/driver-service-worker.js");
const serverSource = read("src/server.js");
const translationMigration = read("migrations/169_delivery_instruction_translation_cache.sql");
const matchText = (source, pattern) => (source.match(pattern) || [""])[0];

test("Personal History keeps its Back control inside narrow and text-scaled viewports", () => {
  assert.match(driverSource, /class="secondary compact history-back-button" data-action="back-job"/u);
  assert.match(driverSource, /class="history-controls"/u);
  const driverAppRule = matchText(driverCss, /#driverApp\s*\{[^}]+\}/u);
  assert.match(driverAppRule, /height:\s*100svh;/u);
  assert.match(driverAppRule, /padding:\s*var\(--driver-safe-top\)\s+0\s+var\(--driver-safe-bottom\);/u);
  assert.match(driverAppRule, /overflow:\s*hidden;/u);
  assert.match(driverAppRule, /overflow:\s*clip;/u);
  const driverShellRule = matchText(driverCss, /\.driver-shell\s*\{[^}]+\}/u);
  assert.match(driverShellRule, /height:\s*100%;/u);
  assert.match(driverShellRule, /min-height:\s*0;/u);
  assert.match(driverShellRule, /overflow:\s*hidden;/u);
  const driverContentRule = matchText(driverCss, /\.driver-content\s*\{[^}]+\}/u);
  assert.match(driverContentRule, /width:\s*100%;/u);
  assert.match(driverContentRule, /min-width:\s*0;/u);
  assert.match(driverContentRule, /grid-template-columns:\s*minmax\(0,\s*1fr\);/u);
  assert.match(driverContentRule, /overflow-x:\s*hidden;/u);
  assert.match(driverContentRule, /min-height:\s*0;/u);
  const historyPanelRule = matchText(driverCss, /\.history-panel\s*\{[^}]+\}/u);
  assert.match(historyPanelRule, /min-width:\s*0;/u);
  assert.match(historyPanelRule, /grid-template-columns:\s*minmax\(0,\s*1fr\);/u);
  const historyFilterRule = matchText(driverCss, /\.history-filter\s*\{[^}]+\}/u);
  assert.match(historyFilterRule, /min-width:\s*0;/u);
  assert.match(historyFilterRule, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto;/u);
  const historyHeadRule = matchText(driverCss, /\.history-head\s*\{[^}]+\}/u);
  assert.match(historyHeadRule, /display:\s*grid;/u);
  assert.match(historyHeadRule, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto;/u);
  assert.match(historyHeadRule, /max-width:\s*100%;/u);
  assert.match(historyHeadRule, /overflow:\s*hidden;/u);
  const historyControlsRule = matchText(driverCss, /\.history-controls\s*\{[^}]+\}/u);
  assert.match(historyControlsRule, /position:\s*sticky;/u);
  assert.match(historyControlsRule, /top:\s*46px;/u);
  assert.match(historyControlsRule, /grid-template-columns:\s*minmax\(0,\s*1fr\);/u);
  assert.match(historyControlsRule, /background:\s*var\(--paper\);/u);
  assert.match(driverCss, /\.driver-top-chrome\s*\{[\s\S]*?z-index:\s*19;[\s\S]*?background:\s*var\(--paper\);/u);
  assert.match(driverSource, /class="driver-bottom-chrome" aria-hidden="true"/u);
  assert.match(driverCss, /\.driver-bottom-chrome\s*\{[\s\S]*?z-index:\s*24;[\s\S]*?height:\s*var\(--driver-safe-bottom\);[\s\S]*?background:\s*var\(--paper\);/u);
  assert.match(driverCss, /\.history-head\s*>\s*div\s*\{[\s\S]*?min-width:\s*0;/u);
  assert.match(driverCss, /\.history-back-button\s*\{[\s\S]*?position:\s*static;[\s\S]*?justify-self:\s*end;/u);
  assert.match(
    driverCss,
    /@media\s*\(max-width:\s*360px\)[\s\S]*?\.history-head[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);[\s\S]*?\.history-back-button[\s\S]*?width:\s*100%;/u
  );
  assert.match(
    driverSource,
    /if \(action === "back-job"\) \{[\s\S]*?renderCachedDriverWorkView\(\);[\s\S]*?void loadNextJob\(\)\.catch/u
  );
  const noJobRenderer = matchText(driverSource, /function renderNoJob\(\)[\s\S]*?\n\}/u);
  assert.doesNotMatch(noJobRenderer, /prepareDeliveryInstructionMedia\(job\)/u);
});

test("the sticky Driver action bar seals the content gutter above the bottom safe area", () => {
  const driverAppRule = matchText(driverCss, /#driverApp\s*\{[^}]+\}/u);
  const driverContentRule = matchText(driverCss, /\.driver-content\s*\{[^}]+\}/u);
  const jobActionsRule = matchText(driverCss, /\.job-actions\s*\{[^}]+\}/u);

  assert.match(driverAppRule, /--driver-content-gutter:\s*12px;/u);
  assert.match(driverContentRule, /padding:\s*var\(--driver-content-gutter\);/u);
  assert.match(jobActionsRule, /position:\s*sticky;/u);
  assert.match(jobActionsRule, /bottom:\s*calc\(0px\s*-\s*var\(--driver-content-gutter\)\);/u);
  assert.match(jobActionsRule, /margin:\s*0\s+-14px\s+calc\(-16px\s*-\s*var\(--driver-content-gutter\)\);/u);
  assert.match(jobActionsRule, /padding:\s*6px\s+14px\s+calc\(10px\s*\+\s*var\(--driver-content-gutter\)\);/u);
  assert.match(jobActionsRule, /background:\s*white;/u);
});

test("an ended rest tombstone rejects only the same stale rest returned by Refresh", () => {
  const policyStart = driverSource.indexOf("function driverRestMarker(rest)");
  const policyEnd = driverSource.indexOf("function elapsedSeconds(startedAt)", policyStart);
  assert.ok(policyStart >= 0 && policyEnd > policyStart, "rest refresh policy must be extractable");
  const policySource = driverSource.slice(policyStart, policyEnd);
  const policy = Function(`
    let endedRestMarker = null;
    let activeRest = null;
    let restTimer = 1;
    function clearRestTimer() { restTimer = null; }
    ${policySource}
    return {
      acceptDriverRestCandidate,
      markDriverRestEnded,
      setActiveRest(value) { activeRest = value; },
      getActiveRest() { return activeRest; },
      getRestTimer() { return restTimer; }
    };
  `)();
  const ended = {
    restId: "rest-a",
    startedAt: "2026-08-19T10:00:00.000Z",
    status: "active"
  };
  const next = {
    restId: "rest-b",
    startedAt: "2026-08-19T11:00:00.000Z",
    status: "active"
  };

  assert.equal(policy.acceptDriverRestCandidate(ended), ended);
  policy.setActiveRest(ended);
  policy.markDriverRestEnded(ended);
  assert.equal(policy.getActiveRest(), null);
  assert.equal(policy.getRestTimer(), null);
  assert.equal(policy.acceptDriverRestCandidate({ ...ended }), null);
  assert.equal(policy.acceptDriverRestCandidate(next), next);

  assert.match(driverSource, /activeRest\s*=\s*acceptDriverRestCandidate\(result\.rest\);/u);
  assert.match(driverSource, /if \(action === "end-rest"\)[\s\S]*?markDriverRestEnded\(result\.rest \|\| endingRest\);/u);
  assert.doesNotMatch(driverSource, /activeRest\s*=\s*result\.rest\s*;/u);
});

test("a location override belongs to one stop and survives only same-stop refreshes", () => {
  const policySource = read("public/driver-location-override.js");
  const browser = {};
  Function("window", policySource)(browser);
  const approval = browser.DriverLocationOverridePolicy.create();

  const current = { jobId: "PLAN:TRUCK:LOAD:STOP-1" };
  const refreshed = { jobId: "PLAN:TRUCK:LOAD:STOP-1", revision: 9 };
  const next = { jobId: "PLAN:TRUCK:LOAD:STOP-2" };

  assert.equal(approval.accept(current), true);
  assert.equal(approval.isAccepted(refreshed), true);
  assert.equal(approval.reconcile(refreshed), true);
  assert.equal(approval.isAccepted(refreshed), true);
  assert.equal(approval.reconcile(next), false);
  assert.equal(approval.isAccepted(current), false);
  assert.equal(approval.accept(next), true);
  approval.clear();
  assert.equal(approval.isAccepted(next), false);

  assert.match(driverSource, /locationOverrideApproval\.reconcile\(currentJob\)/u);
  assert.match(driverSource, /locationOverrideApproval\.isAccepted\(currentJob\)/u);
  assert.doesNotMatch(driverSource, /let locationOverrideAccepted\s*=/u);
  const overrideAction = matchText(
    driverSource,
    /if \(action === "override-location"\) \{[\s\S]*?\n  \}\n  if \(action === "start-rest"\)/u
  );
  assert.match(overrideAction, /locationOverrideApproval\.accept\(currentJob\)/u);
  assert.doesNotMatch(overrideAction, /photoPromptOpen\s*=\s*true/u);
  assert.doesNotMatch(overrideAction, /restoreDraftPhotos/u);
});

test("the updated override policy is atomically included in the Driver PWA shell", () => {
  const assetVersion = "20260819-driver-route-readiness-v1";
  assert.ok(driverHtml.includes(`/driver-location-override.js?v=${assetVersion}`));
  assert.ok(workerSource.includes(`/driver-location-override.js?v=${assetVersion}`));
  assert.match(workerSource, /DRIVER_CACHE_NAME = `\$\{DRIVER_CACHE_PREFIX\}v38`/u);
  assert.match(driverSource, /driver-service-worker\.js\?v=20260819-driver-route-readiness-v1/u);
});

test("delivery instruction text follows the selected language with source fallback", () => {
  assert.match(driverSource, /function localizedDeliveryInstructionText\(/u);
  assert.match(driverSource, /order\?\.localized\?\.language === language/u);
  assert.match(driverSource, /return localizedText \|\| sourceText/u);
  assert.match(driverSource, /prepareCurrentDeliveryInstructionLanguage/u);
  assert.match(driverSource, /searchParams\.set\("language", language\)/u);
  assert.match(
    driverSource,
    /mbbs-language-changed[\s\S]*?prepareCurrentDeliveryInstructionLanguage\(\{ force: true, announce: true \}\)/u
  );
  assert.match(
    serverSource,
    /\/api\/driver\/jobs\/:jobId\/delivery-instructions[\s\S]*?localizeDeliveryInstructionSet/u
  );
  assert.match(translationMigration, /CREATE TABLE IF NOT EXISTS delivery_instruction_translation_cache/u);
});

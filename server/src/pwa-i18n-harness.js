import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const publicUrl = new URL("../public/", import.meta.url);
const readPublic = (name) => fs.readFileSync(new URL(name, publicUrl), "utf8");
const i18nSource = readPublic("i18n.js");
const operatorSource = readPublic("operator.js");
const driverSource = readPublic("driver.js");
const driverHtml = readPublic("driver.html");
const driverOfflineSources = [
  ["driver-offline-db.js", readPublic("driver-offline-db.js")],
  ["driver-offline-sync.js", readPublic("driver-offline-sync.js")],
  ["driver-offline-photos.js", readPublic("driver-offline-photos.js")]
];
const frontendSources = [operatorSource, driverSource];

function sourceSection(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `Could not isolate ${start}.`);
  return source.slice(startIndex, endIndex);
}

function decodedJsString(value) {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value;
  }
}

function unique(values) {
  return [...new Set(values)];
}

const stored = new Map([["mbbs.ui.language", "zh-CN"]]);
const context = {
  localStorage: {
    getItem: (key) => stored.get(key) || null,
    setItem: (key, value) => stored.set(key, value)
  },
  document: {
    documentElement: {},
    addEventListener() {}
  },
  window: {
    dispatchEvent() {}
  },
  CustomEvent: class CustomEvent {}
};
vm.runInNewContext(i18nSource, context, { filename: "i18n.js" });
const i18n = context.window.MBBS_I18N;
assert(i18n, "i18n API must be exposed");

const dictionarySource = sourceSection(i18nSource, "const dictionary = {", "const messageDictionary = {");
const dictionaryKeyList = [...dictionarySource.matchAll(/^\s+"([^"]+)":/gm)].map((match) => match[1]);
const dictionaryKeys = new Set(dictionaryKeyList);
const usedKeys = new Set(
  frontendSources.flatMap((source) => [...source.matchAll(/\b(?:t|tf)\("([^"]+)"/g)].map((match) => match[1]))
);
const missingKeys = [...usedKeys].filter((key) => !dictionaryKeys.has(key));
assert.deepEqual(missingKeys, [], `missing Chinese dictionary keys: ${missingKeys.join(", ")}`);

const duplicateDriverKeys = unique(dictionaryKeyList.filter((key, index) =>
  (key.startsWith("driver.") || key === "app.driver")
  && dictionaryKeyList.indexOf(key) !== index
));
assert.deepEqual(duplicateDriverKeys, [], `duplicate Driver dictionary keys: ${duplicateDriverKeys.join(", ")}`);

// A present key is not sufficient: the Chinese branch must not silently fall
// back to its English label, and formatted translations must retain every
// named variable used by the caller.
const driverTranslationCalls = [...driverSource.matchAll(
  /\b(t|tf)\("([^"]+)",\s*"((?:[^"\\]|\\.)*)"/g
)].map((match) => ({
  helper: match[1],
  key: match[2],
  fallback: decodedJsString(match[3])
}));
const untranslatedDriverKeys = [];
const placeholderMismatches = [];
for (const call of driverTranslationCalls) {
  const translated = i18n.t(call.key, `__missing__${call.key}`);
  if (translated === `__missing__${call.key}` || translated === call.fallback) {
    untranslatedDriverKeys.push(call.key);
  }
  if (call.helper === "tf") {
    const fallbackVariables = unique([...call.fallback.matchAll(/\{([^}]+)\}/g)].map((match) => match[1])).sort();
    const translatedVariables = unique([...translated.matchAll(/\{([^}]+)\}/g)].map((match) => match[1])).sort();
    if (JSON.stringify(fallbackVariables) !== JSON.stringify(translatedVariables)) {
      placeholderMismatches.push(`${call.key}: ${fallbackVariables.join("/")} -> ${translatedVariables.join("/")}`);
    }
  }
}
assert.deepEqual(unique(untranslatedDriverKeys), [], `untranslated Driver UI keys: ${unique(untranslatedDriverKeys).join(", ")}`);
assert.deepEqual(placeholderMismatches, [], `Driver translation placeholder mismatch: ${placeholderMismatches.join(" | ")}`);

const literalPatterns = [
  /showToast\("([^"]+)"\)/g,
  /renderLogin\("([^"]+)"\)/g,
  /customerPickupMessage\s*=\s*"([^"]+)"/g,
  /fulfillmentStatusText\s*=\s*"([^"]+)"/g,
  /receiptStatusText\s*=\s*"([^"]+)"/g
];
const untranslatedMessages = [];
for (const source of frontendSources) {
  for (const pattern of literalPatterns) {
    for (const match of source.matchAll(pattern)) {
      const message = match[1];
      if (message && /[A-Za-z]/.test(message) && i18n.message(message) === message) untranslatedMessages.push(message);
    }
  }
}
assert.deepEqual([...new Set(untranslatedMessages)], [], `untranslated PWA messages: ${untranslatedMessages.join(" | ")}`);

assert(!operatorSource.includes('aria-label="Line list display mode"'), "line-density aria label must be translated");
assert(!operatorSource.includes('placeholder="SKU / item"'), "consolidation search placeholder must be translated");
assert(operatorSource.includes("localizeMessage(row.issue"), "consolidation warnings must use dynamic translation");
assert(frontendSources.every((source) => /function showToast\(message\)[\s\S]{0,180}localizeMessage\(message\)/.test(source)), "both PWA toasts must use dynamic translation");

// Raw text between HTML tags bypasses the language dictionary. This catches
// labels added to Driver template literals without coupling the test to a
// particular translation-key naming scheme.
const rawRenderedEnglish = [];
for (const match of driverSource.matchAll(/>([^<>{}$]*[A-Za-z][^<>{}$]*)</g)) {
  const text = match[1].replace(/\s+/g, " ").trim();
  if (!text || /[`?=]/.test(text)) continue;
  if (!/\b[A-Za-z]{2,}\b[\s,;:.'’“”!?·/&+-]+[A-Za-z]{2,}\b/.test(text)) continue;
  rawRenderedEnglish.push(text);
}
assert.deepEqual(
  unique(rawRenderedEnglish),
  [],
  `Driver rendered templates contain raw English: ${unique(rawRenderedEnglish).join(" | ")}`
);

const readinessSource = sourceSection(
  driverSource,
  "function driverActionProtectionState()",
  "function routeProtectedControlAttributes()"
);
const rawReadinessMessages = [...readinessSource.matchAll(/\bmessage:\s*"([^"]*[A-Za-z][^"]*)"/g)]
  .map((match) => match[1]);
assert.deepEqual(
  rawReadinessMessages,
  [],
  `Driver readiness warnings must be produced by t()/tf(): ${rawReadinessMessages.join(" | ")}`
);

// Status labels and temporary button copy are visible immediately. Require
// their assignment lines to pass through a translation helper instead of
// relying on a later rerender.
const rawVisibleAssignments = [];
for (const [index, line] of driverSource.split("\n").entries()) {
  if (!/(?:^\s*(?:(?:const|let|var)\s+)?(?:label|lastSyncText)\s*=|\.textContent\s*=)/.test(line)) continue;
  if (!/["`][^"`]*[A-Za-z]{2,}/.test(line)) continue;
  if (/\b(?:t|tf|localizeMessage)\(/.test(line)) continue;
  rawVisibleAssignments.push(`${index + 1}: ${line.trim()}`);
}
assert.deepEqual(
  rawVisibleAssignments,
  [],
  `Driver visible text assignments bypass localization: ${rawVisibleAssignments.join(" | ")}`
);

const offlineStatusSource = sourceSection(driverSource, "function renderOfflineStatus()", "async function refreshOfflineHealth()");
assert.match(
  offlineStatusSource,
  /localizeMessage\(lastError\)/,
  "Persisted/background synchronization errors must be translated when the offline panel renders."
);
const shellSource = sourceSection(driverSource, "function shell(content)", "function truckSwitchAttentionForJob(");
assert.match(
  shellSource,
  /localizeMessage\(switchWarning\.error/,
  "Samsara truck-switch warnings returned by the server must be translated."
);

function exactSurfacedErrors(source) {
  const messages = [];
  const patterns = [
    /\bnew Error\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g,
    /\bofflineRepairError\(\s*"((?:[^"\\]|\\.)*)"/g,
    /\breturn fail\(\s*"((?:[^"\\]|\\.)*)"/g
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) messages.push(decodedJsString(match[1]));
  }
  return messages.filter((message) => /[A-Za-z]{2,}/.test(message));
}

const surfacedOfflineErrors = unique(driverOfflineSources.flatMap(([, source]) => exactSurfacedErrors(source)));
const untranslatedOfflineErrors = surfacedOfflineErrors.filter((message) => i18n.message(message) === message);
assert.deepEqual(
  untranslatedOfflineErrors,
  [],
  `untranslated Driver offline/photo/sync errors: ${untranslatedOfflineErrors.join(" | ")}`
);

// Exercise parameterized branches which cannot be safely discovered as one
// quoted literal. These are the failures most likely to be shown during an
// offline launch and must remain covered when their counts/details change.
const representativeDriverWarnings = [
  "Offline storage upgrade is incomplete (missing events, photos). Close other Driver tabs and reload.",
  "Saving this stop on the device failed (QuotaExceededError): Device storage is full.",
  "Offline photo storage has reached 250 MB. Synchronize before taking more required photos.",
  "There are already 100 unsynchronized photos. Synchronize before taking more required photos.",
  "Offline photo storage has reached 250 MB. Synchronize before completing another photo-required action.",
  "There are already 100 unsynchronized photos. Synchronize before completing another photo-required action.",
  "1 saved photo is required before completing this action.",
  "3 saved photos are required before completing this action.",
  "The saved photo contains 12 of 30 bytes. Retake the photo or ask Dispatch to close the incomplete event as evidence only.",
  "Photo upload stored 12 of 30 registered bytes.",
  "1 photo could not be synchronized. Successful uploads were preserved and the remaining photo will be retried.",
  "3 photos could not be synchronized. Successful uploads were preserved and the remaining photos will be retried.",
  "Driver offline synchronization failed for 2 partitions.",
  "Route recheck failed: Network request failed.",
  "Duty-state action requires Dispatch review: route changed.",
  "Duty-state handoff remains Pending online: Samsara unavailable.",
  "DVIR requires Dispatch review: route changed.",
  "DVIR remains Pending online: Samsara unavailable.",
  "Could not load the update. Check internet, then close and reopen the PWA. Network request failed.",
  "Location was not checked while offline."
];
const untranslatedRepresentativeWarnings = representativeDriverWarnings.filter((message) => i18n.message(message) === message);
assert.deepEqual(
  untranslatedRepresentativeWarnings,
  [],
  `untranslated parameterized Driver warnings: ${untranslatedRepresentativeWarnings.join(" | ")}`
);

assert.match(driverHtml, /data-driver-sync-title/, "Driver sync hold must expose a localizable title target.");
assert.match(driverHtml, /data-driver-sync-message/, "Driver sync hold must expose a localizable message target.");
assert.match(
  driverSource,
  /data-driver-sync-title[\s\S]{0,300}t\(\s*"driver\.[^"]+",\s*"Syncing saved route"\s*\)/,
  "The quiet-sync title must be set from the active language before it is shown."
);
assert.match(
  driverSource,
  /data-driver-sync-message[\s\S]{0,400}t\(\s*"driver\.[^"]+",\s*"The PWA is syncing\. Please wait and keep this screen open\."\s*\)/,
  "The quiet-sync warning must be set from the active language before it is shown."
);

assert.equal(i18n.message("Expected stop address is missing."), "缺少预期停靠点地址。");
assert.equal(i18n.message("Truck location verified within 25 m."), "车辆位置已验证，距离在 25 米以内。");
assert.equal(i18n.message("3 photos are required."), "需要 3 张照片。");
assert.equal(i18n.format("operator.lineCount", "{count} line(s)", { count: 4 }), "4 行");

console.log(`PWA i18n harness passed (${usedKeys.size} UI keys checked).`);

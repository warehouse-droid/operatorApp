import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const publicUrl = new URL("../public/", import.meta.url);
const readPublic = (name) => fs.readFileSync(new URL(name, publicUrl), "utf8");
const i18nSource = readPublic("i18n.js");
const frontendSources = [readPublic("operator.js"), readPublic("driver.js")];

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

const dictionaryKeys = new Set(
  [...i18nSource.matchAll(/^\s+"([^"]+)":/gm)].map((match) => match[1])
);
const usedKeys = new Set(
  frontendSources.flatMap((source) => [...source.matchAll(/\b(?:t|tf)\("([^"]+)"/g)].map((match) => match[1]))
);
const missingKeys = [...usedKeys].filter((key) => !dictionaryKeys.has(key));
assert.deepEqual(missingKeys, [], `missing Chinese dictionary keys: ${missingKeys.join(", ")}`);

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

const operatorSource = frontendSources[0];
assert(!operatorSource.includes('aria-label="Line list display mode"'), "line-density aria label must be translated");
assert(!operatorSource.includes('placeholder="SKU / item"'), "consolidation search placeholder must be translated");
assert(operatorSource.includes("localizeMessage(row.issue"), "consolidation warnings must use dynamic translation");
assert(frontendSources.every((source) => /function showToast\(message\)[\s\S]{0,180}localizeMessage\(message\)/.test(source)), "both PWA toasts must use dynamic translation");

assert.equal(i18n.message("Expected stop address is missing."), "缺少预期停靠点地址。");
assert.equal(i18n.message("Truck location verified within 25 m."), "车辆位置已验证，距离在 25 米以内。");
assert.equal(i18n.message("3 photos are required."), "需要 3 张照片。");
assert.equal(i18n.format("operator.lineCount", "{count} line(s)", { count: 4 }), "4 行");

console.log(`PWA i18n harness passed (${usedKeys.size} UI keys checked).`);

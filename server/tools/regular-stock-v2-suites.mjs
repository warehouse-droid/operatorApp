import {readdirSync} from 'node:fs';
export const regularTests=['unit','integration','property'].flatMap(kind=>readdirSync(`test/mbt/${kind}`).filter(file=>/^regular-stock.*\.test\.js$/.test(file)).map(file=>`test/mbt/${kind}/${file}`));
export const neighbors=['src/smart-scm-harness.js','src/smart-scm-policy-calculation-harness.js','src/smart-scm-urgency-harness.js','src/smart-scm-planning-exclusion-harness.js','src/smart-scm-vendor-hold-split-harness.js','src/smart-scm-vendor-alternative-harness.js','src/smart-scm-purchase-review-harness.js'];

import base from '../eslint.mbt.config.js';
export default [{ ...base[0], files: ['test/mbt/e2e/pallet-one-page.test.js', 'test/mbt/integration/return-pallet-one-page.test.js', 'test/mbt/unit/return-pallet-yard-reference.test.js', 'tools/pallet-one-page-checks.mjs'],
  languageOptions: { ...base[0].languageOptions, globals: { ...base[0].languageOptions.globals, window: 'readonly', document: 'readonly', localStorage: 'readonly', getComputedStyle: 'readonly' } } }];

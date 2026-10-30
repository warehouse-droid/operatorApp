import base from '../eslint.mbt.config.js';
export default [{ ...base[0], files: ['src/return-netsuite.js', 'src/return-repository.js',
  'test-artifacts/pallet-return-search/baseline/**/*.js', 'test/mbt/integration/return-pallet-saved-search.test.js',
  'test/mbt/e2e/pallet-one-page.test.js', 'tools/pallet-return-search-*.mjs'],
languageOptions: { ...base[0].languageOptions, globals: { ...base[0].languageOptions.globals,
  window: 'readonly', document: 'readonly', localStorage: 'readonly', getComputedStyle: 'readonly' } } }];

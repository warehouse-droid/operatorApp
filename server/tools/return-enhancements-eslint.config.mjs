import base from '../eslint.mbt.config.js';
export default [{ ...base[0], files: ['src/return-accounting.js', 'src/return-automatic-notifications.js',
  'src/return-credit-memo.js', 'public/return-notifications.js',
  'test/mbt/**/return-enhancements*.test.js', 'tools/return-enhancements*.mjs'],
  languageOptions: { ...base[0].languageOptions, globals: { ...base[0].languageOptions.globals,
    window: 'readonly', document: 'readonly', getComputedStyle: 'readonly' } } }];

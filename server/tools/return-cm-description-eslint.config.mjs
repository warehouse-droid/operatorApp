import base from '../eslint.mbt.config.js';
export default [{ ...base[0], files: ['src/return-credit-memo-adjustment.js',
  'src/return-credit-memo.js', 'src/return-accounting.js',
  'test/mbt/**/return-cm-description.test.js', 'tools/return-cm-description*.mjs'] }];

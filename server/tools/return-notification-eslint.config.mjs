import base from '../eslint.mbt.config.js';
export default [{ ...base[0], files: ['src/return-notification-*.js', 'test/mbt/**/return-notification*.test.js',
  'tools/return-notification-*.mjs', 'public/return-notifications.js'],
  languageOptions: { ...base[0].languageOptions, globals: { ...base[0].languageOptions.globals, window: 'readonly' } } }];

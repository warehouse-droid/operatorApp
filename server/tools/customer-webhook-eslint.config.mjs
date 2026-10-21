import base from '../eslint.mbt.config.js';
const rules = base[0];
export default [
  { ...rules, files: ['src/netsuite-customer-webhook*.js', 'test/mbt/**/customer-webhook*.js', 'tools/customer-webhook*.mjs'] },
  { ...rules, files: ['netsuite-customer-webhook-user-event.js'], languageOptions: {
    ...rules.languageOptions, globals: { ...rules.languageOptions.globals, define: 'readonly' }
  } }
];

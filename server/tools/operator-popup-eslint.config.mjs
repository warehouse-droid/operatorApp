import config from '../eslint.mbt.config.js';
export default [
  { ...config[1], files: ['src/operator-popup-audit.js', 'public/operator-popup-audit.js'],
    languageOptions: { ...config[1].languageOptions, globals: { ...config[1].languageOptions.globals, window: 'readonly' } },
    rules: { ...config[1].rules, complexity: ['error', 15] } },
  { ...config[1], files: ['test/mbt/e2e/operator-delivery-popup.test.js', 'test/mbt/integration/operator-popup-audit.test.js',
    'test/mbt/unit/operator-popup-audit.test.js', 'tools/operator-popup-checks.mjs'],
    languageOptions: { ...config[1].languageOptions, globals: { ...config[1].languageOptions.globals,
      window: 'readonly', document: 'readonly', Event: 'readonly', localStorage: 'readonly', operator: 'readonly',
      deliveryNotificationStateReady: 'readonly', currentModule: 'readonly' } } }
];

import existing from '../eslint.mbt.config.js';
const common = existing[0];
export default [
  { ...common, files: ['test/mbt/integration/sales-monitor-map.test.js', 'test/support/sales-monitor-map-*.mjs', 'tools/sales-monitor-map-*.mjs'] },
  { ...common, files: ['test-artifacts/sales-monitor-guard.js'],
    languageOptions: { ...common.languageOptions, globals: { ...common.languageOptions.globals, operatorHasAnyRole: 'readonly', sendRoleForbidden: 'readonly' } },
    rules: { ...common.rules, curly: ['error', 'multi-line'] } }
];

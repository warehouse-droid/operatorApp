import base from './consolidation-load-eslint.config.mjs';
export default [...base, {
  files: ['src/netsuite.js', 'src/operator-netsuite-posting-targets.js', 'src/sales-order-auto-fulfillment-repository.js',
    'test/mbt/**/noninventory-fulfillment.test.js', 'tools/noninventory-fulfillment-*.mjs'],
  languageOptions: base[0].languageOptions,
  rules: { 'no-undef': 'error', 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'no-unreachable': 'error', eqeqeq: 'error', 'no-var': 'error' }
}];

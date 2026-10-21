import base from '../../eslint.mbt.config.js';
// Existing large modules retain their repository style; the focused check
// rejects undefined names, unreachable code and duplicate imports throughout.
export default [...base, {
  files: ['public/order-pack-quantities.js', 'public/special-stock-line-details.js', 'public/special-stock-line-fields.js',
    'src/special-stock-request-domain.js', 'src/special-stock-request-netsuite.js', 'src/netsuite.js',
    'src/special-stock-adjustment-adapter.js', 'src/special-stock-rest-orders.js', 'netsuite-*.js'],
  languageOptions: { ...base[0].languageOptions, globals: { ...base[0].languageOptions.globals, define: 'readonly' } },
  rules: { 'no-undef': 'error', 'no-unreachable': 'error', 'no-duplicate-imports': 'error' }
}];
